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
import { createHash } from 'node:crypto';
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
    params.fields ? meta(42) : origGet(params, opts);
  await assert.rejects(
    () => adapter.read('/x.md'),
    (err) => err.code === 'AIFS_READ_UNRELIABLE'
      && err.details?.retries === READ_RETRY_BACKOFF_MS.length
  );
});

// ─── read: integrity on non-empty reads (2.11.6, bug 733b) ────────────

const md5hex = (str) => createHash('md5').update(Buffer.from(str)).digest('hex');
const metaFull = (str, extra = {}) => ({ data: { size: String(Buffer.byteLength(str)), md5Checksum: md5hex(str), ...extra } });

test('read: short body heals on retry (size mismatch, 733b)', async () => {
  const { adapter, calls } = mockAdapter({
    getImpls: [
      () => media('hello wor'),          // truncated body
      () => metaFull('hello world'),     // metadata: 11 bytes
      () => media('hello world'),        // retry body
      () => metaFull('hello world'),     // retry metadata
    ],
  });
  assert.equal(await adapter.read('/x.md'), 'hello world');
  assert.equal(calls.get, 4);
});

test('read: stale body with matching size but wrong md5 -> AIFS_READ_UNRELIABLE after retries (733b)', async () => {
  const { adapter } = mockAdapter({});
  adapter.drive.files.get = async (params) => (params.fields ? metaFull('new content') : media('old content'));
  await assert.rejects(
    () => adapter.read('/x.md'),
    (err) => err.code === 'AIFS_READ_UNRELIABLE' && err.details?.reason === 'checksum_mismatch'
      && err.details?.retries === READ_RETRY_BACKOFF_MS.length
  );
});

test('read: matching size + md5 returns on the first fetch (one metadata call)', async () => {
  const { adapter, calls } = mockAdapter({ getImpls: [() => media('abc'), () => metaFull('abc')] });
  assert.equal(await adapter.read('/x.md'), 'abc');
  assert.equal(calls.get, 2);
});

test('read: a failed metadata call does not fail a non-empty read (733b)', async () => {
  const { adapter } = mockAdapter({});
  adapter.drive.files.get = async (params) => {
    if (params.fields) throw Object.assign(new Error('backend error'), { code: 500 });
    return media('body');
  };
  assert.equal(await adapter.read('/x.md'), 'body');
});

test('read: native Google file and missing md5 are not checked (733b)', async () => {
  const a = mockAdapter({ getImpls: [() => media('exported'), () => ({ data: { mimeType: 'application/vnd.google-apps.document' } })] });
  assert.equal(await a.adapter.read('/doc'), 'exported');
  const b = mockAdapter({ getImpls: [() => media('abc'), () => ({ data: { size: '3' } })] });
  assert.equal(await b.adapter.read('/x.md'), 'abc');
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

// ─── write: sentinel verification + M2 durable read-back ──────────────
//
// M2 (2.8.0) adds an unconditional committed-size read-back BEFORE the
// sentinel re-read, so every write now issues at least one `fields=size`
// metadata GET (returned by meta() from the getImpls queue). Sentinel tests
// front-load a matching meta() so the M2 gate passes cleanly and the sentinel
// path is exercised in isolation.

const STAMPED = `# Doc\n\nbody\n\n<!-- ${AIFS_SENTINEL} -->\n`;
const STAMPED_BYTES = Buffer.byteLength(STAMPED, 'utf-8');
const JSON_DOC = JSON.stringify({ a: 1, b: 'two', c: [3, 4, 5], note: 'no sentinel here' });
const JSON_BYTES = Buffer.byteLength(JSON_DOC, 'utf-8');

test('write: stamped content, sentinel survives -> M2 pass + one sentinel verify', async () => {
  const { adapter, calls } = mockAdapter({
    getImpls: [
      () => meta(STAMPED_BYTES), // M2 committedSize: matches
      () => media(STAMPED),      // sentinel verify: intact
    ],
  });
  const res = await adapter.write('/doc.md', STAMPED);
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.update, 1); // existingId path (resolve returns file-1)
  assert.equal(calls.get, 2);    // committedSize + sentinel verify
});

test('write: sentinel lost once -> rewrite heals', async () => {
  const { adapter, calls } = mockAdapter({
    getImpls: [
      () => meta(STAMPED_BYTES),         // M2 committedSize: matches
      () => media(STAMPED.slice(0, 12)), // sentinel verify #1: tail-truncated read-back
      () => media(STAMPED),              // sentinel verify #2 (after rewrite): intact
    ],
  });
  const res = await adapter.write('/doc.md', STAMPED);
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.update, 2); // original + healing rewrite
  assert.equal(calls.get, 3);    // committedSize + two sentinel verifies
});

