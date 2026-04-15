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

async function routeToolCall(adapter, toolName, args) {
  switch (toolName) {
    case 'aifs_read':
      return adapter.read(args.path);

    case 'aifs_write': {
      await adapter.write(args.path, args.content);
      return { success: true, path: args.path };
    }

    case 'aifs_list': {
      const entries = await adapter.list(args.path, args.recursive ?? false);
      return { entries };
    }

    case 'aifs_exists':
      return adapter.exists(args.path);

    case 'aifs_stat':
      return adapter.stat(args.path);

    case 'aifs_delete': {
      await adapter.delete(args.path);
      return { success: true };
    }

    case 'aifs_copy': {
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
      throw new AifsError('BACKEND_ERROR', `Unknown auth action: ${action}`);
    }

    default:
      throw new AifsError('BACKEND_ERROR', `Unknown tool: ${toolName}`);
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

  if (args[1]) {
    try {
      toolArgs = JSON.parse(args[1]);
    } catch (err) {
      console.log(JSON.stringify({
        error: 'INVALID_ARGS',
        message: `Failed to parse JSON arguments: ${err.message}`,
      }));
      process.exit(1);
    }
  }

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
    const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    console.log(output);
  } catch (err) {
    if (err instanceof AifsError) {
      console.log(JSON.stringify(err.toResponse(), null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({
      error: 'BACKEND_ERROR',
      message: err.message,
    }, null, 2));
    process.exit(1);
  } finally {
    // Always persist the path cache, even on error — partial resolution
    // results are still valuable for the next call
    await savePathCache(config.auth.credentialStore, adapter.pathCache);
  }
}

main();
