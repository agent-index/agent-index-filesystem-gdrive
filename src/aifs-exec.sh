#!/usr/bin/env bash
# aifs-exec.sh — Shell wrapper for on-demand AIFS filesystem operations.
#
# Each invocation starts a fresh Node process, executes one operation,
# and exits. No server, no bridge, no process management.
#
# Usage:
#   aifs-exec.sh <tool_name> [json_args]
#   aifs-exec.sh aifs_read '{"path":"/projects/foo/project.md"}'
#   aifs-exec.sh aifs_list '{"path":"/shared/projects"}'
#   aifs-exec.sh aifs_auth_status
#   aifs-exec.sh --help
#
# Environment:
#   AIFS_CONFIG_PATH  Path to agent-index.json (auto-discovered if not set)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── Config discovery ──────────────────────────────────────────────────

find_config() {
  # Explicit env var takes precedence
  if [ -n "${AIFS_CONFIG_PATH:-}" ]; then
    echo "$AIFS_CONFIG_PATH"
    return
  fi

  # Walk up from script directory looking for agent-index.json
  local dir="$SCRIPT_DIR"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/agent-index.json" ]; then
      echo "$dir/agent-index.json"
      return
    fi
    dir="$(dirname "$dir")"
  done

  # Check common Cowork mount patterns
  for dir in "$HOME"/mnt/*/; do
    if [ -f "$dir/agent-index.json" ]; then
      echo "$dir/agent-index.json"
      return
    fi
  done

  echo ""
}

# ─── Bundle discovery ──────────────────────────────────────────────────

find_bundle() {
  # Check same directory (installed layout — bundle alongside wrapper)
  if [ -f "$SCRIPT_DIR/aifs-exec.bundle.js" ]; then
    echo "$SCRIPT_DIR/aifs-exec.bundle.js"
    return
  fi

  # Check dist directory (source repo layout — wrapper in src/, bundle in dist/)
  if [ -f "$SCRIPT_DIR/../dist/aifs-exec.bundle.js" ]; then
    echo "$SCRIPT_DIR/../dist/aifs-exec.bundle.js"
    return
  fi

  # Fall back to source (development — no bundle built yet)
  if [ -f "$SCRIPT_DIR/exec.mjs" ]; then
    echo "$SCRIPT_DIR/exec.mjs"
    return
  fi

  echo ""
}

# ─── Main ──────────────────────────────────────────────────────────────

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] || [ -z "${1:-}" ]; then
  cat <<'HELP'
Usage: aifs-exec.sh <tool_name> [json_args]

Tools and their JSON arguments (? = optional). Unknown arguments are
ignored without an error, so a misspelled name silently does nothing.

  aifs_read                Read file content
                             {path}
  aifs_write               Write file content
                             {path, content | content_file | content_stdin, encoding?, if_revision?}
  aifs_list                List directory contents
                             {path, recursive?}
  aifs_exists              Check path existence
                             {path}
  aifs_stat                Get file metadata
                             {path}
  aifs_delete              Delete file or empty directory
                             {path}
  aifs_copy                Copy file
                             {source, destination}
  aifs_auth_status         Check authentication state
                             {}
  aifs_authenticate        Initiate/complete OAuth flow
                             {action?: "start" | "complete", auth_code?}
  aifs_share               Grant access to a path
                             {path, subject, role, inherit?}
  aifs_unshare             Remove access from a path
                             {path, subject}
  aifs_get_permissions     List permissions on a path
                             {path, include_inherited?}
  aifs_search              Find files and folders by name
                             {scope, name_contains?, type?: "file" | "folder" | "any", max_results?}
  aifs_transfer_ownership  Transfer ownership (personal Drive only)
                             {path, new_owner}
  aifs_write_batch         Write many files in one process
                             {entries: [{path, content | content_file, encoding?}]}
  aifs_stat_batch          Get metadata for many paths in one process
                             {paths: [...]}

aifs_write content — give exactly one:
  content          Inline string. Carried on the command line, so bounded by
                   the OS argument limit (about 128 KiB).
  content_file     Path to a local file the executor reads directly. No size limit.
  content_stdin    true: read the payload from stdin. No size limit.
  If more than one is given: content, then content_file, then content_stdin wins.
  encoding         "base64": a content_file/content_stdin payload is taken as raw
                   bytes (use for binary files; otherwise it is read as UTF-8
                   text). An inline content string must itself be base64.
  if_revision      Revision from aifs_stat; the write fails with
                   REVISION_CONFLICT if the file has changed since.

aifs_search: without name_contains nothing is filtered — you get an arbitrary,
unordered page of up to max_results (default 100, max 1000) items under scope.

Examples:
  aifs-exec.sh aifs_read '{"path":"/projects/foo/project.md"}'
  aifs-exec.sh aifs_list '{"path":"/shared/projects"}'
  aifs-exec.sh aifs_write '{"path":"/shared/foo/big.json","content_file":"/tmp/big.json"}'
  aifs-exec.sh aifs_search '{"scope":"/shared","name_contains":"proposal","type":"file"}'
  aifs-exec.sh aifs_auth_status

Environment:
  AIFS_CONFIG_PATH   Path to agent-index.json (auto-discovered if not set)
HELP
  exit 0
fi

# Find config
CONFIG_PATH="$(find_config)"
if [ -z "$CONFIG_PATH" ]; then
  echo '{"error":"CONFIG_ERROR","message":"Cannot find agent-index.json. Set AIFS_CONFIG_PATH."}'
  exit 1
fi
export AIFS_CONFIG_PATH="$CONFIG_PATH"

# Find bundle/source
EXEC_PATH="$(find_bundle)"
if [ -z "$EXEC_PATH" ]; then
  echo '{"error":"EXEC_ERROR","message":"Cannot find aifs-exec bundle or source."}'
  exit 1
fi

# Execute
#
# --no-deprecation / --no-warnings suppress Node-level deprecation and
# experimental-feature warnings from our transitive deps (punycode, etc.).
# These are purely noise in a CLI wrapper and they leak into stderr where
# callers have to decide whether they're meaningful. If a real error occurs
# it still surfaces through the process exit code and JSON error output.
exec node --no-deprecation --no-warnings "$EXEC_PATH" "$@"