test('write: sentinel never survives -> AIFS_WRITE_VERIFY_FAILED', async () => {
  const { adapter, calls } = mockAdapter({
    getImpls: [
      () => meta(STAMPED_BYTES),       // M2 committedSize: matches (isolate the sentinel path)
      () => media('truncated garbag'), // sentinel verify #1: fails
      () => media('truncated garbag'), // sentinel verify #2: fails
    ],
  });
  await assert.rejects(
    () => adapter.write('/doc.md', STAMPED),
    (err) => err.code === 'AIFS_WRITE_VERIFY_FAILED' && err.details?.sentinel_kind === 'md'
  );
  assert.equal(calls.update, 2); // exactly one retry, then loud failure
});

test('write: unstamped content -> M2 size read-back, no sentinel verify', async () => {
  const body = 'no marker here\n';
  const { adapter, calls } = mockAdapter({ getImpls: [() => meta(Buffer.byteLength(body, 'utf-8'))] });
  const res = await adapter.write('/notes.txt', body);
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.get, 1); // committedSize only; unstamped => no sentinel re-read
});

test('write: binary (base64:) -> M2 verifies decoded byte length, no sentinel verify', async () => {
  const raw = 'png-bytes';
  const { adapter, calls } = mockAdapter({ getImpls: [() => meta(raw.length)] });
  const res = await adapter.write('/logo.png', 'base64:' + Buffer.from(raw).toString('base64'));
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.get, 1); // committedSize on decoded length; binary is never sentinel-verified
});

// ─── write: M2 durable read-back on non-sentinel content ──────────────

test('write: M2 durable read-back matches -> success (non-sentinel JSON)', async () => {
  const { adapter, calls } = mockAdapter({ getImpls: [() => meta(JSON_BYTES)] });
  const res = await adapter.write('/collection.json', JSON_DOC);
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.update, 1);
  assert.equal(calls.get, 1); // committedSize; no sentinel on plain JSON
});

test('write: M2 committed size mismatches once -> rewrite heals', async () => {
  const { adapter, calls } = mockAdapter({
    getImpls: [
      () => meta(JSON_BYTES - 5), // committedSize #1: torn (short)
      () => meta(JSON_BYTES),     // committedSize #2 (after rewrite): correct
    ],
  });
  const res = await adapter.write('/collection.json', JSON_DOC);
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.update, 2); // original + healing rewrite
  assert.equal(calls.get, 2);
});

test('write: M2 committed size persistently wrong -> AIFS_WRITE_VERIFY_FAILED', async () => {
  const { adapter, calls } = mockAdapter({
    getImpls: [
      () => meta(JSON_BYTES - 5),
      () => meta(JSON_BYTES - 5),
    ],
  });
  await assert.rejects(
    () => adapter.write('/collection.json', JSON_DOC),
    (err) => err.code === 'AIFS_WRITE_VERIFY_FAILED'
      && err.details?.verify === 'durable-readback'
      && err.details?.expected_bytes === JSON_BYTES
      && err.details?.actual_bytes === JSON_BYTES - 5
  );
  assert.equal(calls.update, 2); // one rewrite, then loud failure
});

test('write: M2 best-effort -> unreadable committed size never fails the write', async () => {
  // Metadata GET returns no size field => committedSize() returns null =
  // "cannot confirm", so the write succeeds rather than failing falsely.
  const { adapter, calls } = mockAdapter({ getImpls: [() => ({ data: {} })] });
  const res = await adapter.write('/collection.json', JSON_DOC);
  assert.equal(res.revision, 'rev-1');
  assert.equal(calls.update, 1); // no rewrite
});

test('write: M2 response-size mismatch -> AIFS_WRITE_VERIFY_FAILED before read-back', async () => {
  // The update RESPONSE reports a wrong stored size => fail immediately,
  // before the durable read-back is even attempted.
  const { adapter, calls } = mockAdapter({
    updateImpl: () => ({ data: { id: 'file-1', mimeType: 'text/plain', headRevisionId: 'rev-1', size: String(JSON_BYTES - 3) } }),
  });
  await assert.rejects(
    () => adapter.write('/collection.json', JSON_DOC),
    (err) => err.code === 'AIFS_WRITE_VERIFY_FAILED' && err.details?.actual_bytes === JSON_BYTES - 3
  );
  assert.equal(calls.get, 0); // threw before any read-back
});

