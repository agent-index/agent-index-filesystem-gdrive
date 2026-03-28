import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { URL } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import { drive as driveApi } from '@googleapis/drive';
import { oauth2 as oauth2Api } from '@googleapis/oauth2';
import {
  FileNotFoundError,
  PathNotFoundError,
  AccessDeniedError,
  NotAuthenticatedError,
  WriteConflictError,
  NotEmptyError,
  AuthFailedError,
  BackendError,
} from '@agent-index/filesystem/errors';

/**
 * Google Drive backend adapter for the AIFS MCP server.
 *
 * Google Drive is ID-based, not path-based, so the adapter maintains a path→ID
 * cache to map logical AIFS paths to Drive file/folder IDs. The cache is populated
 * lazily on first access and updated on writes.
 *
 * Connection config expected in agent-index.json:
 * {
 *   "client_id": "...",              // Google OAuth2 client ID
 *   "client_secret": "...",          // Google OAuth2 client secret
 *   "drive_id": "...",               // Shared drive ID (optional, for shared drives)
 *   "root_folder_id": "..."          // Root folder ID (optional — defaults to drive root)
 * }
 */
export class GoogleDriveAdapter {
  constructor() {
    this.connection = null;
    this.credentialPath = null;
    this.tokens = null;
    this.oauth2Client = null;
    this.drive = null;

    // Path cache: maps normalized logical path -> { id, mimeType }
    this.pathCache = new Map();

    // Temporary HTTP server for OAuth callback (started by startAuth,
    // shut down after code is captured or on timeout)
    this._callbackServer = null;
    this._capturedAuthCode = null;
  }

  /**
   * Initialize the adapter with connection config and credential store path.
   */
  async initialize(connection, credentialStore) {
    this.connection = connection;

    if (!connection.client_id) {
      throw new BackendError('Google Drive connection config missing "client_id"');
    }
    if (!connection.client_secret) {
      throw new BackendError('Google Drive connection config missing "client_secret"');
    }

    this.oauth2Client = new OAuth2Client(
      connection.client_id,
      connection.client_secret,
      'http://localhost:3939/callback'
    );

    this.credentialPath = join(credentialStore, 'gdrive.json');

    // Try to load stored credentials
    try {
      this.tokens = JSON.parse(await readFile(this.credentialPath, 'utf-8'));
      this.oauth2Client.setCredentials(this.tokens);
    } catch {
      // No stored credentials — member will authenticate
      this.tokens = null;
    }

    // Listen for automatic token refreshes so new tokens are always
    // persisted to disk. The google-auth-library OAuth2Client emits a
    // 'tokens' event whenever it silently refreshes the access token
    // using the stored refresh token. Without this listener, refreshed
    // tokens only live in memory and are lost on server restart.
    this.oauth2Client.on('tokens', async (newTokens) => {
      // The event may only contain the new access_token + expiry_date.
      // Merge with existing tokens to preserve the refresh_token.
      this.tokens = { ...this.tokens, ...newTokens };
      this.oauth2Client.setCredentials(this.tokens);
      try {
        await this._writeCredential(this.tokens);
      } catch (err) {
        // Log but don't throw — the operation that triggered the refresh
        // should still succeed even if we can't persist.
        console.error(`[aifs] Warning: could not persist refreshed tokens: ${err.message}`);
      }
    });

    this.drive = driveApi({ version: 'v3', auth: this.oauth2Client });

    // Seed path cache with root
    const rootId = connection.root_folder_id || (connection.drive_id ? null : 'root');
    if (rootId) {
      this.pathCache.set('/', { id: rootId, mimeType: 'application/vnd.google-apps.folder' });
    }
  }

  // ─── Auth ────────────────────────────────────────────────────────────

