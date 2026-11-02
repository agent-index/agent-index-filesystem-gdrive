#!/usr/bin/env node

/**
 * aifs-exec — On-demand single-invocation executor for the AIFS filesystem.
 *
 * Instead of running a persistent MCP server that can crash between calls,
 * this script executes exactly one tool call per invocation and exits.
 * Claude calls it via bash:
 *
 *   node aifs-exec.bundle.js aifs_read '{"path":"/projects/foo/project.md"}'
 *
 * Caching strategy:
 *   - OAuth access tokens: cached to disk with expiry; most calls skip refresh
 *   - Path cache: persisted to disk between invocations so path→ID resolution
 *     carries across calls without re-walking the Drive tree
 *   - Adapter initialization: ~200ms cold start (read config + load credentials)
 *
 * This eliminates every failure mode of the server/bridge approach:
 *   - No long-running process to crash
 *   - No port conflicts
 *   - No health checks or process management
 *   - Individual call failures are immediate and visible
 */

import {
  initEnvironment,
  loadConfig,
  // CI-025 (shared library 2.3.0): org path resolution and session state.
  resolveOrgMap,
  canonicalizeArgs,
  touchesMappedPrefix,
  isProtectedOrgPath,
  missingSegments,
  needsOrgMap,
  IDEMPOTENT_TOOLS,
  readPendingAuth,
  writePendingAuth,
  clearPendingAuth,
  reusedAuthResponse,
  writeIdentity,
  readIdentity,
  bootstrapState,
} from '@agent-index/filesystem';
import {
  AifsError,
  FileNotFoundError,
  PathNotFoundError,
} from '@agent-index/filesystem/errors';
import { GoogleDriveAdapter } from './adapters/gdrive.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// ─── Output & path helpers ────────────────────────────────────────────

/**
 * Default-quiet: strip debug/internal fields from tool responses before
 * handing them back to the caller. Opt in to the raw response with
 * AIFS_VERBOSE=1 or the --verbose flag.
 */
const VERBOSE = process.env.AIFS_VERBOSE === '1' || process.argv.includes('--verbose');
const DEBUG_FIELDS = new Set(['debug', 'raw_response', '_trace', '_timing']);

function stripDebugFields(value) {
  if (VERBOSE || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripDebugFields);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (DEBUG_FIELDS.has(k)) continue;
    out[k] = stripDebugFields(v);
  }
  return out;
}

/**
 * Normalize logical AIFS paths so Windows callers don't trip on backslashes.
 * AIFS paths are always forward-slash / POSIX-style; we do NOT touch any
 * argument that doesn't look like a filesystem path.
 */
function normalizePathArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  for (const key of ['path', 'source', 'destination', 'scope']) {
    if (typeof out[key] === 'string') {
      out[key] = out[key].replace(/\\/g, '/');
    }
  }
  if (Array.isArray(out.entries)) {
    out.entries = out.entries.map((e) => (e && typeof e.path === 'string' ? { ...e, path: e.path.replace(/\\/g, '/') } : e));
  }
  if (Array.isArray(out.paths)) {
    out.paths = out.paths.map((p) => (typeof p === 'string' ? p.replace(/\\/g, '/') : p));
  }
  return out;
}

// ─── Path Cache Persistence ───────────────────────────────────────────

const PATH_CACHE_FILENAME = 'path-cache.json';
const PATH_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const PATH_CACHE_MAX_ENTRIES = 2000;
const PATH_CACHE_SCHEMA = 2; // 2.11.3: drive-scoped entries (crossorgpath)

/**
 * Load the persisted path cache from disk.
 * Returns a Map of normalized path → { id, mimeType }.
 */