// ─── search: resolvable result locators (searchpathunresolvable, C.1.3.7) ──

test('search: uncached hit returns an id:{id} anchor + id, not a fabricated /{name}', async () => {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = {};            // My Drive shape — no drive_id/_listParams branch
  adapter._ensureAuth = () => {};
  adapter._idToPath = () => null;     // uncached — force the fallback path
  adapter.drive = { files: { list: async () => ({ data: { files: [
    { id: 'FILE123', name: 'gd-test', mimeType: 'application/json',
      owners: [{ emailAddress: 't@x' }], modifiedTime: '2026-07-06T00:00:00Z' },
  ] } }) } };
  const { results } = await adapter.search({ scope: '/', nameContains: 'gd-test' });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'FILE123');
  assert.equal(results[0].path, 'id:FILE123'); // resolvable anchor, NOT '/gd-test'
});

test('search: cached hit keeps its real human-readable path (and still carries id)', async () => {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = {};
  adapter._ensureAuth = () => {};
  adapter._idToPath = (id) => (id === 'FILE9' ? '/library/gd-test' : null);
  adapter.drive = { files: { list: async () => ({ data: { files: [
    { id: 'FILE9', name: 'gd-test', mimeType: 'application/json', owners: [], modifiedTime: null },
  ] } }) } };
  const { results } = await adapter.search({ scope: '/', nameContains: 'gd-test' });
  assert.equal(results[0].path, '/library/gd-test');
  assert.equal(results[0].id, 'FILE9');
});

// ─── writeBatch: duplicate-parent-folder guard (bug bulkuploadserial) ──
// Google Drive permits same-named siblings, so unserialized concurrent
// writes to /a/b/f1 + /a/b/f2 can each create their own /a/b. writeBatch
// pre-ensures the UNIQUE parent set once through the locked _ensureParentDirs,
// so a batch sharing a brand-new parent creates that parent EXACTLY once.

test('writeBatch: a shared new parent is created exactly once across the batch', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  const adapter = new GoogleDriveAdapter();
  adapter.connection = {};                 // My Drive shape — no drive_id branches
  adapter._ensureAuth = () => {};
  adapter._folderLocks = new Map();
  adapter._lockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aifs-lock-'));
  adapter._getRootId = async () => 'root'; // avoid a live root lookup
  adapter._resolvePathToId = async () => null; // nothing pre-exists (all new)

  const created = { folders: [], files: [] };
  adapter.drive = {
    files: {
      // folder-existence query inside _ensureParentDirsInner → always "absent"
      list: async () => ({ data: { files: [] } }),
      create: async (params) => {
        const body = params.requestBody;
        if (body.mimeType === 'application/vnd.google-apps.folder') {
          created.folders.push(body.name);
          return { data: { id: 'folder-' + body.name, mimeType: body.mimeType } };
        }
        created.files.push(body.name);
        return { data: { id: 'file-' + body.name, mimeType: 'text/plain', headRevisionId: 'r' } };
      },
      // committedSize()/verify path: size absent → "cannot confirm" (no false failure)
      get: async () => ({ data: {} }),
      update: async () => ({ data: { id: 'x', mimeType: 'text/plain', headRevisionId: 'r' } }),
    },
  };

  const res = await adapter.writeBatch([
    { path: '/a/b/f1.md', content: 'one' },
    { path: '/a/b/f2.md', content: 'two' },
    { path: '/a/b/f3.md', content: 'three' },
  ]);

  // The shared parents /a and /a/b are each created ONCE despite 3 files.
  assert.equal(created.folders.filter((n) => n === 'a').length, 1);
  assert.equal(created.folders.filter((n) => n === 'b').length, 1);
  // All three files were written.
  assert.equal(res.succeeded, 3);
  assert.equal(res.failed, 0);
  assert.equal(created.files.length, 3);

  await fs.rm(adapter._lockDir, { recursive: true, force: true });
});

// ─── list: rootsilent (non-member empty root must fail loud) ──────────

test('list: a non-Drive-member empty root listing fails loud (rootsilent)', async () => {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = { drive_id: 'DRIVE1' };
  adapter._ensureAuth = () => {};
  adapter._resolvePathToId = async () => 'DRIVE1';           // "/" resolves to the drive root
  adapter._listParams = async () => ({ corpora: 'drive', driveId: 'DRIVE1', includeItemsFromAllDrives: true, supportsAllDrives: true });
  adapter._detectDriveMembership = async () => false;         // NOT a drive member
  adapter.drive = { files: { list: async () => ({ data: { files: [] } }) } };
  await assert.rejects(
    () => adapter.list('/'),
    (err) => err.code === 'AIFS_ROOT_NOT_ENUMERABLE'
  );
});

