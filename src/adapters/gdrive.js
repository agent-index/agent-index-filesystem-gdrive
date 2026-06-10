import { readFile, writeFile, mkdir, open, readdir } from 'node:fs/promises';
import {
  writeFileSync as fsWriteFileSync,
  readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { URL } from 'node:url';

/**
 * How long (ms) before a lock file is considered stale and can be broken.
 * Protects against processes that crash while holding a lock.
 */
const LOCK_STALE_MS = 30_000;

/**
 * How long (ms) to wait between polls when waiting for an existing lock.
 */
const LOCK_POLL_MS = 100;

/**
 * Maximum time (ms) to wait for a lock before giving up.
 */
const LOCK_TIMEOUT_MS = 60_000;

// ─── Process-wide held-lock registry ──────────────────────────────────
//
// Tracks every lock file this process currently holds so that, if the
// process is terminated unexpectedly (SIGTERM, SIGINT, uncaught
// exception, beforeExit), we can synchronously mark all of them as
// released (overwrite with `{ released: true }`) instead of leaking
// active locks that block the next invocation.
//
// We overwrite instead of unlinking because sandbox environments
// (Cowork containers) block unlink with EPERM, but writing to files
// we created always works.
//
// This is module-level (not per-adapter) so a single set of handlers
// covers every adapter instance, and registration is guarded by
// _exitHandlersInstalled to make multiple `new GoogleDriveAdapter()`
// calls a no-op for handler setup.

const _heldLockFiles = new Set();
let _exitHandlersInstalled = false;

function _releaseAllHeldLocksSync() {
  const marker = JSON.stringify({ pid: process.pid, ts: Date.now(), released: true });
  for (const lockFile of _heldLockFiles) {
    try {
      // Overwrite with a "released" marker instead of deleting. In
      // sandboxed environments (Cowork containers) unlink fails with
      // EPERM, but writing to a file we created always works.
      fsWriteFileSync(lockFile, marker);
    } catch {
      // Best effort — file may already be gone.
    }
  }
  _heldLockFiles.clear();
}

function _installExitHandlers() {
  if (_exitHandlersInstalled) return;
  _exitHandlersInstalled = true;

  // Synchronous best-effort cleanup. We use the sync APIs deliberately
  // because async work in 'exit' / signal handlers is not awaited.
  const cleanup = () => _releaseAllHeldLocksSync();

  process.on('exit', cleanup);
  process.on('beforeExit', cleanup);

  // Re-raise the signal after cleanup so the process exits with the
  // conventional 128+signo code instead of 0. Listening for the signal
  // suppresses Node's default termination, so we have to do it ourselves.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    process.on(sig, () => {
      cleanup();
      // Detach our listener before re-raising so we don't loop.
      process.removeAllListeners(sig);
      try {
        process.kill(process.pid, sig);
      } catch {
        process.exit(1);
      }
    });
  }

  process.on('uncaughtException', (err) => {
    cleanup();
    // Match Node's default behavior: log + exit 1.
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

/**
 * Returns true if a process with the given PID is currently alive on
 * this machine. Uses the 0-signal kill trick: it performs the
 * permission/existence check without actually delivering a signal.
 *
 * Returns true on EPERM (process exists but we don't own it — still
 * means the lock isn't ours to break) and false on ESRCH (no such
 * process, safe to break).
 */
function _isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

import { OAuth2Client } from 'google-auth-library';
import { drive as driveApi } from '@googleapis/drive';
import { oauth2 as oauth2Api } from '@googleapis/oauth2';
import {
  AifsError,
  FileNotFoundError,
  PathNotFoundError,
  AccessDeniedError,
  NotAuthenticatedError,
  WriteConflictError,
  NotEmptyError,
  AuthFailedError,
  BackendError,
  RevisionConflictError,
  InvalidSubjectError,
  InvalidRoleError,
  InvalidRecipientError,
  InvalidScopeError,
  NotImplementedError,
} from '@agent-index/filesystem/errors';

// ─── Environment helpers ─────────────────────────────────────────────

/**
 * Detect whether we're running inside a sandboxed environment where the
 * host browser cannot reach our loopback (Cowork container, CI, remote
 * containers, etc.). The OAuth callback server is useless in those
 * environments because Google's redirect hits a different localhost
 * than the one we're listening on.
 *
 * Precedence:
 *   1. AIFS_SANDBOXED env var ("1"/"true" forces yes, "0"/"false" forces no)
 *   2. Presence of common container markers
 */
function _isSandboxedEnv() {
  const explicit = process.env.AIFS_SANDBOXED;
  if (explicit === '1' || /^true$/i.test(explicit || '')) return true;
  if (explicit === '0' || /^false$/i.test(explicit || '')) return false;
  if (process.env.COWORK === '1' || process.env.COWORK_SESSION) return true;
  if (process.env.CI === 'true' || process.env.CI === '1') return true;
  // Cowork mounts sessions under /sessions/... — used as a last resort marker
  if (process.cwd().startsWith('/sessions/')) return true;
  return false;
}

/**
 * Accept either a raw OAuth authorization code or a pasted callback URL
 * and return the bare code. If we can't find one, return undefined.
 *
 * This lets callers paste the entire URL from their browser address bar
 * (e.g. `http://localhost:3939/callback?code=4/0AX...&scope=...`) without
 * having to manually extract the `code` parameter themselves.
 */
function _extractAuthCode(input) {
  if (input == null) return undefined;
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  // If it's URL-shaped, pull the code param out.
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/callback')) {
    try {
      const u = new URL(trimmed, 'http://localhost');
      const code = u.searchParams.get('code');
      if (code) return code;
    } catch {
      // fall through to literal return
    }
  }
  // If it looks like `code=...&scope=...` without the URL prefix, handle that too.
  if (trimmed.includes('code=') && !trimmed.includes(' ')) {
    const match = trimmed.match(/[?&]?code=([^&\s]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return trimmed;
}

/**
 * Render a minimal HTML page for the OAuth callback flow. Kept plain
 * and small so it renders in any browser and any locale.
 */
function _authHtml(title, body) {
  return `<!doctype html><html><body style="font-family: system-ui; max-width: 500px; margin: 80px auto; text-align: center;">
<h2>${_escape(title)}</h2>
<p>${body}</p>
</body></html>`;
}

/** Minimal HTML entity escape for embedding untrusted text in a page. */
function _escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

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
// ─── Platform Reliability helpers (2.6.0) ─────────────────────────────
//
// File-integrity sentinel (standards.md § "File-integrity sentinel"):
// detect whether written text content carries an AIFS:FILE-END marker so
// the write path can verify the marker survived the upload (tail-loss
// detection at write time — FCI-1 / clicap classes).

export const AIFS_SENTINEL = 'AIFS:FILE-END';

/**
 * Returns the sentinel encoding kind ('md' | 'hash' | 'slash' | 'json')
 * if the content's last non-whitespace text is a recognized AIFS:FILE-END
 * encoding, else null. Binary ("base64:") content is never sentinel-checked.
 */
export function detectSentinel(content) {
  if (typeof content !== 'string' || content.length === 0) return null;
  if (content.startsWith('base64:')) return null;
  const tail = content.slice(-400).replace(/\s+$/, '');
  if (tail.endsWith(`<!-- ${AIFS_SENTINEL} -->`)) return 'md';
  if (tail.endsWith(`// ${AIFS_SENTINEL}`)) return 'slash';
  if (tail.endsWith(`# ${AIFS_SENTINEL}`)) return 'hash';
  // JSON: reserved final key — allow closing braces/brackets after it.
  if (/"_file_end"\s*:\s*"AIFS:FILE-END"\s*[}\]\s]*$/.test(tail)) return 'json';
  return null;
}

/** Sleep helper for retry backoff. */
export const aifsSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff schedule (ms) for unreliable-read retries (flakyread). */
export const READ_RETRY_BACKOFF_MS = [500, 1000, 2000];

export class GoogleDriveAdapter {
  constructor() {
    this.connection = null;
    this.credentialPath = null;
    this.tokens = null;
    this.oauth2Client = null;
    this.drive = null;

    // Path cache: maps normalized logical path -> { id, mimeType }
    this.pathCache = new Map();

    // Lazily-detected Shared Drive membership state. null = not yet probed;
    // true = user is a member of the configured Shared Drive (or no drive_id
    // is configured, which is the My Drive setup — trivially "member"); false
    // = user is NOT a Shared Drive member, so the access-control Phase 4
    // model applies (per-file shares + all-members group). Probed lazily by
    // _detectDriveMembership() on first need. Added in 2.4.1 to close bug
    // 20260522-8d20ea22 — the Drive API requires fundamentally different
    // files.list query shapes for members vs non-members.
    this._isDriveMember = null;

    // In-process folder creation locks: maps normalized path -> Promise<id>
    // Prevents parallel writes *within this process* from creating duplicate
    // folders. Fast path that avoids filesystem lock I/O when all writes
    // originate from the same adapter instance.
    this._folderLocks = new Map();

    // Local filesystem lock directory — set during initialize().
    // Cross-process lock files are created here to prevent duplicate folder
    // creation when multiple adapter instances (separate processes) race.
    this._lockDir = null;

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

    // Lock directory lives alongside credentials — shared across all
    // adapter instances on this machine.
    this._lockDir = join(credentialStore, 'locks');
    await mkdir(this._lockDir, { recursive: true });

    // Install process-wide exit handlers so locks acquired by *this*
    // process are released even if we're killed (SIGTERM from a Bash
    // timeout, etc.). Idempotent — multiple adapter instances share
    // one set of handlers.
    _installExitHandlers();

    // Sweep any locks left behind by dead processes (previous crashed
    // invocations, hung Node processes that got SIGTERM'd, etc.).
    // Non-fatal if it fails — the per-acquire staleness check still
    // runs as a backstop.
    await this._sweepDeadLocks();

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

    // If we're running in a sandboxed environment (Cowork container, CI, etc.)
    // the browser can't reach our loopback, so don't even try to start a
    // callback server. The only supported flow is paste-the-URL-back.
    if (_isSandboxedEnv()) {
      return {
        status: 'awaiting_code',
        auth_url: authUrl,
        message:
          'Open this URL in your browser and sign in with your Google account. ' +
          'After granting access, the page will try to redirect to localhost — that redirect will fail, ' +
          'which is expected. Copy the full URL from your browser\'s address bar (it starts with ' +
          '"http://localhost:3939/callback?code=...") and paste it back here.',
      };
    }

    // Developer-laptop path: try to start a loopback callback server.
    let callbackServerRunning = false;
    try {
      await this._startCallbackServer();
      callbackServerRunning = true;
    } catch (err) {
      console.error(`[aifs] Could not start callback server on port 3939: ${err.message}`);
    }

    if (callbackServerRunning) {
      return {
        status: 'awaiting_callback',
        auth_url: authUrl,
        message:
          'Open this URL in your browser and sign in with your Google account. ' +
          'After granting access, the browser will complete the handshake automatically. ' +
          'If the redirect fails, paste the full URL from your browser\'s address bar back here.',
      };
    }

    // Port was taken — fall back to paste-URL flow.
    return {
      status: 'awaiting_code',
      auth_url: authUrl,
      message:
        'Open this URL in your browser and sign in with your Google account. ' +
        'After granting access, copy the full URL from your browser\'s address bar ' +
        '(it starts with "http://localhost:3939/callback?code=...") and paste it back here.',
    };
  }

  async completeAuth(authCode) {
    // Accept either a raw code or a pasted callback URL. If we got a URL,
    // pull the `code` query param out of it so the caller doesn't have to.
    authCode = _extractAuthCode(authCode);

    // If still no code, check whether the callback server captured one
    // (developer-laptop flow).
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
   * callback AND exchange the code for tokens in-line. Only used on the
   * developer-laptop path; sandboxed environments use paste-the-URL instead.
   * The server auto-shuts down after a successful exchange or after 5
   * minutes, whichever comes first.
   */
  _startCallbackServer() {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost:3939');

          if (url.pathname !== '/callback') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
          }

          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(_authHtml('Authentication Failed',
              `Google returned an error: <strong>${_escape(error)}</strong>. ` +
              `Please return to your terminal and try again.`));
            return;
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing authorization code in callback.');
            return;
          }

          // Stash the code so completeAuth() can also pick it up if the
          // caller invokes it directly — but primarily we exchange here
          // so the "success" HTML is truthful.
          this._capturedAuthCode = code;
          try {
            await this.completeAuth(code);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(_authHtml('Authentication Successful',
              'Tokens have been saved. You can close this tab and return to your terminal.'));
          } catch (exchangeErr) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(_authHtml('Authentication Failed',
              `Token exchange failed: <strong>${_escape(exchangeErr.message || String(exchangeErr))}</strong>. ` +
              `Please return to your terminal and try again.`));
          } finally {
            // Shut down after a brief delay to let the response flush
            setTimeout(() => this._stopCallbackServer(), 500);
          }
        } catch (err) {
          try {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal error');
          } catch {
            // Response already ended
          }
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
    let fileId = await this._resolvePathToId(path);

    if (!fileId) {
      // flakyread (2.6.0, bug 20260609-8d20ea22-flakyread): the backend
      // intermittently returns NOT_FOUND for files that exist. Before
      // concluding the file is missing, drop any stale cache entry and
      // re-resolve once after a short delay. A genuinely missing file
      // costs one extra resolution; a transient miss is healed.
      this.pathCache.delete(this._normalizePath(path));
      await aifsSleep(300);
      fileId = await this._resolvePathToId(path);
      if (!fileId) {
        throw new FileNotFoundError(path);
      }
    }

    try {
      const params = { fileId, alt: 'media' };
      // If on a shared drive, include supportsAllDrives
      if (this.connection.drive_id) {
        params.supportsAllDrives = true;
      }

      const fetchBuffer = async () => {
        const res = await this._withAutoRefresh(() =>
          this.drive.files.get(params, { responseType: 'arraybuffer' })
        );
        return Buffer.from(res.data);
      };

      let buffer = await fetchBuffer();

      // flakyread (2.6.0): never return empty content for a file the
      // backend says is non-empty. Empty result -> stat-gate (metadata
      // size) -> bounded retries with backoff -> explicit error. A file
      // that is GENUINELY empty (size 0) returns immediately as before.
      if (buffer.length === 0) {
        const metaParams = { fileId, fields: 'size' };
        if (this.connection.drive_id) metaParams.supportsAllDrives = true;
        const meta = await this._withAutoRefresh(() =>
          this.drive.files.get(metaParams)
        );
        const declaredSize = Number(meta?.data?.size ?? 0);
        if (declaredSize > 0) {
          for (const delayMs of READ_RETRY_BACKOFF_MS) {
            await aifsSleep(delayMs);
            buffer = await fetchBuffer();
            if (buffer.length > 0) break;
          }
          if (buffer.length === 0) {
            throw new AifsError(
              'AIFS_READ_UNRELIABLE',
              `read: backend returned empty content for "${path}" but metadata reports ${declaredSize} bytes (retried ${READ_RETRY_BACKOFF_MS.length}x). Transient backend failure — retry the operation; do NOT treat this file as empty or truncated.`,
              { path, declared_size: declaredSize, retries: READ_RETRY_BACKOFF_MS.length }
            );
          }
        }
      }

      // Try UTF-8; fall back to base64 for binary
      const text = buffer.toString('utf-8');
      if (text.includes('\0')) {
        return 'base64:' + buffer.toString('base64');
      }
      return text;
    } catch (err) {
      if (err instanceof AifsError) throw err;
      this._handleDriveError(err, path);
    }
  }

  async write(path, content, options = {}) {
    this._ensureAuth();
    const normalized = this._normalizePath(path);
    const parentPath = this._parentPath(normalized);
    const fileName = this._fileName(normalized);

    // Ensure parent directory exists (create recursively if needed)
    const parentId = await this._ensureParentDirs(parentPath);

    // Determine MIME type. The request body itself is built per write
    // attempt by makeBody() below (2.6.0) — binary streams are one-shot,
    // so the sentinel-verification retry path must rebuild them.
    // bin5 (2.5.1): the googleapis multipart writer cannot handle a raw
    // Buffer (it calls part.body.pipe()); binary content is wrapped in a
    // Readable stream. Strings pass through as-is.
    const mimeType = content.startsWith('base64:')
      ? 'application/octet-stream'
      : 'text/plain';

    // Check if the file already exists (overwrite)
    const existingId = await this._resolvePathToId(path);

    // v2.0: revision-aware writes. When ifRevision is supplied, fetch the
    // file's current headRevisionId before writing; if it doesn't match,
    // throw RevisionConflictError. The caller is expected to re-read,
    // re-apply changes, and retry. If ifRevision is not supplied, get
    // the legacy unconditional-write behavior — fully backwards compatible.
    if (options.ifRevision && existingId) {
      const params = { fileId: existingId, fields: 'headRevisionId' };
      if (this.connection.drive_id) params.supportsAllDrives = true;
      try {
        const res = await this._withAutoRefresh(() =>
          this.drive.files.get(params)
        );
        const currentRevision = res?.data?.headRevisionId || null;
        if (currentRevision !== options.ifRevision) {
          throw new RevisionConflictError(path, options.ifRevision, currentRevision);
        }
      } catch (err) {
        if (err instanceof RevisionConflictError) throw err;
        this._handleDriveError(err, path);
      }
    }

    // Sentinel-aware write verification (2.6.0, standards.md § "File-
    // integrity sentinel"): if the text content carries an AIFS:FILE-END
    // marker, verify post-write that the marker survived the upload.
    // Catches tail loss at write time (FCI-1 mount truncation, capped
    // payloads) instead of corrupting the remote silently.
    const sentinelKind = detectSentinel(content);

    try {
      const driveParams = {};
      if (this.connection.drive_id) {
        driveParams.supportsAllDrives = true;
      }

      // body may be a one-shot stream (binary path); rebuild it per attempt.
      const makeBody = () =>
        content.startsWith('base64:')
          ? Readable.from(Buffer.from(content.slice(7), 'base64'))
          : content;

      const doWrite = async () => {
        let res;
        if (existingId) {
          // Update existing file
          res = await this._withAutoRefresh(() =>
            this.drive.files.update({
              fileId: existingId,
              media: { mimeType, body: makeBody() },
              fields: 'id, mimeType, headRevisionId',
              ...driveParams,
            })
          );
        } else if (this.pathCache.get(normalized)?.id) {
          // A prior attempt in this invocation created the file — update it.
          res = await this._withAutoRefresh(() =>
            this.drive.files.update({
              fileId: this.pathCache.get(normalized).id,
              media: { mimeType, body: makeBody() },
              fields: 'id, mimeType, headRevisionId',
              ...driveParams,
            })
          );
        } else {
          // Create new file
          const fileMetadata = {
            name: fileName,
            parents: [parentId],
          };
          if (this.connection.drive_id) {
            fileMetadata.driveId = this.connection.drive_id;
          }

          res = await this._withAutoRefresh(() =>
            this.drive.files.create({
              requestBody: fileMetadata,
              media: { mimeType, body: makeBody() },
              fields: 'id, mimeType, headRevisionId',
              ...driveParams,
            })
          );
        }
        this.pathCache.set(normalized, { id: res.data.id, mimeType: res.data.mimeType });
        return res;
      };

      let res = await doWrite();

      if (sentinelKind) {
        const verifyOnce = async () => {
          const vParams = { fileId: res.data.id, alt: 'media' };
          if (this.connection.drive_id) vParams.supportsAllDrives = true;
          const vRes = await this._withAutoRefresh(() =>
            this.drive.files.get(vParams, { responseType: 'arraybuffer' })
          );
          const readBack = Buffer.from(vRes.data).toString('utf-8');
          return detectSentinel(readBack) === sentinelKind;
        };

        let verified = await verifyOnce();
        if (!verified) {
          // One rewrite attempt, then fail loudly — never leave a
          // silently-truncated remote copy behind an OK result.
          res = await doWrite();
          verified = await verifyOnce();
          if (!verified) {
            throw new AifsError(
              'AIFS_WRITE_VERIFY_FAILED',
              `write: AIFS:FILE-END sentinel did not survive the upload of "${path}" (retried once). The remote copy is likely tail-truncated — do not trust it; re-write from the canonical source.`,
              { path, sentinel_kind: sentinelKind }
            );
          }
        }
      }

      // Return the new revision so callers in a read-modify-write cycle
      // can pass it as ifRevision on the next write. headRevisionId may
      // be undefined for newly-created Drive shortcuts and a few other
      // edge cases — those return null.
      return { revision: res?.data?.headRevisionId || null };
    } catch (err) {
      if (err instanceof AifsError) throw err;
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
      // If on a shared drive, include extra params.
      // 2.4.1: branches on Drive membership via _listParams(). 2.4.0 used
      // corpora: 'allDrives' + driveId which is API-rejected.
      if (this.connection.drive_id) {
        Object.assign(queryParams, await this._listParams());
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
    if (typeof path !== 'string' || !path) {
      throw new AifsError('INVALID_ARGS', 'exists: "path" must be a non-empty string', { path });
    }
    this._ensureAuth();

    try {
      const fileId = await this._resolvePathToId(path);
      if (!fileId) {
        return { exists: false };
      }

      // Verify the cached/resolved ID still points at a live file. Without
      // this check we'd return `exists: true` for stale cache entries
      // (file deleted via the Drive UI / another process / etc.) which is
      // worse than an honest `exists: false` — callers who delete based on
      // a false `true` get FILE_NOT_FOUND from Drive and waste cycles.
      const normalized = this._normalizePath(path);
      const cached = this.pathCache.get(normalized);
      try {
        const params = { fileId, fields: 'id, mimeType, trashed' };
        if (this.connection.drive_id) params.supportsAllDrives = true;
        const res = await this._withAutoRefresh(() => this.drive.files.get(params));
        if (res.data.trashed) {
          this.pathCache.delete(normalized);
          return { exists: false };
        }
        const isDir = res.data.mimeType === 'application/vnd.google-apps.folder';
        // Refresh the cache with the verified mimeType
        this.pathCache.set(normalized, { id: res.data.id, mimeType: res.data.mimeType });
        return { exists: true, type: isDir ? 'directory' : 'file' };
      } catch (verifyErr) {
        const status = verifyErr.code || verifyErr.response?.status;
        if (status === 404) {
          this.pathCache.delete(normalized);
          return { exists: false };
        }
        // Auth/network/etc — propagate. Fall back to cached mimeType for type
        // hint if the verify call failed for non-404 reasons we can't resolve.
        if (cached) {
          const isDir = cached.mimeType === 'application/vnd.google-apps.folder';
          return { exists: true, type: isDir ? 'directory' : 'file' };
        }
        throw verifyErr;
      }
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
        fields: 'size, modifiedTime, createdTime, headRevisionId',
      };
      if (this.connection.drive_id) {
        params.supportsAllDrives = true;
      }

      const res = await this._withAutoRefresh(() =>
        this.drive.files.get(params)
      );

      return {
        id: fileId,
        size: parseInt(res.data.size || '0', 10),
        modified: res.data.modifiedTime,
        created: res.data.createdTime,
        revision: res.data.headRevisionId || null,
      };
    } catch (err) {
      this._handleDriveError(err, path);
    }
  }

  async delete(path) {
    if (typeof path !== 'string' || !path) {
      throw new AifsError('INVALID_ARGS', 'delete: "path" must be a non-empty string', { path });
    }
    this._ensureAuth();
    const normalized = this._normalizePath(path);

    // Two-attempt resolve: if the cached ID is stale (file was deleted or
    // moved out-of-band via the Drive UI, another process, etc.), the
    // cached delete will return 404. We treat that as a cache invalidation
    // signal rather than a hard FILE_NOT_FOUND, drop the cached entry,
    // re-resolve from root, and try once more before giving up.
    const fileId = await this._resolvePathToId(path);
    if (!fileId) {
      throw new FileNotFoundError(path);
    }

    // Check if it's a non-empty directory
    const cached = this.pathCache.get(normalized);
    if (cached && cached.mimeType === 'application/vnd.google-apps.folder') {
      const children = await this.list(path, false);
      if (children.length > 0) {
        throw new NotEmptyError(path);
      }
    }

    const isSharedDrive = !!this.connection.drive_id;

    // Attempt permanent deletion first; fall back to trash if Drive
    // returns 404 on a shared drive (contributors can't permanently
    // delete — only organizers can — but everyone can trash).
    const driveRemove = async (id) => {
      const params = { fileId: id };
      if (isSharedDrive) params.supportsAllDrives = true;

      try {
        await this._withAutoRefresh(() => this.drive.files.delete(params));
        return;
      } catch (delErr) {
        const status = delErr.code || delErr.response?.status;
        // On shared drives, 404 from files.delete often means the caller
        // lacks organizer role — fall back to trashing the file instead.
        if (isSharedDrive && status === 404) {
          await this._withAutoRefresh(() =>
            this.drive.files.update({
              fileId: id,
              requestBody: { trashed: true },
              supportsAllDrives: true,
            })
          );
          return;
        }
        throw delErr;
      }
    };

    try {
      await driveRemove(fileId);
      this.pathCache.delete(normalized);
      return;
    } catch (err) {
      const status = err.code || err.response?.status;
      if (status !== 404) {
        this._handleDriveError(err, path);
        return;
      }
      // 404 from files.delete is ambiguous on Drive: it can mean either
      // (a) the cached ID is stale (file deleted/moved out-of-band via
      //     Drive UI, another process, etc.), OR
      // (b) the caller lacks permission to permanently-delete or trash
      //     the file. Drive returns 404 (not 403) for permission denials
      //     on this op, presumably to avoid leaking the file's existence.
      //     Common on shared drives where files are owned by the drive
      //     itself and only organizers/contentManagers can remove them.
      // Disambiguate by re-resolving the path: if Drive's files.list
      // (which _resolvePathToId uses) still returns a file at this path,
      // the file exists and the 404 was a permission signal. If the
      // re-resolve returns nothing, the file genuinely doesn't exist.
      // Closes bug 20260416-62a14c43.
      const denialDetail =
        'On shared drives, files are typically owned by the drive itself; ' +
        'removing them requires the organizer or contentManager role. Ask ' +
        'your Workspace admin to remove the file, or run this operation ' +
        'from an account with the necessary permissions.';
      if (cached) {
        this.pathCache.delete(normalized);
        const freshId = await this._resolvePathToId(path);
        if (!freshId) {
          // Re-resolve found nothing → file genuinely doesn't exist.
          throw new FileNotFoundError(path);
        }
        if (freshId === fileId) {
          // Same ID came back fresh — Drive's files.list confirmed the
          // file exists, so the 404 from files.delete was a permission
          // denial. Throw an accurate diagnostic instead of FILE_NOT_FOUND.
          throw new AccessDeniedError(path, 'delete or trash', denialDetail);
        }
        try {
          await driveRemove(freshId);
          this.pathCache.delete(normalized);
          return;
        } catch (retryErr) {
          this._handleDriveError(retryErr, path);
          return;
        }
      }
      // No cached entry was originally present. Disambiguate the same
      // way: if Drive's files.list finds the file, the 404 was a
      // permission denial; otherwise it's a genuine missing file.
      const freshId = await this._resolvePathToId(path);
      if (!freshId) {
        throw new FileNotFoundError(path);
      }
      throw new AccessDeniedError(path, 'delete or trash', denialDetail);
    }
  }

  async copy(source, destination) {
    if (typeof source !== 'string' || !source) {
      throw new AifsError('INVALID_ARGS', 'copy: "source" must be a non-empty string', { source });
    }
    if (typeof destination !== 'string' || !destination) {
      throw new AifsError('INVALID_ARGS', 'copy: "destination" must be a non-empty string', { destination });
    }
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

    // Anchored ("id:{folderId}/..."): resolve relative to a known folder ID,
    // walking downward only. The caller has access from the anchor down even if
    // they cannot enumerate the anchor's ancestors (bug 20260522-8d20ea22). The
    // drive-root non-member fallback below never fires here because currentId
    // starts at the anchor, not drive_id.
    let segments, currentId, currentPath;
    const anchorMatch = /^id:([^/]+)(?:\/(.*))?$/.exec(normalized);
    if (anchorMatch) {
      currentId = anchorMatch[1];
      currentPath = `id:${currentId}`;
      segments = anchorMatch[2] ? anchorMatch[2].split('/').filter(Boolean) : [];
      if (segments.length === 0) {
        this.pathCache.set(normalized, {
          id: currentId,
          mimeType: 'application/vnd.google-apps.folder',
        });
        return currentId;
      }
    } else {
      // Walk from root
      segments = normalized.split('/').filter(Boolean);
      currentId = await this._getRootId();
      currentPath = '/';
    }

    for (const segment of segments) {
      const childPath = currentPath === '/' ? `/${segment}` : `${currentPath}/${segment}`;

      // Check cache for intermediate path
      const cachedChild = this.pathCache.get(childPath);
      if (cachedChild) {
        currentId = cachedChild.id;
        currentPath = childPath;
        continue;
      }

      // Query Drive for child with this name in the current folder.
      // 2.4.1: corpora branches on Drive-membership via _listParams(). The
      // 2.4.0 combo (corpora: 'allDrives' + driveId) was rejected by the
      // Drive API ("driveId must be specified if and only if corpora is set
      // to drive").
      const baseParams = await this._listParams();
      const queryParams = {
        ...baseParams,
        q: `'${currentId}' in parents and name = '${segment.replace(/'/g, "\\'")}' and trashed = false`,
        fields: 'files(id, name, mimeType)',
        pageSize: 1,
      };

      const res = await this._withAutoRefresh(() =>
        this.drive.files.list(queryParams)
      );

      let file = res.data.files && res.data.files[0];

      // 2.4.1: drive-root fallback for non-Drive-members.
      // The "'driveId' in parents and name = 'X'" query returns 0 results
      // when the user is not a Shared Drive member, even if they have a
      // direct share on the named entry — because the user cannot enumerate
      // the Drive root itself. Fall back to a global name search with
      // corpora: 'allDrives', which DOES return entries the user has direct
      // access to. The fallback fires only at drive root and only for
      // non-members; subsequent path segments use the standard "in parents"
      // query (which works once the user has a direct share on the
      // resolved folder).
      if (!file && this.connection.drive_id && currentId === this.connection.drive_id) {
        const isMember = await this._detectDriveMembership();
        if (!isMember) {
          const fallbackRes = await this._withAutoRefresh(() =>
            this.drive.files.list({
              supportsAllDrives: true,
              includeItemsFromAllDrives: true,
              corpora: 'allDrives',
              q: `name = '${segment.replace(/'/g, "\\'")}' and trashed = false`,
              fields: 'files(id, name, mimeType, parents)',
              pageSize: 10,
            })
          );
          // db13 (2.5.1): disambiguate the global name search WITHOUT breaking the
          // common single-match case. The unconstrained query matches same-named folders
          // anywhere the user has access (e.g. /shared/{name}, strays in My Drive); picking
          // the first silently resolved the wrong folder (bug 20260606-62a14c43-230135-db13).
          // BUT a non-Drive-member's view of a directly-shared folder often OMITS the
          // (inaccessible) drive-root parent from `parents`, so we must NOT parent-filter a
          // single legitimate match away (regression: filtering-before-counting made the whole
          // /shared tree resolve to null for non-members — caught in 2.5.1 staging). So:
          // parent-matching is a TIE-BREAKER applied only when there is more than one candidate.
          const allFallback = fallbackRes.data.files || [];
          if (allFallback.length === 1) {
            // Single accessible match — use it as-is. No parent check (parent may be invisible).
            file = allFallback[0];
          } else if (allFallback.length > 1) {
            // Multiple same-named accessible folders — disambiguate by parent == drive root.
            const parentMatched = allFallback.filter(
              (f) => Array.isArray(f.parents) && f.parents.includes(currentId)
            );
            if (parentMatched.length === 1) {
              file = parentMatched[0];
            } else {
              // Zero or several share the expected parent (or parents aren't visible) —
              // FAIL LOUD with the candidate list rather than guessing.
              const candidates = allFallback
                .map((f) => `${f.id} (parent ${(f.parents || []).join(',') || 'n/a'})`)
                .join('; ');
              throw new Error(
                `[aifs] Ambiguous path segment '${segment}': ` +
                  `${allFallback.length} accessible folders named '${segment}', ` +
                  `${parentMatched.length} under the expected parent. ` +
                  `Candidates: ${candidates}. Resolve with an id:{folderId} anchor to disambiguate.`
              );
            }
          }
          // length 0 → file stays unset → not found.
        }
      }

      if (!file) {
        return null; // Path does not exist (or is not accessible)
      }
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

    // If on a shared drive, use the drive ID directly as the root parent.
    // Pre-2.4.0 this called drives.get(drive_id) for an accessibility check
    // before returning drive_id, but the call's result was unused and 404'd
    // for accounts without Shared Drive membership — blocking every non-admin
    // member's onboarding (bug 20260522-8d20ea22). The accessibility check
    // moves to the bootstrap reads in org-setup Phase 3, where it belongs
    // semantically: the adapter shouldn't gate on Drive-level membership when
    // the access model is per-file shares.
    if (this.connection.drive_id) {
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
   * Detect whether the authenticated user is a member of the configured Shared
   * Drive. Cached in-memory after first probe. Added in 2.4.1 to close bug
   * 20260522-8d20ea22 — the access-control Phase 4 redesign moved non-admin
   * members OFF Shared Drive membership and onto file-level grants via the
   * all-members group. The Drive API treats these very differently:
   *
   *   - corpora: 'drive' + driveId           → requires Shared Drive membership
   *   - corpora: 'user' / 'allDrives'        → does NOT accept driveId
   *
   * So the adapter must branch at every files.list site based on membership.
   * This method is the membership probe. Fail-open on 404 (the non-member
   * signal); rethrow on other errors.
   *
   * If no drive_id is configured (the My Drive setup), we treat the user as
   * a "member" of their own drive — same query shape works.
   */
  async _detectDriveMembership() {
    if (this._isDriveMember !== null) {
      return this._isDriveMember;
    }
    if (!this.connection.drive_id) {
      this._isDriveMember = true;
      return true;
    }
    try {
      await this._withAutoRefresh(() =>
        this.drive.drives.get({
          driveId: this.connection.drive_id,
          fields: 'id',
          supportsAllDrives: true,
        })
      );
      this._isDriveMember = true;
    } catch (e) {
      const code = e.code || e.response?.status;
      if (code === 404) {
        this._isDriveMember = false;
      } else {
        throw e;
      }
    }
    return this._isDriveMember;
  }

  /**
   * Build the right files.list query parameters for the current user. Closes
   * the 2.4.0 API constraint bug by branching on Drive membership:
   *
   *   - Member:     corpora: 'drive' + driveId
   *   - Non-member: corpora: 'user' (no driveId — API rejects driveId with
   *                 corpora other than 'drive')
   *
   * Both branches set supportsAllDrives + includeItemsFromAllDrives when a
   * driveId is configured, so files inside the Shared Drive surface in either
   * mode (subject to the user's actual access rights).
   */
  async _listParams() {
    const params = {};
    if (!this.connection.drive_id) {
      return params;
    }
    params.supportsAllDrives = true;
    params.includeItemsFromAllDrives = true;
    const isMember = await this._detectDriveMembership();
    if (isMember) {
      params.corpora = 'drive';
      params.driveId = this.connection.drive_id;
    } else {
      params.corpora = 'user';
    }
    return params;
  }

  /**
   * Ensure all parent directories exist, creating them as needed.
   * Returns the ID of the immediate parent folder.
   *
   * Two layers of locking prevent duplicate folder creation:
   *
   * 1. In-process lock (_folderLocks Map) — fast path for concurrent
   *    writes within the same adapter instance / Node process.
   *
   * 2. Local filesystem lock (_acquirePathLock / _releasePathLock) —
   *    cross-process safety for when multiple adapter instances (e.g.
   *    separate MCP server processes spawned by parallel callers) race
   *    to create the same directory tree on Google Drive.
   *
   * Google Drive allows multiple folders with the same name, so without
   * serialization, concurrent writes to /email-triage/file1.md and
   * /email-triage/file2.md would each independently create an
   * /email-triage/ folder.
   */
  async _ensureParentDirs(parentPath) {
    const normalized = this._normalizePath(parentPath);
    if (normalized === '/') {
      return this._getRootId();
    }

    // ── Layer 1: in-process lock ──
    // If another call in THIS process is already ensuring this path, await it.
    const existingLock = this._folderLocks.get(normalized);
    if (existingLock) {
      return existingLock;
    }

    // Create a lock promise for this path
    const lockPromise = this._ensureParentDirsWithFsLock(normalized);
    this._folderLocks.set(normalized, lockPromise);

    try {
      const result = await lockPromise;
      return result;
    } finally {
      this._folderLocks.delete(normalized);
    }
  }

  /**
   * Wraps _ensureParentDirsInner with a local filesystem lock so that
   * separate OS processes creating the same directory tree are serialized.
   */
  async _ensureParentDirsWithFsLock(normalized) {
    // Lock on each segment of the path, not just the leaf. This prevents
    // races on shared intermediate directories (e.g. two writes to
    // /idea/state/a/file1 and /idea/state/b/file2 both needing to
    // create /idea/state/).
    const segments = normalized.split('/').filter(Boolean);
    const lockPaths = [];

    // Acquire locks from root toward leaf — consistent ordering prevents deadlocks
    let buildPath = '';
    for (const segment of segments) {
      buildPath += `/${segment}`;
      const lockPath = await this._acquirePathLock(buildPath);
      lockPaths.push(lockPath);
    }

    try {
      return await this._ensureParentDirsInner(normalized);
    } finally {
      // Release in reverse order (leaf toward root)
      for (let i = lockPaths.length - 1; i >= 0; i--) {
        await this._releasePathLock(lockPaths[i]);
      }
    }
  }

  /**
   * Inner implementation of _ensureParentDirs — called under lock.
   */
  async _ensureParentDirsInner(normalized) {
    // Try resolving the full path first
    const existingId = await this._resolvePathToId(normalized);
    if (existingId) {
      return existingId;
    }

    // Walk and create missing segments (anchor-aware: "id:{folderId}/..." starts
    // at the anchor folder, not the drive root — bug 20260522-8d20ea22).
    let segments, currentId, currentPath;
    const anchorMatch = /^id:([^/]+)(?:\/(.*))?$/.exec(normalized);
    if (anchorMatch) {
      currentId = anchorMatch[1];
      currentPath = `id:${currentId}`;
      segments = anchorMatch[2] ? anchorMatch[2].split('/').filter(Boolean) : [];
    } else {
      segments = normalized.split('/').filter(Boolean);
      currentId = await this._getRootId();
      currentPath = '/';
    }

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
      // 2.4.1: branches on Drive membership via _listParams(). 2.4.0 used
      // corpora: 'allDrives' + driveId which is API-rejected.
      if (this.connection.drive_id) {
        Object.assign(queryParams, await this._listParams());
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

  // ─── Cross-process path locking ────────────────────────────────────────
  //
  // Uses the local filesystem as a shared mutex. Lock files are created
  // atomically with O_CREAT | O_EXCL on first acquisition. Release is
  // done by *overwriting* the file with a `{ released: true }` marker
  // instead of deleting it — this avoids EPERM failures in sandboxed
  // environments (Cowork containers) where unlink is blocked.
  //
  // Acquisition checks: if the lock file exists and is released, stale,
  // or held by a dead PID, we overwrite it with our own claim.
  //
  // Lock files contain PID, timestamp, and release status. They live
  // in _lockDir (e.g. .agent-index/credentials/locks/).

  /**
   * Convert a normalized AIFS path to a lock file path.
   * Uses a hash to avoid filesystem issues with long/nested paths.
   */
  _lockFilePath(normalizedPath) {
    const hash = createHash('sha256').update(normalizedPath).digest('hex').slice(0, 16);
    // Include a readable prefix for debuggability
    const safe = normalizedPath.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    return join(this._lockDir, `${safe}-${hash}.lock`);
  }

  /**
   * Acquire a cross-process lock for the given AIFS path.
   * Returns the lock file path (needed for release).
   *
   * Strategy:
   *   1. Try atomic O_CREAT|O_EXCL — wins if no lock file exists.
   *   2. If lock file exists, read it. If it's released, stale, or
   *      held by a dead PID, overwrite it with our own lock claim.
   *   3. Otherwise poll until it's released or we time out.
   *
   * In sandboxed environments (Cowork), unlink() fails with EPERM, so
   * the entire lock lifecycle uses overwrite-to-release instead of
   * delete-to-release. A lock file with `released: true` is treated
   * the same as no lock file.
   */
  async _acquirePathLock(normalizedPath) {
    const lockFile = this._lockFilePath(normalizedPath);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const lockContent = JSON.stringify({ pid: process.pid, ts: Date.now() });

      // ── Fast path: try atomic create ──────────────────────────────
      try {
        const fh = await open(lockFile, 'wx');
        await fh.writeFile(lockContent);
        await fh.close();
        _heldLockFiles.add(lockFile);
        return lockFile;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }

      // ── Lock file exists — read and evaluate ─────────────────────
      let breakable = false;
      try {
        const content = await readFile(lockFile, 'utf-8');
        const info = JSON.parse(content);

        // A lock is breakable if:
        //   (a) It was explicitly released (overwrite-based release).
        //   (b) Its holder PID is dead — process will never release.
        //   (c) Its timestamp is older than LOCK_STALE_MS — paranoid
        //       fallback for PID-recycled edge cases.
        if (info.released === true) {
          breakable = true;
        } else if (typeof info.pid === 'number' && !_isPidAlive(info.pid)) {
          breakable = true;
        } else if (Date.now() - info.ts > LOCK_STALE_MS) {
          breakable = true;
        }
      } catch {
        // Lock file disappeared (race) or unreadable — treat as
        // breakable so we retry the atomic create on the next loop.
        breakable = true;
      }

      if (breakable) {
        // Overwrite the lock file with our claim. This isn't atomic
        // against another process doing the same, but in the exec
        // model each invocation is a single short-lived process, so
        // true contention is vanishingly rare. The overwrite always
        // succeeds even in EPERM-sandbox environments because we can
        // write to existing files — we just can't unlink them.
        try {
          await writeFile(lockFile, lockContent);
          _heldLockFiles.add(lockFile);
          return lockFile;
        } catch {
          // Race: file was deleted between read and write. Loop back
          // and try the atomic create again.
          continue;
        }
      }

      // Lock is held by another live process — wait and retry
      await new Promise(r => setTimeout(r, LOCK_POLL_MS));
    }

    throw new BackendError(
      `Timed out waiting for folder lock on path: ${normalizedPath} (lockFile=${lockFile})`
    );
  }

  /**
   * Release a previously acquired lock by overwriting with a released
   * marker. We overwrite instead of unlinking because sandbox
   * environments (Cowork) block unlink with EPERM.
   */
  async _releasePathLock(lockFilePath) {
    _heldLockFiles.delete(lockFilePath);
    const marker = JSON.stringify({ pid: process.pid, ts: Date.now(), released: true });
    try {
      await writeFile(lockFilePath, marker);
    } catch {
      // File already gone or otherwise inaccessible — harmless.
    }
  }

  /**
   * Best-effort startup sweep: walks _lockDir and marks any stale or
   * dead-PID lock file as released. This catches the case where a
   * previous invocation was killed (SIGTERM from a Bash timeout, OOM,
   * etc.) before the exit handlers could run, leaving stale locks that
   * would otherwise block writes for 30s each.
   *
   * Uses overwrite (not unlink) so it works in sandbox environments
   * where unlink returns EPERM.
   *
   * Errors are swallowed — a failed sweep just means the per-call
   * staleness check has to do the work instead.
   */
  async _sweepDeadLocks() {
    if (!this._lockDir) return;
    let entries;
    try {
      entries = await readdir(this._lockDir);
    } catch {
      return;
    }
    const releasedMarker = JSON.stringify({ pid: process.pid, ts: Date.now(), released: true });
    for (const name of entries) {
      if (!name.endsWith('.lock')) continue;
      const lockFile = join(this._lockDir, name);
      try {
        const content = await readFile(lockFile, 'utf-8');
        const info = JSON.parse(content);

        // Skip already-released locks — nothing to do.
        if (info.released === true) continue;

        const pidDead = typeof info.pid !== 'number' || !_isPidAlive(info.pid);
        const tsStale = typeof info.ts !== 'number' || (Date.now() - info.ts) > LOCK_STALE_MS;
        if (pidDead || tsStale) {
          try {
            await writeFile(lockFile, releasedMarker);
          } catch {
            // Best effort.
          }
        }
      } catch {
        // Unreadable / malformed — assume stale and mark released.
        try {
          await writeFile(lockFile, releasedMarker);
        } catch {
          // ignore
        }
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  _normalizePath(path) {
    // Anchored path: "id:{folderId}[/rel/segments]" — resolve relative to a known
    // folder ID. Used for member-private space and items shared with the caller,
    // which a non-Drive-member cannot reach by walking from the drive root
    // (bug 20260522-8d20ea22). Preserve the anchor token; normalize only the
    // relative remainder; no leading slash.
    const anchor = /^id:([^/]+)(?:\/(.*))?$/.exec(path);
    if (anchor) {
      const id = anchor[1];
      const rel = (anchor[2] || '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')
        .replace(/\/+/g, '/');
      return rel ? `id:${id}/${rel}` : `id:${id}`;
    }
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
  // ─── Access control (v2.0+) ────────────────────────────────────────────

  /**
   * Map an AIFS role to the corresponding Drive permission role.
   *
   * AIFS roles: reader | commenter | writer
   * Drive roles: reader | commenter | writer | (organizer | fileOrganizer | owner)
   *
   * The AIFS contract intentionally does not expose Drive-specific elevated
   * roles like organizer; share() is for granting collaborator-level access.
   * Ownership changes go through transferOwnership().
   */
  _aifsRoleToDriveRole(aifsRole) {
    const map = {
      reader: 'reader',
      commenter: 'commenter',
      writer: 'writer',
    };
    if (!Object.prototype.hasOwnProperty.call(map, aifsRole)) {
      throw new InvalidRoleError(aifsRole);
    }
    return map[aifsRole];
  }

  /**
   * Map a subject string (email or group address) to a Drive permission type.
   *
   * Drive distinguishes "user" (individual email) from "group" (Google Group
   * email). Both are addressed by the `emailAddress` field; only the `type`
   * differs. We default to "user" — if Drive returns "User does not exist",
   * share() retries as type="group". This mirrors Drive UI's auto-detection.
   */
  _detectSubjectType(subject) {
    return 'user';
  }

  /**
   * Grant a subject a role at a path.
   *
   * Drive Permissions API: permissions.create with {emailAddress, role, type}.
   * Eventual consistency: Drive's permissions API can take seconds to fully
   * propagate. Callers that immediately try to act on a freshly-shared
   * resource should be prepared for transient ACCESS_DENIED on follow-up
   * reads — rerun with a small backoff.
   */
  async share(path, subject, role, options = {}) {
    this._ensureAuth();

    const driveRole = this._aifsRoleToDriveRole(role);
    let subjectType = this._detectSubjectType(subject);

    if (!subject || typeof subject !== 'string' || !subject.includes('@')) {
      throw new InvalidSubjectError(subject, 'must be an email or group address');
    }

    const fileId = await this._resolvePathToId(path);
    if (!fileId) {
      throw new PathNotFoundError(path);
    }

    // inherit:false handling (implemented in 2.3.0).
    //
    // When inherit:false is requested, the recipient should see ONLY this
    // resource — not anything inherited from the parent folder. The Drive-
    // canonical mechanism is files.update with inheritedPermissionsDisabled:
    // true on the file resource. Works on both Shared Drives and My Drive
    // (the documented "limited access" folder mechanism).
    //
    // Setting inheritedPermissionsDisabled requires organizer role on the
    // Shared Drive (or owner on My Drive). The applying user — whoever's
    // OAuth token is in effect — must have that role.
    //
    // Order: disable inheritance FIRST, then add the explicit grant. This
    // prevents any transient window where the recipient has broader
    // (inherited) access than intended.
    //
    // Pre-2.3.0 the option was accepted from callers but discarded with
    // `void options.inherit;`. The original adapter comment cited a Shared-
    // Drive-non-member assumption that doesn't hold when the recipient is
    // already a drive member (e.g., an all-members group). See bug
    // 20260519-8d20ea22-2 context and idea helper-spec-needs-inherit-
    // passthrough for the design history.
    if (options.inherit === false) {
      const updateParams = {
        fileId,
        requestBody: {
          inheritedPermissionsDisabled: true,
        },
      };
      if (this.connection.drive_id) {
        updateParams.supportsAllDrives = true;
      }
      try {
        await this._withAutoRefresh(() =>
          this.drive.files.update(updateParams)
        );
      } catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || '';
        const code = err?.code || err?.response?.status;
        // Most likely failure: caller lacks organizer role on the Shared
        // Drive (or owner on My Drive). Surface as a clean AccessDeniedError
        // BEFORE the explicit grant runs — we don't want an over-permissive
        // state where the grant is added but inheritance stays active.
        if (code === 403 || /permission|forbidden|insufficient/i.test(message)) {
          throw new AccessDeniedError(
            path,
            subject,
            'inherit:false requires organizer role on this Shared Drive (or owner on My Drive). ' +
            'The applying user does not have sufficient role to disable parent-folder inheritance. ' +
            'Either grant organizer role first, or apply this share without inherit:false (parent inheritance will then apply).'
          );
        }
        // Unexpected — let it bubble.
        throw err;
      }
    }

    const params = {
      fileId,
      requestBody: {
        type: subjectType,
        role: driveRole,
        emailAddress: subject,
      },
      // Don't send notification emails — agent-index sends its own
      // welcome/onboarding emails via invite-member; Drive's generic
      // "X shared a folder with you" mail would just add noise.
      sendNotificationEmail: false,
    };

    if (this.connection.drive_id) {
      params.supportsAllDrives = true;
    }

    let res;
    try {
      res = await this._withAutoRefresh(() =>
        this.drive.permissions.create(params)
      );
    } catch (err) {
      const message = err?.errors?.[0]?.message || err?.message || '';
      if (
        subjectType === 'user' &&
        /user does not exist|invalid argument/i.test(message)
      ) {
        params.requestBody.type = 'group';
        try {
          res = await this._withAutoRefresh(() =>
            this.drive.permissions.create(params)
          );
        } catch (groupErr) {
          this._handlePermissionError(groupErr, path, subject, role);
        }
      } else {
        this._handlePermissionError(err, path, subject, role);
      }
    }

    return {
      shared: true,
      permission_id: res?.data?.id ?? null,
      path,
      inherit_disabled: options.inherit === false,
    };
  }


  /**
   * Revoke a subject's access at a path.
   *
   * Drive's permissions.delete requires a permission_id, not an email.
   * So the flow is: list permissions on the file, find the one matching
   * the subject email, then delete by ID.
   *
   * Returns {unshared: true} if an explicit permission was removed, or
   * {unshared: false} if the subject had no explicit permission on this
   * exact resource (e.g., they only had inherited access). The latter
   * is not an error — per the SPEC, it's a soft outcome the caller can
   * choose how to surface.
   */
  async unshare(path, subject) {
    this._ensureAuth();

    if (!subject || typeof subject !== 'string') {
      throw new InvalidSubjectError(subject, 'must be an email or group address');
    }

    const fileId = await this._resolvePathToId(path);
    if (!fileId) {
      throw new PathNotFoundError(path);
    }

    const listParams = {
      fileId,
      fields: 'permissions(id,emailAddress,type,role)',
      pageSize: 100,
    };
    if (this.connection.drive_id) {
      listParams.supportsAllDrives = true;
    }

    let permissions;
    try {
      const res = await this._withAutoRefresh(() =>
        this.drive.permissions.list(listParams)
      );
      permissions = res?.data?.permissions || [];
    } catch (err) {
      this._handlePermissionError(err, path, subject, null);
    }

    const subjectLower = subject.toLowerCase();
    const match = permissions.find(
      (p) => (p.emailAddress || '').toLowerCase() === subjectLower
    );

    if (!match) {
      // No explicit permission for this subject. Soft outcome.
      return { unshared: false, path };
    }

    const deleteParams = { fileId, permissionId: match.id };
    if (this.connection.drive_id) {
      deleteParams.supportsAllDrives = true;
    }

    try {
      await this._withAutoRefresh(() =>
        this.drive.permissions.delete(deleteParams)
      );
    } catch (err) {
      this._handlePermissionError(err, path, subject, null);
    }

    return { unshared: true, path };
  }


  /**
   * Map a Drive role back to an AIFS role.
   *
   * Drive can return roles beyond what AIFS exposes (organizer, fileOrganizer,
   * owner). These are all "fully-privileged" roles with semantic differences
   * Drive cares about; AIFS treats them all as `writer` since the consumer
   * collections don't need finer detail. If a future use case needs the
   * Drive-native role exposed, we can add an optional `native_role` field
   * to the response without breaking the contract.
   */
  _driveRoleToAifsRole(driveRole) {
    const map = {
      owner: 'writer',
      organizer: 'writer',
      fileOrganizer: 'writer',
      writer: 'writer',
      commenter: 'commenter',
      reader: 'reader',
    };
    return map[driveRole] || 'reader';
  }

  /**
   * Reverse-lookup a Drive file ID to an AIFS path using the path cache.
   * Returns null if the ID isn't in the cache. Caller decides how to
   * present an unresolved inheritedFrom (we surface as `gdrive-id:<id>`
   * so callers can still distinguish vs. a null).
   */
  _idToPath(fileId) {
    if (!fileId) return null;
    for (const [path, entry] of this.pathCache) {
      if (entry?.id === fileId) return path;
    }
    return null;
  }

  /**
   * List current permissions at a path. Returns explicit grants and,
   * optionally, inherited grants from ancestors (Shared Drives only —
   * personal Drive doesn't surface inherited permissions in the API).
   */
  async getPermissions(path, options = {}) {
    this._ensureAuth();

    const includeInherited = options.includeInherited !== false; // default true

    const fileId = await this._resolvePathToId(path);
    if (!fileId) {
      throw new PathNotFoundError(path);
    }

    // Request the fields we need. permissionDetails is only populated on
    // Shared Drives but it's harmless to request on personal Drive.
    const baseParams = {
      fileId,
      fields: 'nextPageToken,permissions(id,emailAddress,type,role,permissionDetails)',
      pageSize: 100,
    };
    if (this.connection.drive_id) {
      baseParams.supportsAllDrives = true;
    }

    const all = [];
    let pageToken = undefined;
    try {
      do {
        const params = pageToken ? { ...baseParams, pageToken } : baseParams;
        const res = await this._withAutoRefresh(() =>
          this.drive.permissions.list(params)
        );
        const page = res?.data?.permissions || [];
        all.push(...page);
        pageToken = res?.data?.nextPageToken;
      } while (pageToken);
    } catch (err) {
      this._handlePermissionError(err, path, null, null);
    }

    const result = [];
    for (const p of all) {
      // Determine inheritance. permissionDetails is an array (one entry
      // per inheritance source); we use the first as the canonical source.
      const detail = (p.permissionDetails && p.permissionDetails[0]) || null;
      const isInherited = detail?.inherited === true;

      if (!includeInherited && isInherited) continue;

      let inheritedFrom = null;
      if (isInherited && detail?.inheritedFrom) {
        const resolved = this._idToPath(detail.inheritedFrom);
        inheritedFrom = resolved !== null ? resolved : `gdrive-id:${detail.inheritedFrom}`;
      }

      result.push({
        subject: p.emailAddress || (p.type === 'anyone' ? '*' : p.type),
        role: this._driveRoleToAifsRole(p.role),
        permission_id: p.id || null,
        inherited_from: inheritedFrom,
        granted_date: null, // Drive Permission resource has no creationTime
      });
    }

    return { permissions: result };
  }


  // ─── Search (v2.0+) ────────────────────────────────────────────────────

  /**
   * Permission-aware enumeration. Returns resources the caller has access
   * to under a given scope. Wraps Drive's files.list with a q= query.
   *
   * Drive's q= query language is much richer than what the AIFS contract
   * exposes — we deliberately stick to the minimal portable subset
   * (scope, type, name_contains) so consumer collections work the same
   * across backends (Drive, OneDrive, S3).
   *
   * Permission-awareness is automatic: Drive's files.list returns only
   * files the calling identity can see. There is nothing for the
   * adapter to do beyond translating the scope into a parents constraint.
   *
   * Truncation: if the first page returns max_results results AND
   * Drive returns a nextPageToken, we mark truncated:true. We do NOT
   * paginate — a truncated result is the caller's signal to narrow
   * the query (smaller scope, more specific name_contains).
   */
  async search(query) {
    this._ensureAuth();

    const scope = query?.scope;
    if (!scope || typeof scope !== 'string' || !scope.startsWith('/')) {
      throw new InvalidScopeError(scope, 'must be an absolute path string');
    }

    const type = query.type || 'any';
    if (!['folder', 'file', 'any'].includes(type)) {
      throw new InvalidScopeError(scope, `invalid type "${type}"`);
    }

    const nameContains = query.nameContains || query.name_contains || null;
    const maxResults = Math.min(query.maxResults || query.max_results || 100, 1000);

    // Resolve scope path to a parent folder ID. The empty/root scope "/"
    // means search the entire visible filesystem.
    let parentId = null;
    if (scope !== '/') {
      parentId = await this._resolvePathToId(scope);
      if (!parentId) {
        throw new InvalidScopeError(scope, 'scope path does not exist or is not visible');
      }
    }

    // Build the q= query.
    const qParts = [];
    if (parentId) {
      qParts.push(`'${parentId}' in parents`);
    }
    if (type === 'folder') {
      qParts.push(`mimeType = 'application/vnd.google-apps.folder'`);
    } else if (type === 'file') {
      qParts.push(`mimeType != 'application/vnd.google-apps.folder'`);
    }
    if (nameContains) {
      // Drive q= uses single-quote-doubled escapes
      const escaped = String(nameContains).replace(/'/g, "\\'");
      qParts.push(`name contains '${escaped}'`);
    }
    qParts.push(`trashed = false`);
    const q = qParts.join(' and ');

    const params = {
      q,
      fields: 'nextPageToken,files(id,name,mimeType,owners(emailAddress),modifiedTime,parents)',
      pageSize: maxResults,
    };
    // 2.4.1: branches on Drive membership via _listParams(). 2.4.0 used
    // corpora: 'allDrives' + driveId which is API-rejected.
    if (this.connection.drive_id) {
      Object.assign(params, await this._listParams());
    }

    let res;
    try {
      res = await this._withAutoRefresh(() =>
        this.drive.files.list(params)
      );
    } catch (err) {
      // For search, we use _handleDriveError because the failure modes
      // (auth, quota, malformed query) are file-op-shaped, not
      // permissions-shaped.
      this._handleDriveError(err, scope);
    }

    const files = res?.data?.files || [];
    const truncated = !!res?.data?.nextPageToken;

    const results = [];
    for (const f of files) {
      // Reconstruct path: prefer cache lookup; fall back to scope + name
      // when not in cache. Search results aren't critical-path for
      // path resolution so an approximate path is acceptable.
      let path = this._idToPath(f.id);
      if (!path) {
        path = scope === '/' ? `/${f.name}` : `${scope.replace(/\/$/, '')}/${f.name}`;
      }
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
      results.push({
        path,
        type: isFolder ? 'folder' : 'file',
        name: f.name,
        owner: f.owners?.[0]?.emailAddress || null,
        modified: f.modifiedTime || null,
      });
    }

    return { results, truncated };
  }


  /**
   * Transfer ownership of a path to a new owner.
   *
   * Optional operation per the SPEC. On Drive, the semantics differ
   * sharply between personal Drive and Shared Drive:
   *
   * - **Shared Drive:** ownership belongs to the org/drive itself, not
   *   to individual users. Per-file ownership transfer is not a
   *   meaningful operation. We return NOT_IMPLEMENTED with a clear
   *   message rather than pretending to do something. (For Shared
   *   Drive offboarding, the appropriate action is to remove the
   *   member from the drive at the Workspace level — agent-index
   *   doesn't manage that.)
   *
   * - **Personal Drive:** permissions.create with role='owner',
   *   type='user', and transferOwnership=true. Drive requires
   *   sendNotificationEmail=true for ownership transfers — the
   *   recipient must accept via email before the transfer
   *   completes. We return {transferred: true} once the request
   *   is initiated; the actual transfer is async.
   */
  async transferOwnership(path, newOwner) {
    this._ensureAuth();

    if (!newOwner || typeof newOwner !== 'string' || !newOwner.includes('@')) {
      throw new InvalidRecipientError(newOwner, 'must be an email address');
    }

    if (this.connection.drive_id) {
      // Shared Drive — ownership is the drive's, not the user's. The
      // op semantically doesn't apply, so we surface NOT_IMPLEMENTED
      // honestly rather than silently doing nothing.
      throw new NotImplementedError(
        'transferOwnership',
        'Shared Drive — ownership belongs to the drive, not individual users. Manage drive membership at the Workspace level instead.'
      );
    }

    const fileId = await this._resolvePathToId(path);
    if (!fileId) {
      throw new PathNotFoundError(path);
    }

    const params = {
      fileId,
      requestBody: {
        type: 'user',
        role: 'owner',
        emailAddress: newOwner,
      },
      transferOwnership: true,
      // Drive REQUIRES this to be true for ownership transfers — the
      // new owner has to accept the transfer via email. There is no
      // way around it in the Drive API, and silently not sending
      // would either fail or leave the transfer in a half-state.
      sendNotificationEmail: true,
    };

    try {
      await this._withAutoRefresh(() =>
        this.drive.permissions.create(params)
      );
    } catch (err) {
      const message = err?.errors?.[0]?.message || err?.message || '';
      const status = err.code || err.response?.status;

      // Drive returns specific errors for known constraints:
      //   - 400 + "consentRequiredForOwnershipTransfer" — caller hasn't
      //     accepted Drive's transfer ToS in their own account
      //   - 403 + "domainPolicy" — Workspace policy blocks transfer
      //     (e.g., recipient is in a different Workspace)
      //   - 400 + "ownershipTransferNotPermittedForFileType" — file
      //     type (shortcut, etc.) can't be transferred
      if (status === 403 && /domainPolicy|domain policy|outside.*workspace/i.test(message)) {
        throw new InvalidRecipientError(newOwner, 'recipient is outside the Workspace or blocked by Workspace policy');
      }
      if (status === 400 && /ownershipTransferNotPermitted|file type/i.test(message)) {
        throw new BackendError(
          `This file type does not support ownership transfer (${message})`,
          err
        );
      }
      // Generic permission error path otherwise.
      this._handlePermissionError(err, path, newOwner, 'owner');
    }

    return { transferred: true, path, new_owner: newOwner };
  }

  /**
   * Map Drive permissions API errors to typed AIFS errors. Permission
   * errors have richer semantics than file ops so they get their own
   * mapper rather than reusing _handleDriveError.
   */
  _handlePermissionError(err, path, subject, role) {
    const status = err.code || err.response?.status;
    const message = err?.errors?.[0]?.message || err?.message || '';

    switch (status) {
      case 401:
        throw new NotAuthenticatedError('expired');
      case 403:
        throw new AccessDeniedError(path, 'share');
      case 404:
        throw new PathNotFoundError(path);
      case 400:
        if (/email|address|user does not exist/i.test(message)) {
          throw new InvalidSubjectError(subject, message || 'rejected by Drive');
        }
        if (/role/i.test(message)) {
          throw new InvalidRoleError(role);
        }
        throw new BackendError(
          `Google Drive permissions API error (400): ${message || err.message}`,
          err
        );
      default:
        throw new BackendError(
          `Google Drive permissions API error (${status}): ${err.message}`,
          err
        );
    }
  }
}
