// arg-warnings.mjs — CI-018 Phase 1: warn, don't reject.
//
// The executor used to ignore arguments a tool doesn't define, without a word.
// That is how aifs_search's nonexistent `query` argument went unnoticed (bug f989):
// the search ran unfiltered and looked like it worked. Phase 1 writes a warning to
// stderr naming the tool and each ignored argument, and warns when aifs_write gets
// more than one content source, naming the one used. Behaviour is unchanged: the
// call still runs exactly as before. (Phase 2, later: reject with INVALID_ARGS.)
//
// TOOL_ARGS must list every argument routeToolCall in exec.mjs reads for each tool.
// arg-warnings.test.js checks it against exec.mjs, so the two can't drift apart.

export const TOOL_ARGS = Object.freeze({
  aifs_read: ['path', 'encoding'],
  aifs_write: ['path', 'content', 'content_file', 'content_stdin', 'encoding', 'if_revision'],
  aifs_list: ['path', 'recursive'],
  aifs_exists: ['path'],
  aifs_stat: ['path'],
  aifs_delete: ['path'],
  aifs_copy: ['source', 'destination'],
  aifs_auth_status: [],
  aifs_authenticate: ['action', 'auth_code'],
  aifs_share: ['path', 'subject', 'role', 'inherit'],
  aifs_unshare: ['path', 'subject'],
  aifs_get_permissions: ['path', 'include_inherited'],
  aifs_search: ['scope', 'name_contains', 'type', 'max_results'],
  aifs_transfer_ownership: ['path', 'new_owner'],
  aifs_write_batch: ['entries'],
  aifs_stat_batch: ['paths'],
});

// Keys an aifs_write_batch entry may carry (routeToolCall reads e.path, e.content,
// e.content_file, e.encoding). Entries never take content_stdin.
export const WRITE_BATCH_ENTRY_ARGS = Object.freeze(['path', 'content', 'content_file', 'encoding']);

// Which content sources a write call (or batch entry) actually supplied, in the
// order the executor checks them. Mirrors routeToolCall: content counts unless
// undefined/null (an empty string is a legal empty file); content_file counts when
// it's a non-empty string; content_stdin only when it is exactly true.
export function contentSources(a) {
  const used = [];
  if (a.content !== undefined && a.content !== null) used.push('content');
  if (typeof a.content_file === 'string' && a.content_file.length > 0) used.push('content_file');
  if (a.content_stdin === true) used.push('content_stdin');
  return used;
}

/**
 * Warnings for one tool call. Returns an array of strings (empty when the call is clean).
 * Never throws and never changes args. Unknown tools get no warnings: the executor
 * already fails them with UNKNOWN_TOOL.
 */
export function argWarnings(toolName, args) {
  const known = TOOL_ARGS[toolName];
  if (!known || !args || typeof args !== 'object' || Array.isArray(args)) return [];
  const warnings = [];

  const unknown = Object.keys(args).filter((k) => !known.includes(k));
  if (unknown.length) {
    warnings.push(`${toolName}: ignored unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')} (accepted: ${known.length ? known.join(', ') : 'none'})`);
  }

  if (toolName === 'aifs_write') {
    const used = contentSources(args);
    if (used.length > 1) {
      warnings.push(`aifs_write: more than one content source given (${used.join(', ')}); used ${used[0]}, ignored ${used.slice(1).join(', ')}`);
    }
  }

  if (toolName === 'aifs_write_batch' && Array.isArray(args.entries)) {
    args.entries.forEach((e, i) => {
      if (!e || typeof e !== 'object') return;
      const extra = Object.keys(e).filter((k) => !WRITE_BATCH_ENTRY_ARGS.includes(k));
      if (extra.length) {
        warnings.push(`aifs_write_batch: entries[${i}] ignored unknown key${extra.length > 1 ? 's' : ''} ${extra.map((k) => `"${k}"`).join(', ')} (accepted: ${WRITE_BATCH_ENTRY_ARGS.join(', ')})`);
      }
      const used = contentSources(e).filter((s) => s !== 'content_stdin');
      if (used.length > 1) {
        warnings.push(`aifs_write_batch: entries[${i}] has both content and content_file; used content, ignored content_file`);
      }
    });
  }
  return warnings;
}