test('list: a Drive-member empty root listing returns [] normally (no false alarm)', async () => {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = { drive_id: 'DRIVE1' };
  adapter._ensureAuth = () => {};
  adapter._resolvePathToId = async () => 'DRIVE1';
  adapter._listParams = async () => ({ corpora: 'drive', driveId: 'DRIVE1', includeItemsFromAllDrives: true, supportsAllDrives: true });
  adapter._detectDriveMembership = async () => true;          // IS a drive member
  adapter.drive = { files: { list: async () => ({ data: { files: [] } }) } };
  const out = await adapter.list('/');
  assert.deepEqual(out, []);
});

// ─── getPermissions: owner role (bug getpermsownerwriter) ─────────────
// A My-Drive-hosted item's owner must surface with a literal `owner` role,
// NOT `writer`. Verification logic keys on `owner` to find the true owner.
// reader/writer mappings are unchanged; Shared-Drive items never carry an
// `owner` permission (ownership is the drive's → organizer → writer).

function permsAdapter(permissions, connection = {}) {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = connection;
  adapter._ensureAuth = () => {};
  adapter._resolvePathToId = async () => 'file-1';
  adapter._lastPermsFields = null;
  adapter.drive = {
    permissions: {
      list: async (params) => {
        adapter._lastPermsFields = params?.fields ?? null;
        return { data: { permissions } };
      },
    },
  };
  return adapter;
}

test('getPermissions: My-Drive owner (role:"owner") surfaces as owner, not writer', async () => {
  const adapter = permsAdapter([
    { id: 'p1', emailAddress: 'owner@x', type: 'user', role: 'owner' },
    { id: 'p2', emailAddress: 'collab@x', type: 'user', role: 'writer' },
    { id: 'p3', emailAddress: 'viewer@x', type: 'user', role: 'reader' },
  ]);
  const { permissions } = await adapter.getPermissions('/doc.md');
  const byEmail = Object.fromEntries(permissions.map((p) => [p.subject, p.role]));
  assert.equal(byEmail['owner@x'], 'owner');  // bug getpermsownerwriter: was 'writer'
  assert.equal(byEmail['collab@x'], 'writer'); // unchanged
  assert.equal(byEmail['viewer@x'], 'reader'); // unchanged
});

test('getPermissions: does NOT request the invalid `owner` permission field (getpermsinvalidownerfield guard)', async () => {
  const adapter = permsAdapter([
    { id: 'p1', emailAddress: 'owner@x', type: 'user', role: 'owner' },
  ]);
  const { permissions } = await adapter.getPermissions('/doc.md');
  assert.equal(permissions[0].role, 'owner'); // owner still detected via role
  // The Drive v3 *permission* resource has NO `owner` field; requesting it makes
  // permissions.list fail with "Invalid field selection owner" (2.11.0 regression).
  assert.ok(adapter._lastPermsFields, 'fields selector should have been recorded');
  assert.ok(
    !/permissions\([^)]*\bowner\b/.test(adapter._lastPermsFields),
    'fields selector must not request the invalid `owner` permission field'
  );
});

test('getPermissions: Shared-Drive item has no owner (organizer → writer, unchanged)', async () => {
  const adapter = permsAdapter(
    [{ id: 'p1', emailAddress: 'mgr@x', type: 'user', role: 'organizer' }],
    { drive_id: 'DRIVE1' }
  );
  const { permissions } = await adapter.getPermissions('/doc.md');
  assert.equal(permissions[0].role, 'writer'); // organizer still collapses to writer
});


// ─── getPermissions: direct grant layered on inherited access (getpermsinheritedmask) ───
// Drive returns ONE permission per principal with permissionDetails[] listing each
// source. A direct writer on top of an inherited reader must surface as TWO entries.

