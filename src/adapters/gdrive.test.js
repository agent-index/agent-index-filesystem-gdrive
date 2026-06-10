// Platform Reliability (2.6.0) unit tests — node:test, fully mocked Drive.
// Covers: sentinel detection (all encodings), flakyread retry semantics
// (stat-gated empty-read retries, transient NOT_FOUND re-resolution,
// genuine-empty passthrough, AIFS_READ_UNRELIABLE), and sentinel-aware
// write verification (pass / heal-on-retry / AIFS_WRITE_VERIFY_FAILED).
//
// Live-backend behavior (byte-exact reads through the exec layer, binary
// round-trip, >128KB content_file writes) is covered by the release test
// plan suites S1.1–S1.3 on a real Drive — these tests pin the logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GoogleDriveAdapter,
  detectSentinel,
  AIFS_SENTINEL,
  READ_RETRY_BACKOFF_MS,
} from './gdrive.js';

// ─── detectSentinel ───────────────────────────────────────────────────

test('detectSentinel: markdown encoding', () => {
  assert.equal(detectSentinel(`# Doc\n\nbody\n\n<!-- ${AIFS_SENTINEL} -->\n`), 'md');
  assert.equal(detectSentinel(`# Doc\n\n<!-- ${AIFS_SENTINEL} -->\n\n   \n`), 'md'); // trailing ws ok
});

test('detectSentinel: json reserved key (closing braces after key)', () => {
  assert.equal(detectSentinel(`{\n  "a": 1,\n  "_file_end": "${AIFS_SENTINEL}"\n}\n`), 'json');
});

test('detectSentinel: script comment encodings', () => {
  assert.equal(detectSentinel(`#!/bin/bash\necho hi\n# ${AIFS_SENTINEL}\n`), 'hash');
  assert.equal(detectSentinel(`const x = 1;\n// ${AIFS_SENTINEL}\n`), 'slash');
});

test('detectSentinel: negatives', () => {
  assert.equal(detectSentinel('plain text, no marker\n'), null);
  assert.equal(detectSentinel(`<!-- ${AIFS_SENTINEL} -->\ntrailing content after marker`), null);
  assert.equal(detectSentinel('base64:aGVsbG8='), null); // binary never checked
  assert.equal(detectSentinel(''), null);
  assert.equal(detectSentinel(`truncated mid <!-- ${AIFS_SENTINEL} -`), null);
});

// ─── test harness: adapter with mocked Drive ──────────────────────────

function mockAdapter({ getImpls = [], updateImpl, createImpl } = {}) {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = {}; // My Drive shape — no drive_id branches
  adapter._ensureAuth = () => {};
  adapter._resolvePathToId = async () => 'file-1';
  adapter._ensureParentDirs = async () => 'parent-1';
  const calls = { get: 0, update: 0, create: 0 };
  adapter.drive = {
    files: {
      get: async (params, opts) => {
        calls.get++;
        const impl = getImpls.length === 1 ? getImpls[0] : getImpls.shift();
        if (!impl) throw new Error('mock: unexpected files.get call');
        return impl(params, opts);
      },
      update: async (params) => {
        calls.update++;
        return (updateImpl ?? (() => ({ data: { id: 'file-1', mimeType: 'text/plain', headRevisionId: 'rev-1' } })))(params);
      },
      create: async (params) => {
        calls.create++;
        return (createImpl ?? (() => ({ data: { id: 'file-new', mimeType: 'text/plain', headRevisionId: 'rev-1' } })))(params);
      },
    },
  };
  return { adapter, calls };
}

const media = (s) => ({ data: Buffer.from(s) });
const meta = (size) => ({ data: { size: String(size) } });

// ─── read: flakyread semantics ────────────────────────────────────────

test('read: transient empty heals via stat-gate + retry', async () => {
  const { adapter, calls } = mockAdapter({
    getImpls: [
      () => media(''),        // 1st content fetch: empty (flaky)
      () => meta(11),         // stat-gate: metadata says 11 bytes
      () => media('hello world'), // retry: real content
    ],
  });
  const out = await adapter.read('/x.md');
  assert.equal(out, 'hello world');
  assert.equal(calls.get, 3);
});