async function loadPathCache(credentialStore, driveId) {
  const cachePath = join(credentialStore, PATH_CACHE_FILENAME);
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const data = JSON.parse(raw);

    // Check if cache is too old
    if (data.timestamp && (Date.now() - data.timestamp) > PATH_CACHE_MAX_AGE_MS) {
      return new Map();
    }

    // crossorgpath (2.11.3, finding 34): a cache written by an older adapter may
    // hold drive-root entries resolved into ANOTHER org's drive. Only trust a cache
    // that carries this schema and was written for this drive.
    if (data.schema !== PATH_CACHE_SCHEMA || (data.drive_id || null) !== (driveId || null)) {
      return new Map();
    }

    const map = new Map(Object.entries(data.entries || {}));
    // CI-025: remember when this cache was first written, so saving it again
    // doesn't keep pushing its 30-minute expiry forward for an active member.
    map._createdAt = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Persist the path cache to disk.
 * Prunes to MAX_ENTRIES if needed.
 */
async function savePathCache(credentialStore, pathCache, driveId, createdAt = Date.now()) {
  const cachePath = join(credentialStore, PATH_CACHE_FILENAME);
  const entries = {};
  let count = 0;

  for (const [key, value] of pathCache) {
    if (count >= PATH_CACHE_MAX_ENTRIES) break;
    entries[key] = value;
    count++;
  }

  const data = {
    schema: PATH_CACHE_SCHEMA,
    drive_id: driveId || null,
    timestamp: createdAt,
    entries,
  };

  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(data), 'utf-8');
  } catch {
    // Non-fatal — cache miss on next call, that's all
  }
}

// ─── Tool Routing ─────────────────────────────────────────────────────

/**
 * Validate that all named args are present on the input object. Throws
 * an INVALID_ARGS AifsError listing whichever fields are missing so the
 * caller sees a clear message instead of a downstream `Cannot read
 * properties of undefined` crash.
 *
 * `required` entries can be either a plain field name (must be defined
 * and non-null) or `[name, 'path']` to additionally enforce non-empty
 * string semantics for path-like fields. Content fields permit empty
 * strings because writing an empty file is a legal operation.
 */
function requireArgs(toolName, args, required) {
  const missing = [];
  for (const entry of required) {
    const [key, kind] = Array.isArray(entry) ? entry : [entry, null];
    const v = args[key];
    if (v === undefined || v === null) {
      missing.push(key);
      continue;
    }
    if (kind === 'path' && (typeof v !== 'string' || v === '')) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new AifsError(
      'INVALID_ARGS',
      `${toolName}: missing or empty required argument(s): ${missing.join(', ')}`,
      { tool: toolName, missing }
    );
  }
}