test('getPermissions: direct writer + inherited reader on the same principal → two entries', async () => {
  const adapter = permsAdapter(
    [{
      id: 'g1', emailAddress: 'all@x', type: 'group', role: 'writer',
      permissionDetails: [
        { permissionType: 'file', role: 'reader', inherited: true, inheritedFrom: 'SHARED-ID' },
        { permissionType: 'file', role: 'writer', inherited: false },
      ],
    }],
    { drive_id: 'DRIVE1' }
  );
  adapter.pathCache = new Map([['/shared', { id: 'SHARED-ID' }]]);
  const { permissions } = await adapter.getPermissions('/shared/projects/');
  const direct = permissions.find((p) => p.inherited_from === null);
  const inh = permissions.find((p) => p.inherited_from !== null);
  assert.ok(direct, 'the direct grant must be reported');
  assert.equal(direct.role, 'writer');
  assert.equal(direct.subject, 'all@x');
  assert.ok(inh, 'the inherited grant must still be reported');
  assert.equal(inh.role, 'reader');
  assert.equal(inh.inherited_from, '/shared');
});

test('getPermissions: includeInherited:false keeps the direct grant of a mixed permission', async () => {
  const adapter = permsAdapter(
    [{
      id: 'g1', emailAddress: 'all@x', type: 'group', role: 'writer',
      permissionDetails: [
        { permissionType: 'file', role: 'reader', inherited: true, inheritedFrom: 'SHARED-ID' },
        { permissionType: 'file', role: 'writer', inherited: false },
      ],
    }],
    { drive_id: 'DRIVE1' }
  );
  const { permissions } = await adapter.getPermissions('/x/', { includeInherited: false });
  assert.equal(permissions.length, 1);
  assert.equal(permissions[0].role, 'writer');
  assert.equal(permissions[0].inherited_from, null);
});

test('getPermissions: purely inherited permission → one inherited entry (unchanged)', async () => {
  const adapter = permsAdapter(
    [{
      id: 'g1', emailAddress: 'all@x', type: 'group', role: 'reader',
      permissionDetails: [{ permissionType: 'file', role: 'reader', inherited: true, inheritedFrom: 'SHARED-ID' }],
    }],
    { drive_id: 'DRIVE1' }
  );
  const { permissions } = await adapter.getPermissions('/x/');
  assert.equal(permissions.length, 1);
  assert.equal(permissions[0].role, 'reader');
  assert.ok(permissions[0].inherited_from);
  const none = await adapter.getPermissions('/x/', { includeInherited: false });
  assert.equal(none.permissions.length, 0);
});

test('getPermissions: duplicate sources (file + member detail) are de-duplicated', async () => {
  const adapter = permsAdapter(
    [{
      id: 'u1', emailAddress: 'mgr@x', type: 'user', role: 'organizer',
      permissionDetails: [
        { permissionType: 'member', role: 'organizer', inherited: true, inheritedFrom: 'DRIVE1' },
        { permissionType: 'file', role: 'organizer', inherited: true, inheritedFrom: 'DRIVE1' },
      ],
    }],
    { drive_id: 'DRIVE1' }
  );
  const { permissions } = await adapter.getPermissions('/x/');
  assert.equal(permissions.length, 1);
  assert.equal(permissions[0].role, 'writer');
});

// AIFS:FILE-END (in a JS comment, the test file practices the standard:)
// AIFS:FILE-END

// ─── crossorgpath (2.11.3): drive-root fallback scoped to this org's drive ──

function nonMemberResolver(globalFiles) {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = { drive_id: 'DRIVE_A' };
  adapter._ensureAuth = () => {};
  adapter._detectDriveMembership = async () => false;
  adapter._withAutoRefresh = (fn) => fn();
  const queries = [];
  adapter.drive = {
    files: {
      list: async (params) => {
        queries.push(params);
        if (params.corpora === 'allDrives') return { data: { files: globalFiles } };
        return { data: { files: [] } }; // "'DRIVE_A' in parents" is empty for a non-member
      },
    },
  };
  return { adapter, queries };
}

test('resolve: single same-named match in ANOTHER drive is ignored (crossorgpath)', async () => {
  const { adapter } = nonMemberResolver([
    { id: 'OTHER-CORE', name: 'agent-index-core', driveId: 'DRIVE_B', parents: ['DRIVE_B'] },
  ]);
  assert.equal(await adapter._resolvePathToId('/agent-index-core'), null);
  assert.equal(adapter.pathCache.get('/agent-index-core'), undefined);
});

test('resolve: in-drive match wins over same-named matches elsewhere', async () => {
  const { adapter, queries } = nonMemberResolver([
    { id: 'OTHER-CORE', name: 'agent-index-core', driveId: 'DRIVE_B', parents: ['DRIVE_B'] },
    { id: 'MY-CORE', name: 'agent-index-core', driveId: 'DRIVE_A' },
    { id: 'STRAY', name: 'agent-index-core' }, // My Drive, no driveId
  ]);
  assert.equal(await adapter._resolvePathToId('/agent-index-core'), 'MY-CORE');
  const fb = queries.find((q) => q.corpora === 'allDrives');
  assert.match(fb.fields, /driveId/);
});