test('read: genuinely empty file returns "" with no retries', async () => {
  const { adapter, calls } = mockAdapter({
    getImpls: [
      () => media(''),  // content fetch: empty
      () => meta(0),    // metadata confirms size 0
    ],
  });
  const out = await adapter.read('/empty.txt');
  assert.equal(out, '');
  assert.equal(calls.get, 2); // no backoff retries for a real empty file
});

test('read: persistent empty for non-empty file -> AIFS_READ_UNRELIABLE', async () => {
  const { adapter } = mockAdapter({
    getImpls: [() => media('')], // single impl: EVERY fetch returns empty
  });
  // patch the lone stat call: distinguish by params.fields
  const origGet = adapter.drive.files.get;
  adapter.drive.files.get = async (params, opts) =>
    params.fields === 'size' ? meta(42) : origGet(params, opts);
  await assert.rejects(
    () => adapter.read('/x.md'),
    (err) => err.code === 'AIFS_READ_UNRELIABLE'
      && err.details?.retries === READ_RETRY_BACKOFF_MS.length
  );
});

test('read: transient NOT_FOUND re-resolves once before failing', async () => {
  const { adapter } = mockAdapter({ getImpls: [() => media('ok')] });
  let resolveCalls = 0;
  adapter._resolvePathToId = async () => (++resolveCalls === 1 ? null : 'file-1');
  const out = await adapter.read('/flaky.md');
  assert.equal(out, 'ok');
  assert.equal(resolveCalls, 2);
});

test('read: genuinely missing file still throws NOT_FOUND (after one re-resolve)', async () => {
  const { adapter } = mockAdapter({ getImpls: [() => media('never')] });
  let resolveCalls = 0;
  adapter._resolvePathToId = async () => { resolveCalls++; return null; };
  await assert.rejects(() => adapter.read('/gone.md'));
  assert.equal(resolveCalls, 2);
});

// ─── write: sentinel verification ─────────────────────────────────────

const STAMPED = `# Doc\n\nbody\n\n<!-- ${AIFS_SENTINEL} -->\n`;

test('write: stamped content, sentinel survives -> one write, one verify', async () => {
  const { adapter, calls } = mockAdapter({ getImpls: [() => media(STAMPED)] });
  const res = await adapter.write('/doc.md', STAMPED);
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.update, 1); // existingId path (resolve returns file-1)
  assert.equal(calls.get, 1);    // one verification read-back
});

test('write: sentinel lost once -> rewrite heals', async () => {
  const { adapter, calls } = mockAdapter({
    getImpls: [
      () => media(STAMPED.slice(0, 12)), // verify #1: tail-truncated read-back
      () => media(STAMPED),              // verify #2 (after rewrite): intact
    ],
  });
  const res = await adapter.write('/doc.md', STAMPED);
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.update, 2); // original + healing rewrite
  assert.equal(calls.get, 2);
});

test('write: sentinel never survives -> AIFS_WRITE_VERIFY_FAILED', async () => {
  const { adapter, calls } = mockAdapter({
    getImpls: [() => media('truncated garbag')], // every verify fails
  });
  await assert.rejects(
    () => adapter.write('/doc.md', STAMPED),
    (err) => err.code === 'AIFS_WRITE_VERIFY_FAILED' && err.details?.sentinel_kind === 'md'
  );
  assert.equal(calls.update, 2); // exactly one retry, then loud failure
});

test('write: unstamped content -> zero verification overhead', async () => {
  const { adapter, calls } = mockAdapter({ getImpls: [] });
  const res = await adapter.write('/notes.txt', 'no marker here\n');
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.get, 0); // no read-back at all
});

test('write: binary (base64:) content is never sentinel-verified', async () => {
  const { adapter, calls } = mockAdapter({ getImpls: [] });
  const res = await adapter.write('/logo.png', 'base64:' + Buffer.from('png-bytes').toString('base64'));
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.get, 0);
});

// AIFS:FILE-END (in a JS comment, the test file practices the standard:)
// AIFS:FILE-END