async function routeToolCall(adapter, toolName, args, ctx = {}) {
  switch (toolName) {
    case 'aifs_read':
      requireArgs(toolName, args, [['path', 'path']]);
      return adapter.read(args.path, { encoding: args.encoding });

    case 'aifs_write': {
      // content may arrive three ways (2.6.0 — closes bug 20260608-…-clicap;
      // the single-CLI-arg path caps payloads at ~128KB):
      //   1. `content` (string arg) — the classic path, fine for small writes
      //   2. `content_file` (local filesystem path) — the executor reads the
      //      raw payload bytes from that file; no CLI-arg size limit
      //   3. `content_stdin: true` — the executor reads the payload from stdin
      // With `encoding: "base64"`, content_file/stdin payloads are treated as
      // RAW BINARY and base64-encoded here; a `content` string is assumed to
      // already be base64 text (unchanged from 2.5.x).
      requireArgs(toolName, args, [['path', 'path']]);
      let content = args.content;
      if (content === undefined || content === null) {
        if (typeof args.content_file === 'string' && args.content_file.length > 0) {
          const payload = await readFile(args.content_file);
          content = args.encoding === 'base64'
            ? payload.toString('base64')
            : payload.toString('utf-8');
        } else if (args.content_stdin === true) {
          const chunks = [];
          for await (const chunk of process.stdin) chunks.push(chunk);
          const payload = Buffer.concat(chunks);
          content = args.encoding === 'base64'
            ? payload.toString('base64')
            : payload.toString('utf-8');
        } else {
          requireArgs(toolName, args, ['content']); // canonical missing-arg error
        }
      }

      // Honour the optional `encoding` field. When encoding is "base64",
      // prepend the "base64:" sentinel that the adapter's write() method
      // looks for so the payload is decoded to binary bytes before upload.
      // Without this, base64 text gets stored as-is and the resulting
      // Drive file is an ASCII blob instead of the intended binary.
      if (args.encoding === 'base64' && !content.startsWith('base64:')) {
        content = 'base64:' + content;
      }

      // v2.0: pass through if_revision for safe concurrent edits to
      // shared state files. When supplied, the adapter rejects the
      // write with REVISION_CONFLICT if the file's current revision
      // differs — caller re-reads, re-applies, and retries.
      const writeOptions = {};
      if (typeof args.if_revision === 'string' && args.if_revision.length > 0) {
        writeOptions.ifRevision = args.if_revision;
      }

      const res = await adapter.write(args.path, content, writeOptions);
      return { success: true, path: args.path, revision: res?.revision ?? null };
    }

    case 'aifs_list': {
      requireArgs(toolName, args, [['path', 'path']]);
      const entries = await adapter.list(args.path, args.recursive ?? false);
      return { entries };
    }

    case 'aifs_exists':
      requireArgs(toolName, args, [['path', 'path']]);
      return adapter.exists(args.path);

    case 'aifs_stat':
      requireArgs(toolName, args, [['path', 'path']]);
      return adapter.stat(args.path);

    case 'aifs_delete': {
      requireArgs(toolName, args, [['path', 'path']]);
      await adapter.delete(args.path);
      return { success: true };
    }

    case 'aifs_copy': {
      requireArgs(toolName, args, [['source', 'path'], ['destination', 'path']]);
      await adapter.copy(args.source, args.destination);
      return { success: true };
    }

    case 'aifs_auth_status': {
      // CI-025 (§5): also report the bootstrap state, from local files only,
      // so a session whose start hook didn't fire can learn it from its first call.
      const status = await adapter.getAuthStatus();
      let email = status?.user_identity && status.user_identity !== 'unknown' ? status.user_identity : null;
      if (email && ctx.credentialStore) await writeIdentity(ctx.credentialStore, email);
      if (!email && ctx.credentialStore) email = await readIdentity(ctx.credentialStore);
      const b = bootstrapState({ configPath: process.env.AIFS_CONFIG_PATH, authenticated: !!status?.authenticated, email });
      return {
        ...status,
        bootstrap: b.bootstrap,
        ...(b.member_hash ? { member_hash: b.member_hash } : {}),
        ...(b.reason ? { bootstrap_reason: b.reason } : {}),
      };
    }

    case 'aifs_authenticate': {
      // pkcerestart (bug 20260615-8d20ea22-pkcerestart) + memberauthbootstrap
      // (bug 20260701-8d20ea22-memberauthbootstrap): if the caller passes an
      // auth_code but omits action:"complete", infer complete. Defaulting to
      // "start" silently re-ran the flow and ignored the code — so a driver that
      // didn't already know the exact action:"complete" contract could never
      // finish, which blocked a live member onboarding. onedrive has inferred
      // this since the pkcerestart fix; this ports the same guard to gdrive.
      const action = args.action || (args.auth_code ? 'complete' : 'start');
      if (action === 'start') {
        // CI-025 (§4): a second start returns the sign-in already in progress
        // (under 10 minutes old) instead of a new link, unless force:true.
        if (!args.force && ctx.credentialStore) {
          const pending = await readPendingAuth(ctx.credentialStore);
          if (pending) return reusedAuthResponse(pending);
        }
        const started = await adapter.startAuth();
        if (ctx.credentialStore && started?.auth_url) await writePendingAuth(ctx.credentialStore, started);
        return started;
      } else if (action === 'complete') {
        const done = await adapter.completeAuth(args.auth_code);
        if (ctx.credentialStore) {
          await clearPendingAuth(ctx.credentialStore);
          if (done?.user_identity) await writeIdentity(ctx.credentialStore, done.user_identity);
        }
        return done;
      }
      throw new AifsError('INVALID_ARGS', `Unknown auth action: ${action}`, {
        tool: toolName,
        valid_actions: ['start', 'complete'],
      });
    }


    // ─── v2.0 access-control ops (incremental rollout) ──────────────

    case 'aifs_share': {
      requireArgs(toolName, args, [['path', 'path'], 'subject', 'role']);
      const options = {};
      if (Object.prototype.hasOwnProperty.call(args, 'inherit')) {
        options.inherit = args.inherit;
      }
      return adapter.share(args.path, args.subject, args.role, options);
    }

    case 'aifs_unshare': {
      requireArgs(toolName, args, [['path', 'path'], 'subject']);
      return adapter.unshare(args.path, args.subject);
    }

    case 'aifs_get_permissions': {
      requireArgs(toolName, args, [['path', 'path']]);
      const options = {};
      if (Object.prototype.hasOwnProperty.call(args, 'include_inherited')) {
        options.includeInherited = args.include_inherited;
      }
      return adapter.getPermissions(args.path, options);
    }

    case 'aifs_search': {
      requireArgs(toolName, args, ['scope']);
      return adapter.search({
        scope: args.scope,
        type: args.type,
        nameContains: args.name_contains,
        maxResults: args.max_results,
      });
    }

    case 'aifs_transfer_ownership': {
      requireArgs(toolName, args, [['path', 'path'], 'new_owner']);
      return adapter.transferOwnership(args.path, args.new_owner);
    }

    // ─── Batch ops (bulkuploadserial) — many files in ONE process ──────
    case 'aifs_write_batch': {
      requireArgs(toolName, args, ['entries']);
      if (!Array.isArray(args.entries) || args.entries.length === 0) {
        throw new AifsError('INVALID_ARGS', `${toolName}: 'entries' must be a non-empty array of {path, content|content_file}`, { tool: toolName });
      }
      // Resolve each entry's content one of two ways: an inline `content`
      // string or a `content_file` local path, either optionally base64
      // (`encoding`). Unlike aifs_write, entries do not accept
      // `content_stdin`: stdin is one stream and cannot carry many entries.
      const resolved = [];
      for (let i = 0; i < args.entries.length; i++) {
        const e = args.entries[i];
        if (!e || typeof e.path !== 'string' || e.path === '') {
          throw new AifsError('INVALID_ARGS', `${toolName}: entries[${i}] is missing a 'path'`, { tool: toolName, index: i });
        }
        let content = e.content;
        if (content === undefined || content === null) {
          if (typeof e.content_file === 'string' && e.content_file.length > 0) {
            const payload = await readFile(e.content_file);
            content = e.encoding === 'base64' ? payload.toString('base64') : payload.toString('utf-8');
          } else {
            throw new AifsError('INVALID_ARGS', `${toolName}: entries[${i}] ('${e.path}') has neither 'content' nor 'content_file'`, { tool: toolName, index: i });
          }
        }
        if (e.encoding === 'base64' && !content.startsWith('base64:')) content = 'base64:' + content;
        resolved.push({ path: e.path.replace(/\\/g, '/'), content });
      }
      return adapter.writeBatch(resolved);
    }

    case 'aifs_stat_batch': {
      requireArgs(toolName, args, ['paths']);
      if (!Array.isArray(args.paths) || args.paths.length === 0) {
        throw new AifsError('INVALID_ARGS', `${toolName}: 'paths' must be a non-empty array`, { tool: toolName });
      }
      const paths = args.paths.map(p => (typeof p === 'string' ? p.replace(/\\/g, '/') : p));
      return adapter.statBatch(paths);
    }

    default:
      throw new AifsError('UNKNOWN_TOOL', `Unknown tool: ${toolName}`, { tool: toolName });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Usage: aifs-exec.mjs <tool_name> [json_args]
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(JSON.stringify({
      usage: 'aifs-exec <tool_name> [json_args]',
      tools: [
        'aifs_read', 'aifs_write', 'aifs_list', 'aifs_exists',
        'aifs_stat', 'aifs_delete', 'aifs_copy',
        'aifs_auth_status', 'aifs_authenticate',
        // v2.0 ops (incremental rollout)
        'aifs_share',
        'aifs_unshare',
        'aifs_get_permissions',
        'aifs_search',
        'aifs_transfer_ownership',
        // batch ops (bulkuploadserial)
        'aifs_write_batch',
        'aifs_stat_batch',
      ],
      // Argument signatures, kept in step with routeToolCall above.
      // "?" = optional. Unknown arguments are ignored without an error.
      arguments: {
        aifs_read: '{path}',
        aifs_write: '{path, content | content_file | content_stdin, encoding?, if_revision?}',
        aifs_list: '{path, recursive?}',
        aifs_exists: '{path}',
        aifs_stat: '{path}',
        aifs_delete: '{path}',
        aifs_copy: '{source, destination}',
        aifs_auth_status: '{}',
        aifs_authenticate: '{action?: "start"|"complete", auth_code?, force?}',
        aifs_share: '{path, subject, role, inherit?}',
        aifs_unshare: '{path, subject}',
        aifs_get_permissions: '{path, include_inherited?}',
        aifs_search: '{scope, name_contains?, type?: "file"|"folder"|"any", max_results?}',
        aifs_transfer_ownership: '{path, new_owner}',
        aifs_write_batch: '{entries: [{path, content | content_file, encoding?}]}',
        aifs_stat_batch: '{paths: [...]}',
      },
      notes: [
        'aifs_write: give exactly one of content, content_file, content_stdin. Inline content is bounded by the OS argument limit (~128 KiB); content_file and content_stdin have no size limit. If more than one is given, content wins, then content_file, then content_stdin.',
        'encoding "base64": a content_file/content_stdin payload is taken as raw bytes (use for binary files; otherwise it is read as UTF-8). An inline content string must itself be base64.',
        'if_revision: revision from aifs_stat; the write fails with REVISION_CONFLICT if the file has changed since.',
        'aifs_search: without name_contains nothing is filtered — an arbitrary, unordered page of up to max_results (default 100, max 1000) items under scope.',
        'Org locations are addressed by plain path on every backend: /org-config.json, /members-registry.json, /shared/..., /{collection}/... The executor finds them from org-config (2.12.0). id: addresses still work and pass through unchanged.',
        'aifs_authenticate start: returns the sign-in already in progress (under 10 minutes old) instead of a new link; pass force:true to start over.',
        'aifs_auth_status: includes bootstrap (ready | needs_auth | needs_setup) and member_hash, from local state.',
        'aifs_delete refuses an org root itself (the shared root, a collection folder, org-config, the registry): PROTECTED_ORG_PATH.',
      ],
      examples: [
        'aifs-exec aifs_read \'{"path":"/projects/foo/project.md"}\'',
        'aifs-exec aifs_list \'{"path":"/shared/projects"}\'',
        'aifs-exec aifs_write \'{"path":"/shared/foo/big.json","content_file":"/tmp/big.json"}\'',
        'aifs-exec aifs_search \'{"scope":"/shared","name_contains":"proposal","type":"file"}\'',
        'aifs-exec aifs_auth_status',
      ],
    }, null, 2));
    process.exit(0);
  }

  const toolName = args[0];
  let toolArgs = {};

  if (args[1] && !args[1].startsWith('--')) {
    try {
      toolArgs = JSON.parse(args[1]);
    } catch (err) {
      console.log(JSON.stringify({
        error: 'INVALID_ARGS',
        message: `Failed to parse JSON arguments: ${err.message}`,
        input_preview: args[1].slice(0, 120),
      }));
      process.exit(1);
    }
  }

  // Cross-platform: callers on Windows will occasionally pass backslashed
  // paths. Normalize before handing off to the adapter so the user sees
  // "PATH_NOT_FOUND" instead of a silent miss through the path cache.
  toolArgs = normalizePathArgs(toolArgs);

  // Initialize environment (proxy/TLS)
  initEnvironment();

  // Load config
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.log(JSON.stringify({
      error: 'CONFIG_ERROR',
      message: err.message,
    }));
    process.exit(1);
  }

  if (config.backend !== 'gdrive') {
    console.log(JSON.stringify({
      error: 'CONFIG_ERROR',
      message: `This package only supports "gdrive" backend. Config specifies "${config.backend}".`,
    }));
    process.exit(1);
  }

  // Initialize adapter
  const adapter = new GoogleDriveAdapter();

  try {
    await adapter.initialize(config.connection, config.auth.credentialStore);
  } catch (err) {
    console.log(JSON.stringify({
      error: 'INIT_ERROR',
      message: `Adapter initialization failed: ${err.message}`,
    }));
    process.exit(1);
  }

  // Load persisted path cache into adapter
  const credentialStore = config.auth.credentialStore;
  const driveId = config.connection?.drive_id;
  const cachedPaths = await loadPathCache(credentialStore, driveId);
  const cacheCreatedAt = cachedPaths._createdAt || Date.now();
  for (const [path, entry] of cachedPaths) {
    if (!adapter.pathCache.has(path)) {
      adapter.pathCache.set(path, entry);
    }
  }

  // CI-025 (technical design §2-§3): org path resolution. Build or load the org
  // map from org-config and seed the adapter, so plain org paths resolve without
  // walking the drive root. resolveOrgMap NEVER throws; with no map the call
  // runs exactly as before 2.12.0.
  const warn = (m) => { try { process.stderr.write(m + '\n'); } catch { /* ignore */ } };
  let orgMap = null;
  let orgMapReason = null;
  if (needsOrgMap(toolName, toolArgs)) {
    try {
      const ctx = { config, adapter, credentialStore, warn };
      let r = await resolveOrgMap(ctx);
      orgMap = r.map;
      if (!orgMap) {
        orgMapReason = r.reason;
        warn(`aifs: org map unavailable (${r.reason}); paths resolved without it`);
      } else {
        for (const seg of missingSegments(orgMap, toolName, toolArgs)) {
          r = await resolveOrgMap({ ...ctx, mode: 'missing-prefix', segment: seg });
          if (r.map) orgMap = r.map;
        }
        toolArgs = canonicalizeArgs(orgMap, toolName, toolArgs);
        adapter.seedOrgPrefixes(orgMap.prefixes);
      }
    } catch (err) {
      // Never let org path resolution fail a call (technical design §2.5).
      orgMap = null;
      orgMapReason = `org_map_error:${err?.message || 'error'}`;
      warn(`aifs: org map unavailable (${orgMapReason}); paths resolved without it`);
    }
  }

  // Execute the tool call
  let exitCode = 0;
  try {
    if (toolName === 'aifs_delete' && orgMap && isProtectedOrgPath(orgMap, toolArgs?.path)) {
      throw new AifsError('PROTECTED_ORG_PATH',
        `aifs_delete refused: "${toolArgs.path}" is an org root (the shared root, a collection folder, org-config or the members registry).`,
        { path: toolArgs.path });
    }
    let result;
    try {
      result = await routeToolCall(adapter, toolName, toolArgs, { credentialStore });
    } catch (err) {
      // §2.4 rule 3: a not-found under a mapped prefix on an idempotent call —
      // if org-config changed (a collection reinstalled, resource_ids back-filled),
      // rebuild the map, re-seed and retry once. Otherwise report as is.
      const notFound = err?.code === 'FILE_NOT_FOUND' || err?.code === 'PATH_NOT_FOUND';
      if (!(orgMap && notFound && IDEMPOTENT_TOOLS.has(toolName) && touchesMappedPrefix(orgMap, toolName, toolArgs))) throw err;
      const r = await resolveOrgMap({ config, adapter, credentialStore, mode: 'not-found', warn });
      if (!r.rebuilt || !r.map) throw err;
      orgMap = r.map;
      adapter.seedOrgPrefixes(orgMap.prefixes);
      result = await routeToolCall(adapter, toolName, toolArgs, { credentialStore });
    }
    const stripped = typeof result === 'string' ? result : stripDebugFields(result);
    if (typeof stripped === 'string') {
      // F4 (2.6.0, bug 20260604-…-2837): file content is emitted byte-exact.
      // console.log appended a trailing newline to every aifs_read result,
      // poisoning hash/diff comparisons fleet-wide. JSON results below keep
      // console.log — a trailing newline on structured output is harmless.
      process.stdout.write(stripped);
    } else {
      console.log(JSON.stringify(stripped, null, 2));
    }
  } catch (err) {
    exitCode = 1;
    if (err instanceof AifsError) {
      const resp = stripDebugFields(err.toResponse());
      // §2.5: a call that ran without the org map and still failed says why the map was missing.
      if (orgMapReason && resp && typeof resp === 'object') resp.org_map = orgMapReason;
      console.log(JSON.stringify(resp, null, 2));
    } else {
      // Include whichever path the caller passed so ENOENT / EACCES errors
      // don't leave Claude guessing what failed.
      const attemptedPath = toolArgs?.path || toolArgs?.source || toolArgs?.destination;
      console.log(JSON.stringify({
        error: 'BACKEND_ERROR',
        message: err.message,
        ...(attemptedPath ? { path: attemptedPath } : {}),
      }, null, 2));
    }
  } finally {
    // Always persist the path cache, even on error — partial resolution
    // results are still valuable for the next call. (CI-025: the error path
    // used to process.exit() inside catch, which skipped this.)
    await savePathCache(credentialStore, adapter.pathCache, driveId, cacheCreatedAt);
  }
  if (exitCode) process.exit(exitCode);
}

main();