test('resolve: single in-drive match with invisible parent is still accepted', async () => {
  const { adapter } = nonMemberResolver([{ id: 'MY-CORE', name: 'agent-index-core', driveId: 'DRIVE_A' }]);
  assert.equal(await adapter._resolvePathToId('/agent-index-core'), 'MY-CORE');
});

test('resolve: several in-drive matches tie-break on parent, else fail loud', async () => {
  const two = [
    { id: 'ROOT-ONE', name: 'shared', driveId: 'DRIVE_A', parents: ['DRIVE_A'] },
    { id: 'NESTED', name: 'shared', driveId: 'DRIVE_A', parents: ['SOMEFOLDER'] },
  ];
  assert.equal(await nonMemberResolver(two).adapter._resolvePathToId('/shared'), 'ROOT-ONE');
  const amb = [
    { id: 'X1', name: 'shared', driveId: 'DRIVE_A' },
    { id: 'X2', name: 'shared', driveId: 'DRIVE_A' },
  ];
  await assert.rejects(() => nonMemberResolver(amb).adapter._resolvePathToId('/shared'), /Ambiguous path segment/);
});

// ─── readencodingignored (2.11.3) ────────────────────────────────────

test('read: encoding:"base64" returns base64: form even for text content', async () => {
  const { adapter } = mockAdapter({ getImpls: [() => media('hello')] });
  assert.equal(await adapter.read('/x.txt', { encoding: 'base64' }), 'base64:' + Buffer.from('hello').toString('base64'));
  const { adapter: a2 } = mockAdapter({ getImpls: [() => media('hello')] });
  assert.equal(await a2.read('/x.txt'), 'hello');
});

// ─── xferitemdrive (2.11.4): ownership transfer decided by the item's drive ──

function xferAdapter({ itemDriveId = undefined, mimeType = 'application/vnd.google-apps.folder', children = {}, failIds = [] } = {}) {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = { drive_id: 'ORG_DRIVE' }; // a Shared-Drive org
  adapter._ensureAuth = () => {};
  adapter._withAutoRefresh = (fn) => fn();
  adapter._resolvePathToId = async () => 'ROOT';
  const created = [];
  adapter.drive = {
    files: {
      get: async () => ({ data: { id: 'ROOT', mimeType, driveId: itemDriveId } }),
      list: async (p) => {
        const parent = /'([^']+)' in parents/.exec(p.q)[1];
        return { data: { files: children[parent] || [] } };
      },
    },
    permissions: {
      create: async (p) => {
        if (failIds.includes(p.fileId)) { const e = new Error('nope'); e.code = 500; throw e; }
        created.push(p.fileId);
        return { data: {} };
      },
    },
  };
  return { adapter, created };
}

test('transferOwnership: My-Drive folder on a Shared-Drive org transfers folder + owned contents', async () => {
  const { adapter, created } = xferAdapter({
    children: {
      ROOT: [
        { id: 'DOC', mimeType: 'text/markdown', ownedByMe: true },
        { id: 'META', mimeType: 'application/json', ownedByMe: true },
        { id: 'ASSETS', mimeType: 'application/vnd.google-apps.folder', ownedByMe: true },
        { id: 'NOTMINE', mimeType: 'text/plain', ownedByMe: false },
      ],
      ASSETS: [{ id: 'IMG', mimeType: 'image/png', ownedByMe: true }],
    },
  });
  const r = await adapter.transferOwnership('id:ROOT', 'new@x.com');
  assert.deepEqual(created, ['ROOT', 'DOC', 'META', 'ASSETS', 'IMG']);
  assert.equal(r.items, 5);
  assert.equal(r.partial, undefined);
});

test('transferOwnership: an item inside a Shared Drive is NOT_IMPLEMENTED', async () => {
  const { adapter, created } = xferAdapter({ itemDriveId: 'ORG_DRIVE' });
  await assert.rejects(() => adapter.transferOwnership('id:ROOT', 'new@x.com'), (e) => e.code === 'NOT_IMPLEMENTED');
  assert.deepEqual(created, []);
});

test('transferOwnership: a failing child is reported, the item itself still transfers', async () => {
  const { adapter } = xferAdapter({
    children: { ROOT: [{ id: 'DOC', mimeType: 'text/markdown', ownedByMe: true }] },
    failIds: ['DOC'],
  });
  const r = await adapter.transferOwnership('id:ROOT', 'new@x.com');
  assert.equal(r.partial, true);
  assert.equal(r.failed_items[0].id, 'DOC');
});