  async getAuthStatus() {
    const base = { backend: 'gdrive' };

    if (!this.tokens || !this.tokens.access_token) {
      return { authenticated: false, ...base, reason: 'no_credential' };
    }

    // Check if token is expired
    if (this.tokens.expiry_date && this.tokens.expiry_date < Date.now()) {
      if (this.tokens.refresh_token) {
        try {
          await this._refreshToken();
          return {
            authenticated: true,
            ...base,
            user_identity: await this._getUserEmail(),
            expires_at: new Date(this.tokens.expiry_date).toISOString(),
          };
        } catch {
          return { authenticated: false, ...base, reason: 'expired' };
        }
      }
      return { authenticated: false, ...base, reason: 'expired' };
    }

    return {
      authenticated: true,
      ...base,
      user_identity: await this._getUserEmail(),
      expires_at: this.tokens.expiry_date
        ? new Date(this.tokens.expiry_date).toISOString()
        : undefined,
    };
  }

  async startAuth() {
    const scopes = [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
    ];

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
    });

    // Reset any previously captured code
    this._capturedAuthCode = null;

    // Try to start a temporary HTTP server on port 3939 to capture the
    // OAuth callback automatically. If the port is unavailable, fall back
    // to manual code entry.
    let callbackServerRunning = false;
    try {
      await this._startCallbackServer();
      callbackServerRunning = true;
    } catch (err) {
      // Port unavailable or networking blocked — fall back gracefully
      console.error(`[aifs] Could not start callback server on port 3939: ${err.message}`);
    }

    if (callbackServerRunning) {
      return {
        status: 'awaiting_callback',
        auth_url: authUrl,
        message:
          'Open this URL in your browser and sign in with your Google account. ' +
          'After granting access, you\'ll see a success page and can return here. ' +
          'If the redirect page fails to load, copy the "code" parameter from the URL bar and paste it here.',
      };
    }

    return {
      status: 'awaiting_code',
      auth_url: authUrl,
      message:
        'Open this URL in your browser, sign in with your Google account, and grant access to Google Drive. ' +
        'After granting access, you\'ll be redirected to a page that may fail to load — this is expected. ' +
        'Copy everything after "code=" in the URL bar (up to the "&" if there is one) and paste it here.',
    };
  }

  async completeAuth(authCode) {
    // If no explicit code provided, check if the callback server captured one
    if (!authCode && this._capturedAuthCode) {
      authCode = this._capturedAuthCode;
      this._capturedAuthCode = null;
    }

    // Clean up the callback server if it's still running
    this._stopCallbackServer();

    if (!authCode) {
      throw new AuthFailedError('No authorization code provided');
    }

    try {
      const { tokens } = await this.oauth2Client.getToken(authCode);
      this.tokens = tokens;
      this.oauth2Client.setCredentials(tokens);

      await this._writeCredential(tokens);

      const email = await this._getUserEmail();
      return {
        status: 'authenticated',
        user_identity: email,
        message: `Successfully authenticated to Google Drive as ${email}.`,
      };
    } catch (err) {
      if (err instanceof AuthFailedError) throw err;

      // Detect expired or already-used authorization codes. Google returns
      // "invalid_grant" for both cases. This is the most common auth
      // failure — the user took too long or the code was already exchanged.
      const errMsg = err.message || '';
      const errBody = err.response?.data?.error || '';
      if (errMsg.includes('invalid_grant') || errBody === 'invalid_grant') {
        throw new AuthFailedError(
          'The authorization code has expired or was already used. ' +
          'Authorization codes are single-use and expire after a few minutes. ' +
          'Please run the authentication flow again to get a fresh code.',
          { retryable: true }
        );
      }

      // Detect redirect_uri mismatch — usually a configuration issue
      if (errMsg.includes('redirect_uri_mismatch') || errBody === 'redirect_uri_mismatch') {
        throw new AuthFailedError(
          'OAuth redirect URI mismatch. The redirect URI configured in Google Cloud Console ' +
          'must include "http://localhost:3939/callback". Check your OAuth client settings.',
          { retryable: false }
        );
      }

      throw new AuthFailedError(`OAuth token exchange failed: ${errMsg}`);
    }
  }

  // ─── OAuth Callback Server ──────────────────────────────────────────

  /**
   * Start a temporary HTTP server on port 3939 to capture the OAuth
   * callback. The server auto-shuts down after capturing a code or
   * after 5 minutes (whichever comes first).
   */
  _startCallbackServer() {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost:3939');

          if (url.pathname === '/callback') {
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`
                <html><body style="font-family: system-ui; max-width: 500px; margin: 80px auto; text-align: center;">
                  <h2>Authentication Failed</h2>
                  <p>Google returned an error: <strong>${error}</strong></p>
                  <p>Please go back to Cowork and try again.</p>
                </body></html>
              `);
            } else if (code) {
              this._capturedAuthCode = code;
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`
                <html><body style="font-family: system-ui; max-width: 500px; margin: 80px auto; text-align: center;">
                  <h2>Authentication Successful</h2>
                  <p>You can close this tab and return to Cowork.</p>
                  <p style="color: #666; font-size: 0.9em;">The authorization code has been captured automatically.</p>
                </body></html>
              `);

              // Shut down after a brief delay to let the response flush
              setTimeout(() => this._stopCallbackServer(), 500);
            } else {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('Missing authorization code in callback.');
            }
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal error');
        }
      });

      // Auto-shutdown after 5 minutes to avoid dangling servers
      const timeout = setTimeout(() => {
        this._stopCallbackServer();
      }, 5 * 60 * 1000);

      server.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      server.listen(3939, '127.0.0.1', () => {
        this._callbackServer = { server, timeout };
        resolve();
      });
    });
  }

  /**
   * Stop the callback server if it's running.
   */
  _stopCallbackServer() {
    if (this._callbackServer) {
      clearTimeout(this._callbackServer.timeout);
      this._callbackServer.server.close();
      this._callbackServer = null;
    }
  }

  // ─── File Operations ─────────────────────────────────────────────────

  async read(path) {
    this._ensureAuth();
    const fileId = await this._resolvePathToId(path);

    if (!fileId) {
      throw new FileNotFoundError(path);
    }

    try {
      const params = { fileId, alt: 'media' };
      // If on a shared drive, include supportsAllDrives
      if (this.connection.drive_id) {
        params.supportsAllDrives = true;
      }

      const res = await this._withAutoRefresh(() =>
        this.drive.files.get(params, { responseType: 'arraybuffer' })
      );
      const buffer = Buffer.from(res.data);

      // Try UTF-8; fall back to base64 for binary
      const text = buffer.toString('utf-8');
      if (text.includes('\0')) {
        return 'base64:' + buffer.toString('base64');
      }
      return text;
    } catch (err) {
      this._handleDriveError(err, path);
    }
  }

  async write(path, content) {
    this._ensureAuth();
    const normalized = this._normalizePath(path);
    const parentPath = this._parentPath(normalized);
    const fileName = this._fileName(normalized);

    // Ensure parent directory exists (create recursively if needed)
    const parentId = await this._ensureParentDirs(parentPath);

    // Determine body
    let body;
    let mimeType = 'text/plain';
    if (content.startsWith('base64:')) {
      body = Buffer.from(content.slice(7), 'base64');
      mimeType = 'application/octet-stream';
    } else {
      body = content;
    }

    // Check if the file already exists (overwrite)
    const existingId = await this._resolvePathToId(path);

    try {
      const driveParams = {};
      if (this.connection.drive_id) {
        driveParams.supportsAllDrives = true;
      }

      if (existingId) {
        // Update existing file
        const res = await this._withAutoRefresh(() =>
          this.drive.files.update({
            fileId: existingId,
            media: { mimeType, body },
            fields: 'id, mimeType',
            ...driveParams,
          })
        );

        this.pathCache.set(normalized, { id: res.data.id, mimeType: res.data.mimeType });
      } else {
        // Create new file
        const fileMetadata = {
          name: fileName,
          parents: [parentId],
        };
        if (this.connection.drive_id) {
          fileMetadata.driveId = this.connection.drive_id;
        }

        const res = await this._withAutoRefresh(() =>
          this.drive.files.create({
            requestBody: fileMetadata,
            media: { mimeType, body },
            fields: 'id, mimeType',
            ...driveParams,
          })
        );

        this.pathCache.set(normalized, { id: res.data.id, mimeType: res.data.mimeType });
      }
    } catch (err) {
      this._handleDriveError(err, path);
    }
  }

  async list(path, recursive = false) {
    this._ensureAuth();
    const folderId = await this._resolvePathToId(path);

    if (!folderId) {
      throw new PathNotFoundError(path);
    }

    try {
      const entries = [];
      let pageToken = null;

      const queryParams = {
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
        pageSize: 1000,
      };
      // If on a shared drive, include extra params
      if (this.connection.drive_id) {
        queryParams.supportsAllDrives = true;
        queryParams.includeItemsFromAllDrives = true;
        queryParams.corpora = 'drive';
        queryParams.driveId = this.connection.drive_id;
      }

      do {
        if (pageToken) {
          queryParams.pageToken = pageToken;
        }

        const res = await this._withAutoRefresh(() =>
          this.drive.files.list(queryParams)
        );

        for (const file of res.data.files || []) {
          const isDir = file.mimeType === 'application/vnd.google-apps.folder';
          const entry = {
            name: file.name,
            type: isDir ? 'directory' : 'file',
          };

          if (!isDir) {
            entry.size = parseInt(file.size || '0', 10);
            entry.modified = file.modifiedTime;
          }

          // Cache while listing
          const normalized = this._normalizePath(path);
          const entryPath = normalized === '/' ? `/${file.name}` : `${normalized}/${file.name}`;
          this.pathCache.set(entryPath, { id: file.id, mimeType: file.mimeType });

          entries.push(entry);

          // Recurse if requested
          if (recursive && isDir) {
            const subEntries = await this.list(entryPath, true);
            for (const sub of subEntries) {
              entries.push({
                ...sub,
                name: `${file.name}/${sub.name}`,
              });
            }
          }
        }

        pageToken = res.data.nextPageToken || null;
      } while (pageToken);

      return entries;
    } catch (err) {
      this._handleDriveError(err, path);
    }
  }

  async exists(path) {
    this._ensureAuth();

    try {
      const fileId = await this._resolvePathToId(path);
      if (!fileId) {
        return { exists: false };
      }

      const cached = this.pathCache.get(this._normalizePath(path));
      const isDir = cached && cached.mimeType === 'application/vnd.google-apps.folder';
      return { exists: true, type: isDir ? 'directory' : 'file' };
    } catch (err) {
      if (err instanceof FileNotFoundError || err instanceof PathNotFoundError) {
        return { exists: false };
      }
      throw err;
    }
  }

  async stat(path) {
    this._ensureAuth();
    const fileId = await this._resolvePathToId(path);

    if (!fileId) {
      throw new FileNotFoundError(path);
    }

    try {
      const params = {
        fileId,
        fields: 'size, modifiedTime, createdTime',
      };
      if (this.connection.drive_id) {
        params.supportsAllDrives = true;
      }

      const res = await this._withAutoRefresh(() =>
        this.drive.files.get(params)
      );

      return {
        size: parseInt(res.data.size || '0', 10),
        modified: res.data.modifiedTime,
        created: res.data.createdTime,
      };
    } catch (err) {
      this._handleDriveError(err, path);
    }
  }

  async delete(path) {
    this._ensureAuth();
    const fileId = await this._resolvePathToId(path);

    if (!fileId) {
      throw new FileNotFoundError(path);
    }

    // Check if it's a non-empty directory
    const cached = this.pathCache.get(this._normalizePath(path));
    if (cached && cached.mimeType === 'application/vnd.google-apps.folder') {
      const children = await this.list(path, false);
      if (children.length > 0) {
        throw new NotEmptyError(path);
      }
    }

    try {
      const params = { fileId };
      if (this.connection.drive_id) {
        params.supportsAllDrives = true;
      }

      await this._withAutoRefresh(() => this.drive.files.delete(params));
      this.pathCache.delete(this._normalizePath(path));
    } catch (err) {
      this._handleDriveError(err, path);
    }
  }

  async copy(source, destination) {
    this._ensureAuth();
    const sourceId = await this._resolvePathToId(source);

    if (!sourceId) {
      throw new FileNotFoundError(source);
    }

    const destParentPath = this._parentPath(this._normalizePath(destination));
    const destFileName = this._fileName(this._normalizePath(destination));

    const parentId = await this._resolvePathToId(destParentPath);
    if (!parentId) {
      throw new PathNotFoundError(destParentPath);
    }

    try {
      const params = {
        fileId: sourceId,
        requestBody: {
          name: destFileName,
          parents: [parentId],
        },
        fields: 'id, mimeType',
      };
      if (this.connection.drive_id) {
        params.supportsAllDrives = true;
      }

      const res = await this._withAutoRefresh(() =>
        this.drive.files.copy(params)
      );

      this.pathCache.set(this._normalizePath(destination), {
        id: res.data.id,
        mimeType: res.data.mimeType,
      });
    } catch (err) {
      this._handleDriveError(err, source);
    }
  }

  // ─── Path Resolution ────────────────────────────────────────────────

  /**
   * Resolve a logical AIFS path to a Google Drive file ID.
   *
   * Google Drive is ID-based, so we must walk the path from the root,
   * resolving each segment to a folder ID. Results are cached.
   */
  async _resolvePathToId(path) {
    const normalized = this._normalizePath(path);

    // Check cache
    const cached = this.pathCache.get(normalized);
    if (cached) {
      return cached.id;
    }

    // Walk from root
    const segments = normalized.split('/').filter(Boolean);
    let currentId = await this._getRootId();
    let currentPath = '/';

    for (const segment of segments) {
      const childPath = currentPath === '/' ? `/${segment}` : `${currentPath}/${segment}`;

      // Check cache for intermediate path
      const cachedChild = this.pathCache.get(childPath);
      if (cachedChild) {
        currentId = cachedChild.id;
        currentPath = childPath;
        continue;
      }

      // Query Drive for child with this name in the current folder
      const queryParams = {
        q: `'${currentId}' in parents and name = '${segment.replace(/'/g, "\\'")}' and trashed = false`,
        fields: 'files(id, name, mimeType)',
        pageSize: 1,
      };
      if (this.connection.drive_id) {
        queryParams.supportsAllDrives = true;
        queryParams.includeItemsFromAllDrives = true;
        queryParams.corpora = 'drive';
        queryParams.driveId = this.connection.drive_id;
      }

      const res = await this._withAutoRefresh(() =>
        this.drive.files.list(queryParams)
      );

      if (!res.data.files || res.data.files.length === 0) {
        return null; // Path does not exist
      }

      const file = res.data.files[0];
      this.pathCache.set(childPath, { id: file.id, mimeType: file.mimeType });
      currentId = file.id;
      currentPath = childPath;
    }

    return currentId;
  }

  /**
   * Get the root folder ID.
   */
  async _getRootId() {
    const cached = this.pathCache.get('/');
    if (cached) {
      return cached.id;
    }

    // If a specific root_folder_id was configured, use it
    if (this.connection.root_folder_id) {
      this.pathCache.set('/', {
        id: this.connection.root_folder_id,
        mimeType: 'application/vnd.google-apps.folder',
      });
      return this.connection.root_folder_id;
    }

    // If on a shared drive, resolve the drive's root folder
    if (this.connection.drive_id) {
      const params = {
        driveId: this.connection.drive_id,
        fields: 'id',
        supportsAllDrives: true,
      };
      const res = await this._withAutoRefresh(() =>
        this.drive.drives.get(params)
      );
      // The drive ID itself serves as the root parent for queries
      this.pathCache.set('/', {
        id: this.connection.drive_id,
        mimeType: 'application/vnd.google-apps.folder',
      });
      return this.connection.drive_id;
    }

    // Default: user's My Drive root
    this.pathCache.set('/', {
      id: 'root',
      mimeType: 'application/vnd.google-apps.folder',
    });
    return 'root';
  }

  /**
   * Ensure all parent directories exist, creating them as needed.
   * Returns the ID of the immediate parent folder.
   */
  async _ensureParentDirs(parentPath) {
    const normalized = this._normalizePath(parentPath);
    if (normalized === '/') {
      return this._getRootId();
    }

    // Try resolving the full path first
    const existingId = await this._resolvePathToId(parentPath);
    if (existingId) {
      return existingId;
    }

    // Walk and create missing segments
    const segments = normalized.split('/').filter(Boolean);
    let currentId = await this._getRootId();
    let currentPath = '/';

    for (const segment of segments) {
      const childPath = currentPath === '/' ? `/${segment}` : `${currentPath}/${segment}`;

      const cachedChild = this.pathCache.get(childPath);
      if (cachedChild) {
        currentId = cachedChild.id;
        currentPath = childPath;
        continue;
      }

      // Query for existing folder
      const queryParams = {
        q: `'${currentId}' in parents and name = '${segment.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name, mimeType)',
        pageSize: 1,
      };
      if (this.connection.drive_id) {
        queryParams.supportsAllDrives = true;
        queryParams.includeItemsFromAllDrives = true;
        queryParams.corpora = 'drive';
        queryParams.driveId = this.connection.drive_id;
      }

      const res = await this._withAutoRefresh(() =>
        this.drive.files.list(queryParams)
      );

      if (res.data.files && res.data.files.length > 0) {
        const folder = res.data.files[0];
        this.pathCache.set(childPath, { id: folder.id, mimeType: folder.mimeType });
        currentId = folder.id;
      } else {
        // Create the folder
        const createParams = {
          requestBody: {
            name: segment,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [currentId],
          },
          fields: 'id, mimeType',
        };
        if (this.connection.drive_id) {
          createParams.supportsAllDrives = true;
        }

        const created = await this._withAutoRefresh(() =>
          this.drive.files.create(createParams)
        );
        this.pathCache.set(childPath, { id: created.data.id, mimeType: created.data.mimeType });
        currentId = created.data.id;
      }

      currentPath = childPath;
    }

    return currentId;
  }

  // ─── Token Management ───────────────────────────────────────────────

  /**
   * Ensure we have credentials at all. Throws if no tokens are loaded.
   */
  _ensureAuth() {
    if (!this.tokens || !this.tokens.access_token) {
      throw new NotAuthenticatedError('no_credential');
    }
  }

  /**
   * Execute an async operation with automatic retry on 401 (token expired).
   *
   * The google-auth-library normally handles silent refresh, but in edge
   * cases (race conditions, clock skew, stale cached tokens) a 401 can
   * still slip through. This wrapper catches it, attempts a refresh, and
   * retries the operation exactly once.
   *
   * Usage:
   *   return this._withAutoRefresh(() => this.drive.files.get({...}));
   */
  async _withAutoRefresh(operation) {
    try {
      return await operation();
    } catch (err) {
      const status = err.code || err.response?.status;
      if (status === 401 && this.tokens?.refresh_token) {
        // Attempt a manual refresh and retry once
        try {
          await this._refreshToken();
          return await operation();
        } catch (retryErr) {
          // If the retry also fails, throw the retry error
          throw retryErr;
        }
      }
      throw err;
    }
  }

  /**
   * Refresh the access token using the stored refresh token.
   */
  async _refreshToken() {
    try {
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      this.tokens = credentials;
      this.oauth2Client.setCredentials(credentials);
      await this._writeCredential(credentials);
    } catch (err) {
      throw new NotAuthenticatedError(
        `Token refresh failed: ${err.message}`
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  _normalizePath(path) {
    let p = '/' + path.replace(/^\/+/, '').replace(/\/+$/, '');
    p = p.replace(/\/+/g, '/');
    if (p === '') p = '/';
    return p;
  }

  _parentPath(path) {
    const normalized = this._normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) return '/';
    return normalized.slice(0, lastSlash);
  }

  _fileName(path) {
    const normalized = this._normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return normalized.slice(lastSlash + 1);
  }

  async _getUserEmail() {
    try {
      const oauth2 = oauth2Api({ version: 'v2', auth: this.oauth2Client });
      const res = await oauth2.userinfo.get();
      return res.data.email || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async _writeCredential(tokens) {
    const dir = dirname(this.credentialPath);
    await mkdir(dir, { recursive: true });
    await writeFile(this.credentialPath, JSON.stringify(tokens, null, 2), 'utf-8');
  }

  /**
   * Translate Google Drive API errors to AIFS errors.
   */
  _handleDriveError(err, path) {
    const status = err.code || err.response?.status;

    switch (status) {
      case 401:
        throw new NotAuthenticatedError('expired');
      case 403:
        throw new AccessDeniedError(path);
      case 404:
        throw new FileNotFoundError(path);
      case 409:
        throw new WriteConflictError(path);
      default:
        throw new BackendError(
          `Google Drive API error (${status}): ${err.message}`,
          err
        );
    }
  }
}
