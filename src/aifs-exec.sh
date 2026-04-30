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
  echo "Usage: aifs-exec.sh <tool_name> [json_args]"
  echo ""
  echo "Tools:"
  echo "  aifs_read          Read file content"
  echo "  aifs_write         Write file content"
  echo "  aifs_list          List directory contents"
  echo "  aifs_exists        Check path existence"
  echo "  aifs_stat          Get file metadata"
  echo "  aifs_delete        Delete file or empty directory"
  echo "  aifs_copy          Copy file"
  echo "  aifs_auth_status   Check authentication state"
  echo "  aifs_authenticate  Initiate/complete OAuth flow"
  echo ""
  echo "Examples:"
  echo "  aifs-exec.sh aifs_read '{\"path\":\"/projects/foo/project.md\"}'"
  echo "  aifs-exec.sh aifs_list '{\"path\":\"/shared/projects\"}'"
  echo "  aifs-exec.sh aifs_auth_status"
  echo ""
  echo "Environment:"
  echo "  AIFS_CONFIG_PATH   Path to agent-index.json (auto-discovered if not set)"
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
