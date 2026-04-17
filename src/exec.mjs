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

import { initEnvironment, loadConfig } from '@agent-index/filesystem';
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
  for (const key of ['path', 'source', 'destination']) {
    if (typeof out[key] === 'string') {
      out[key] = out[key].replace(/\\/g, '/');
    }
  }
  return out;
}

// ─── Path Cache Persistence ───────────────────────────────────────────

const PATH_CACHE_FILENAME = 'path-cache.json';
const PATH_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const PATH_CACHE_MAX_ENTRIES = 2000;

/**
 * Load the persisted path cache from disk.
 * Returns a Map of normalized path → { id, mimeType }.
 */
async function loadPathCache(credentialStore) {
  const cachePath = join(credentialStore, PATH_CACHE_FILENAME);
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const data = JSON.parse(raw);

    // Check if cache is too old
    if (data.timestamp && (Date.now() - data.timestamp) > PATH_CACHE_MAX_AGE_MS) {
      return new Map();
    }

    return new Map(Object.entries(data.entries || {}));
  } catch {
    return new Map();
  }
}

/**
 * Persist the path cache to disk.
 * Prunes to MAX_ENTRIES if needed.
 */
async function savePathCache(credentialStore, pathCache) {
  const cachePath = join(credentialStore, PATH_CACHE_FILENAME);
  const entries = {};
  let count = 0;

  for (const [key, value] of pathCache) {
    if (count >= PATH_CACHE_MAX_ENTRIES) break;
    entries[key] = value;
    count++;
  }

  const data = {
    timestamp: Date.now(),
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

async function routeToolCall(adapter, toolName, args) {
  switch (toolName) {
    case 'aifs_read':
      requireArgs(toolName, args, [['path', 'path']]);
      return adapter.read(args.path);

    case 'aifs_write': {
      // content may legally be the empty string (truncate-to-zero write),
      // so it's required-defined but allowed-empty. path must be a real path.
      requireArgs(toolName, args, [['path', 'path'], 'content']);

      // Honour the optional `encoding` field. When encoding is "base64",
      // prepend the "base64:" sentinel that the adapter's write() method
      // looks for so the payload is decoded to binary bytes before upload.
      // Without this, base64 text gets stored as-is and the resulting
      // Drive file is an ASCII blob instead of the intended binary.
      let content = args.content;
      if (args.encoding === 'base64' && !content.startsWith('base64:')) {
        content = 'base64:' + content;
      }

      await adapter.write(args.path, content);
      return { success: true, path: args.path };
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

    case 'aifs_auth_status':
      return adapter.getAuthStatus();

    case 'aifs_authenticate': {
      const action = args.action || 'start';
      if (action === 'start') {
        return adapter.startAuth();
      } else if (action === 'complete') {
        return adapter.completeAuth(args.auth_code);
      }
      throw new AifsError('INVALID_ARGS', `Unknown auth action: ${action}`, {
        tool: toolName,
        valid_actions: ['start', 'complete'],
      });
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
      ],
      examples: [
        'aifs-exec aifs_read \'{"path":"/projects/foo/project.md"}\'',
        'aifs-exec aifs_list \'{"path":"/shared/projects"}\'',
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
  const cachedPaths = await loadPathCache(config.auth.credentialStore);
  for (const [path, entry] of cachedPaths) {
    if (!adapter.pathCache.has(path)) {
      adapter.pathCache.set(path, entry);
    }
  }

  // Execute the tool call
  try {
    const result = await routeToolCall(adapter, toolName, toolArgs);
    const stripped = typeof result === 'string' ? result : stripDebugFields(result);
    const output = typeof stripped === 'string' ? stripped : JSON.stringify(stripped, null, 2);
    console.log(output);
  } catch (err) {
    if (err instanceof AifsError) {
      console.log(JSON.stringify(stripDebugFields(err.toResponse()), null, 2));
      process.exit(1);
    }
    // Include whichever path the caller passed so ENOENT / EACCES errors
    // don't leave Claude guessing what failed.
    const attemptedPath = toolArgs?.path || toolArgs?.source || toolArgs?.destination;
    console.log(JSON.stringify({
      error: 'BACKEND_ERROR',
      message: err.message,
      ...(attemptedPath ? { path: attemptedPath } : {}),
    }, null, 2));
    process.exit(1);
  } finally {
    // Always persist the path cache, even on error — partial resolution
    // results are still valuable for the next call
    await savePathCache(config.auth.credentialStore, adapter.pathCache);
  }
}

main();
