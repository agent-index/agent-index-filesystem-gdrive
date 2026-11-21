// CI-025 (2.12.0): org path seeding — unit tests (technical design §13, gdrive).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleDriveAdapter } from './gdrive.js';

const FOLDER = 'application/vnd.google-apps.folder';

// A tiny fake Drive: items keyed by id with a parent and name.
function fakeAdapter(items, { driveId = 'DRIVE', member = false } = {}) {
  const adapter = new GoogleDriveAdapter();
  adapter.connection = { drive_id: driveId };
  adapter._ensureAuth = () => {};
  adapter._withAutoRefresh = (fn) => fn();
  adapter._detectDriveMembership = async () => member;
  adapter._listParams = async () => ({});
  adapter._getRootId = async () => driveId;
  const queries = [];
  let created = 0;
  adapter.drive = {
    files: {
      list: async (params) => {
        queries.push(params);
        const q = params.q || '';
        const parent = /'([^']+)' in parents/.exec(q)?.[1];
        const name = /name = '([^']+)'/.exec(q)?.[1];
        if (!parent && params.corpora === 'allDrives') {
          // the drive-wide name search (the non-member root fallback)
          return { data: { files: items.filter((f) => f.name === name).map((f) => ({ ...f, driveId })) } };
        }
        const files = items.filter((f) => f.parent === parent && (!name || f.name === name)
          && (!q.includes("mimeType = 'application/vnd.google-apps.folder'") || f.mimeType === FOLDER));
        return { data: { files } };
      },
      create: async (params) => {
        const id = `NEW${++created}`;
        items.push({ id, name: params.requestBody.name, parent: params.requestBody.parents[0], mimeType: params.requestBody.mimeType || 'text/plain' });
        return { data: { id, mimeType: params.requestBody.mimeType || 'text/plain' } };
      },
    },
  };
  return { adapter, queries, items };
}

const ITEMS = [
  { id: 'SR', name: 'shared', parent: 'DRIVE', mimeType: FOLDER },
  { id: 'A', name: 'a', parent: 'SR', mimeType: FOLDER },
  { id: 'B', name: 'b.json', parent: 'A', mimeType: 'application/json' },
  { id: 'PRJ', name: 'projects', parent: 'DRIVE', mimeType: FOLDER },
  { id: 'API', name: 'api', parent: 'PRJ', mimeType: FOLDER },
  { id: 'PULSE', name: 'project-pulse.md', parent: 'API', mimeType: 'text/markdown' },
];
const PREFIXES = {
  '/shared': { id: 'SR', kind: 'folder' },
  '/projects': { id: 'PRJ', kind: 'folder' },
  '/org-config.json': { id: 'OC', kind: 'file' },
};

const touchesRoot = (queries) => queries.some((p) => (p.q || '').includes("'DRIVE' in parents") || p.corpora === 'allDrives');

test('a non-member resolves seeded org paths without any drive-root query', async () => {
  const { adapter, queries } = fakeAdapter([...ITEMS]);
  adapter.seedOrgPrefixes(PREFIXES);
  assert.equal(await adapter._resolvePathToId('/shared/a/b.json'), 'B');
  assert.equal(await adapter._resolvePathToId('/projects/api/project-pulse.md'), 'PULSE');
  assert.equal(await adapter._resolvePathToId('/org-config.json'), 'OC');
  assert.equal(touchesRoot(queries), false);
});

test('without seeding, the same non-member path walks the drive root (today\'s behaviour)', async () => {
  const { adapter, queries } = fakeAdapter([...ITEMS]);
  await adapter._resolvePathToId('/shared/a/b.json');
  assert.equal(touchesRoot(queries), true);
});

test('creating a folder under a seeded prefix walks from the seed, not the root', async () => {
  const { adapter, queries, items } = fakeAdapter([...ITEMS]);
  adapter.seedOrgPrefixes(PREFIXES);
  const id = await adapter._ensureParentDirsInner('/shared/new/deeper');
  assert.ok(id);
  const created = items.filter((f) => f.id.startsWith('NEW'));
  assert.deepEqual(created.map((f) => [f.name, f.parent]), [['new', 'SR'], ['deeper', created[0].id]]);
  assert.equal(touchesRoot(queries), false);
});

test('re-seeding a prefix with a new id purges entries cached under the old folder', async () => {
  const { adapter } = fakeAdapter([...ITEMS]);
  adapter.seedOrgPrefixes(PREFIXES);
  await adapter._resolvePathToId('/projects/api/project-pulse.md');
  assert.equal(adapter.pathCache.get('/projects/api').id, 'API');
  adapter.seedOrgPrefixes({ '/projects': { id: 'PRJ2', kind: 'folder' } });
  assert.equal(adapter.pathCache.get('/projects').id, 'PRJ2');
  assert.equal(adapter.pathCache.has('/projects/api'), false);
  assert.equal(adapter.pathCache.has('/projects/api/project-pulse.md'), false);
  assert.equal(adapter.pathCache.get('/shared').id, 'SR', 'other prefixes untouched');
});

test('seeded folders carry the folder mime type (delete()\'s not-empty check relies on it)', () => {
  const { adapter } = fakeAdapter([...ITEMS]);
  adapter.seedOrgPrefixes(PREFIXES);
  assert.equal(adapter.pathCache.get('/shared').mimeType, FOLDER);
  assert.notEqual(adapter.pathCache.get('/org-config.json').mimeType, FOLDER);
});

test('_idToPath prefers a plain path over an id: key for the same item', () => {
  const { adapter } = fakeAdapter([...ITEMS]);
  adapter.pathCache.set('id:SR/a', { id: 'A', mimeType: FOLDER });
  adapter.pathCache.set('/shared/a', { id: 'A', mimeType: FOLDER });
  assert.equal(adapter._idToPath('A'), '/shared/a');
  adapter.pathCache.delete('/shared/a');
  assert.equal(adapter._idToPath('A'), 'id:SR/a');
});

test('search under a plain scope returns plain paths and caches them', async () => {
  const { adapter } = fakeAdapter([...ITEMS]);
  adapter.seedOrgPrefixes(PREFIXES);
  const out = await adapter.search({ scope: '/shared/a' });
  assert.deepEqual(out.results.map((r) => r.path), ['/shared/a/b.json']);
  assert.equal(out.results[0].id, 'B');
  assert.equal(adapter.pathCache.get('/shared/a/b.json').id, 'B');
});

test('an unseeded top-level name (e.g. /CLAUDE.md) still resolves through the in-drive fallback', async () => {
  const items = [...ITEMS, { id: 'CMD', name: 'CLAUDE.md', parent: 'DRIVE', mimeType: 'text/markdown' }];
  const { adapter } = fakeAdapter(items);
  adapter.seedOrgPrefixes(PREFIXES);
  assert.equal(await adapter._resolvePathToId('/CLAUDE.md'), 'CMD');
});