test('stat: returns drive_id (null for My Drive)', async () => {
  const { adapter } = mockAdapter({ getImpls: [() => ({ data: { size: '3', driveId: 'SD1' } }), () => ({ data: { size: '3' } })] });
  adapter.connection = { drive_id: 'SD1' };
  adapter._withAutoRefresh = (fn) => fn();
  assert.equal((await adapter.stat('/a')).drive_id, 'SD1');
  assert.equal((await adapter.stat('/b')).drive_id, null);
});

test('getPermissions: a 403 names the read, not "share" (permsverb)', async () => {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = {};
  adapter._ensureAuth = () => {};
  adapter._withAutoRefresh = (fn) => fn();
  adapter._resolvePathToId = async () => 'F';
  adapter.drive = { permissions: { list: async () => { const e = new Error('denied'); e.code = 403; throw e; } } };
  await assert.rejects(() => adapter.getPermissions('id:F'), (e) => e.code === 'ACCESS_DENIED' && /read permissions of/.test(e.message));
});

// ─── getAuthStatus: refresh-failure classification (a1c4) ─────────────

function authAdapter(refreshImpl, writeImpl) {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = {};
  adapter.tokens = { access_token: 'a', refresh_token: 'r', expiry_date: Date.now() - 1000 };
  adapter.oauth2Client = { refreshAccessToken: refreshImpl, setCredentials: () => {} };
  adapter._writeCredential = writeImpl ?? (async () => {});
  adapter._getUserEmail = async () => 'me@x.com';
  return adapter;
}
const errWith = (props) => Object.assign(new Error(props.message || 'boom'), props);

test('authStatus: invalid_grant → reason "expired" + detail', async () => {
  const a = authAdapter(async () => {
    throw errWith({ message: 'invalid_grant', response: { status: 400, data: { error: 'invalid_grant' } } });
  });
  const s = await a.getAuthStatus();
  assert.equal(s.authenticated, false);
  assert.equal(s.reason, 'expired');
  assert.match(s.detail, /invalid_grant/);
});

test('authStatus: DNS / timeout failures → "network_error", never "expired"', async () => {
  for (const e of [
    errWith({ message: 'getaddrinfo ENOTFOUND oauth2.googleapis.com', code: 'ENOTFOUND' }),
    errWith({ message: 'request failed', cause: { code: 'ETIMEDOUT' } }),
  ]) {
    const s = await authAdapter(async () => { throw e; }).getAuthStatus();
    assert.equal(s.authenticated, false);
    assert.equal(s.reason, 'network_error');
  }
});

