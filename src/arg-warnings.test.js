// CI-018 Phase 1 tests: unknown-argument and multiple-content-source warnings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { argWarnings, TOOL_ARGS, WRITE_BATCH_ENTRY_ARGS } from './arg-warnings.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('clean calls produce no warnings', () => {
  assert.deepEqual(argWarnings('aifs_read', { path: '/a' }), []);
  assert.deepEqual(argWarnings('aifs_read', { path: '/a', encoding: 'base64' }), []);
  assert.deepEqual(argWarnings('aifs_write', { path: '/a', content: 'x', if_revision: 'r' }), []);
  assert.deepEqual(argWarnings('aifs_write', { path: '/a', content_file: '/tmp/f', encoding: 'base64' }), []);
  assert.deepEqual(argWarnings('aifs_search', { scope: '/shared', name_contains: 'p', type: 'file', max_results: 5 }), []);
  assert.deepEqual(argWarnings('aifs_auth_status', {}), []);
  assert.deepEqual(argWarnings('aifs_write_batch', { entries: [{ path: '/a', content: 'x' }, { path: '/b', content_file: '/f', encoding: 'base64' }] }), []);
});

test('the f989 case: aifs_search with "query" is named', () => {
  const w = argWarnings('aifs_search', { scope: '/shared', query: 'proposal' });
  assert.equal(w.length, 1);
  assert.match(w[0], /^aifs_search: ignored unknown argument "query" \(accepted: scope, name_contains, type, max_results\)$/);
});

test('several unknown arguments are listed together', () => {
  const w = argWarnings('aifs_list', { path: '/a', recurse: true, depth: 2 });
  assert.equal(w.length, 1);
  assert.match(w[0], /ignored unknown arguments "recurse", "depth"/);
});

test('a tool with no arguments still names extras', () => {
  assert.match(argWarnings('aifs_auth_status', { verbose: true })[0], /"verbose" \(accepted: none\)/);
});

test('aifs_write: more than one content source names the one used (content > content_file > content_stdin)', () => {
  assert.match(argWarnings('aifs_write', { path: '/a', content: 'x', content_file: '/f' })[0],
    /more than one content source given \(content, content_file\); used content, ignored content_file/);
  assert.match(argWarnings('aifs_write', { path: '/a', content_file: '/f', content_stdin: true })[0],
    /\(content_file, content_stdin\); used content_file, ignored content_stdin/);
  assert.match(argWarnings('aifs_write', { path: '/a', content: '', content_file: '/f', content_stdin: true })[0],
    /used content, ignored content_file, content_stdin/); // an empty string is still content
});

test('aifs_write: values the executor would not use are not counted as sources', () => {
  assert.deepEqual(argWarnings('aifs_write', { path: '/a', content: 'x', content_file: '' }), []);
  assert.deepEqual(argWarnings('aifs_write', { path: '/a', content: 'x', content_stdin: false }), []);
  assert.deepEqual(argWarnings('aifs_write', { path: '/a', content: null, content_file: '/f' }), []);
});

test('aifs_write_batch: per-entry unknown keys and both content sources', () => {
  const w = argWarnings('aifs_write_batch', { entries: [{ path: '/a', content: 'x', mode: 'append' }, { path: '/b', content: 'y', content_file: '/f' }] });
  assert.equal(w.length, 2);
  assert.match(w[0], /entries\[0\] ignored unknown key "mode"/);
  assert.match(w[1], /entries\[1\] has both content and content_file; used content/);
});

test('unknown tools and odd inputs produce no warnings and never throw', () => {
  assert.deepEqual(argWarnings('aifs_nope', { x: 1 }), []);
  assert.deepEqual(argWarnings('aifs_read', null), []);
  assert.deepEqual(argWarnings('aifs_read', ['path']), []);
  assert.deepEqual(argWarnings('aifs_write_batch', { entries: 'not-an-array' }), []);
});

test('TOOL_ARGS matches what routeToolCall in exec.mjs actually reads', () => {
  const src = readFileSync(join(here, 'exec.mjs'), 'utf8');
  const start = src.search(/function\s+routeToolCall\s*\(/);
  const body = src.slice(start, start + src.slice(start).search(/\n\}\s*\n/));
  const labels = [...body.matchAll(/case\s+['"](aifs_[a-z0-9_]+)['"]\s*:/g)];
  const end = body.search(/\bdefault\s*:/);
  const read = {};
  let pending = [];
  labels.forEach((m, i) => {
    const seg = body.slice(m.index + m[0].length, i + 1 < labels.length ? labels[i + 1].index : end);
    pending.push(m[1]);
    if (!seg.trim()) return;
    const args = new Set([...seg.matchAll(/\bargs\??\.([A-Za-z_]\w*)/g)].map((x) => x[1]));
    for (const x of seg.matchAll(/hasOwnProperty\.call\(\s*args\s*,\s*['"](\w+)['"]/g)) args.add(x[1]);
    for (const t of pending) read[t] = args;
    pending = [];
  });
  assert.deepEqual(Object.keys(TOOL_ARGS).sort(), Object.keys(read).sort(), 'TOOL_ARGS and routeToolCall cover different tools');
  for (const [tool, args] of Object.entries(read)) {
    assert.deepEqual([...TOOL_ARGS[tool]].sort(), [...args].sort(), `${tool}: TOOL_ARGS differs from the arguments routeToolCall reads`);
  }
  const batch = body.slice(body.indexOf("case 'aifs_write_batch'"), body.indexOf("case 'aifs_stat_batch'"));
  const entryKeys = new Set([...batch.matchAll(/\be\.([A-Za-z_]\w*)/g)].map((x) => x[1]));
  assert.deepEqual([...WRITE_BATCH_ENTRY_ARGS].sort(), [...entryKeys].sort(), 'WRITE_BATCH_ENTRY_ARGS differs from the entry keys routeToolCall reads');
});