test('authStatus: TLS / proxy failures → "tls_or_proxy_error"', async () => {
  for (const e of [
    errWith({ message: 'self-signed certificate in certificate chain', code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
    errWith({ message: 'unable to get local issuer certificate', code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }),
    errWith({ message: 'Proxy Authentication Required', response: { status: 407 } }),
  ]) {
    const s = await authAdapter(async () => { throw e; }).getAuthStatus();
    assert.equal(s.reason, 'tls_or_proxy_error');
  }
});

test('authStatus: credential file write failure → "credential_write_failed"', async () => {
  const a = authAdapter(
    async () => ({ credentials: { access_token: 'new', refresh_token: 'r', expiry_date: Date.now() + 3600e3 } }),
    async () => { throw errWith({ message: 'EROFS: read-only file system', code: 'EROFS' }); },
  );
  const s = await a.getAuthStatus();
  assert.equal(s.authenticated, false);
  assert.equal(s.reason, 'credential_write_failed');
  assert.match(s.detail, /EROFS/);
});

test('authStatus: unrecognised failure → "refresh_failed" with the message', async () => {
  const s = await authAdapter(async () => { throw new Error('clock skew weirdness'); }).getAuthStatus();
  assert.equal(s.reason, 'refresh_failed');
  assert.match(s.detail, /clock skew weirdness/);
});

test('authStatus: successful refresh still reports authenticated', async () => {
  const a = authAdapter(async () => ({ credentials: { access_token: 'n', refresh_token: 'r', expiry_date: Date.now() + 3600e3 } }));
  const s = await a.getAuthStatus();
  assert.equal(s.authenticated, true);
  assert.equal(s.user_identity, 'me@x.com');
});

test('_refreshToken: still throws NOT_AUTHENTICATED, tagged with the cause', async () => {
  const a = authAdapter(async () => { throw errWith({ message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' }); });
  await assert.rejects(() => a._refreshToken(),
    (e) => e.code === 'NOT_AUTHENTICATED' && e.details.refresh_reason === 'network_error');
});

// ─── delete: Shared-Drive trash fallback on 403 (52e2) ────────────────

function deleteAdapter({ deleteStatus, trashImpl }) {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = { drive_id: 'SD1' };
  adapter._ensureAuth = () => {};
  adapter._withAutoRefresh = (fn) => fn();
  adapter._resolvePathToId = async () => 'F';
  const calls = { delete: 0, update: [] };
  adapter.drive = {
    files: {
      delete: async () => { calls.delete++; throw errWith({ message: 'nope', code: deleteStatus }); },
      update: async (params) => { calls.update.push(params); return (trashImpl ?? (() => ({ data: {} })))(params); },
    },
  };
  return { adapter, calls };
}

test('delete: Shared-Drive writer gets 403 on delete → trashes instead', async () => {
  const { adapter, calls } = deleteAdapter({ deleteStatus: 403 });
  await adapter.delete('/shared/members/artifacts/h/x.txt');
  assert.equal(calls.delete, 1);
  assert.equal(calls.update.length, 1);
  assert.deepEqual(calls.update[0].requestBody, { trashed: true });
});

test('delete: 403 on delete AND on trash → ACCESS_DENIED with organizer/contentManager guidance', async () => {
  const { adapter } = deleteAdapter({
    deleteStatus: 403,
    trashImpl: () => { throw errWith({ message: 'insufficient', code: 403 }); },
  });
  await assert.rejects(() => adapter.delete('/shared/x.txt'),
    (e) => e.code === 'ACCESS_DENIED' && /delete or trash/.test(e.message) && /contentManager/.test(e.message));
});

test('delete: 404 on delete still trashes (unchanged)', async () => {
  const { adapter, calls } = deleteAdapter({ deleteStatus: 404 });
  await adapter.delete('/shared/x.txt');
  assert.equal(calls.update.length, 1);
});

// ─── read: stale cached id (d5f1) ─────────────────────────────────────

test('read: 404 on a cached id drops the entry, re-resolves, retries once', async () => {
  const { adapter } = mockAdapter({});
  delete adapter._resolvePathToId; // use the real resolver; stub the walk below
  adapter.pathCache.set('/doc.md', { id: 'STALE', mimeType: 'text/plain' });
  let walks = 0;
  adapter._getRootId = async () => 'ROOT';
  adapter._withAutoRefresh = (fn) => fn();
  adapter.drive.files.list = async () => { walks++; return { data: { files: [{ id: 'FRESH', name: 'doc.md', mimeType: 'text/plain', parents: ['ROOT'] }] } }; };
  const seen = [];
  adapter.drive.files.get = async (params) => {
    if (params.alt === 'media') seen.push(params.fileId);
    if (params.fileId === 'STALE') throw errWith({ message: 'File not found', code: 404 });
    return params.fields ? { data: {} } : media('fresh content');
  };
  assert.equal(await adapter.read('/doc.md'), 'fresh content');
  assert.deepEqual(seen, ['STALE', 'FRESH']);
  assert.equal(walks, 1);
  assert.equal(adapter.pathCache.get('/doc.md').id, 'FRESH');
});

test('read: 404 without a cache hit is FILE_NOT_FOUND with no retry', async () => {
  const { adapter } = mockAdapter({ getImpls: [() => { throw errWith({ message: 'gone', code: 404 }); }] });
  let resolves = 0;
  adapter._resolvePathToId = async () => { resolves++; return 'F'; };
  await assert.rejects(() => adapter.read('/x.md'), (e) => e.code === 'FILE_NOT_FOUND');
  assert.equal(resolves, 1);
});

test('read: 404 persists after re-resolve → FILE_NOT_FOUND (retried only once)', async () => {
  const { adapter } = mockAdapter({ getImpls: [() => { throw errWith({ message: 'gone', code: 404 }); }] });
  adapter.pathCache.set('/x.md', { id: 'F', mimeType: 'text/plain' });
  let resolves = 0;
  adapter._resolvePathToId = async (p) => { resolves++; adapter.pathCache.set('/x.md', { id: 'F' }); return 'F'; };
  await assert.rejects(() => adapter.read('/x.md'), (e) => e.code === 'FILE_NOT_FOUND');
  assert.equal(resolves, 2);
});
