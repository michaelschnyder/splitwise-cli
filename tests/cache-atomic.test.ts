import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStagedBatchId,
  emptyCacheManifest,
  finalizeStagedBatch,
  generateBatchId,
  removeCacheRoot,
  saveCacheManifest,
  writeCachePayload,
} from '../src/lib/cache.js';
import { getCacheManifestPath, getCacheRootPath, setConfigDirOverride } from '../src/lib/config.js';

test('createStagedBatchId uses tmp marker and keeps batch prefix', () => {
  const batchId = generateBatchId(1760000000000);
  const staged = createStagedBatchId(batchId);
  assert.equal(staged.startsWith(batchId), true);
  assert.equal(staged.includes('.tmp.'), true);
});

test('saveCacheManifest writes without leaving temp manifest files', () => {
  const root = join(tmpdir(), `splitwise-cli-cache-atomic-${Date.now()}-manifest`);
  setConfigDirOverride(root);

  try {
    const manifest = emptyCacheManifest();
    manifest.entries.push({
      schemaVersion: 1,
      batchId: generateBatchId(),
      entity: 'friends',
      target: 'user',
      profileName: 'default',
      exportedAt: new Date().toISOString(),
      machine: { host: 'test-host', platform: process.platform },
      payloadPath: 'cache/test/friends.json',
    });

    saveCacheManifest('user', manifest);

    const manifestPath = getCacheManifestPath('user');
    const rootPath = getCacheRootPath('user');
    assert.equal(existsSync(manifestPath), true);

    const persisted = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { entries: unknown[] };
    assert.equal(persisted.entries.length, 1);

    const leakedTemps = readdirSync(rootPath).filter((entry) => entry.startsWith('manifest.json.tmp.'));
    assert.deepEqual(leakedTemps, []);
  } finally {
    setConfigDirOverride(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test('finalizeStagedBatch renames staged batch folder to immutable final batch id', () => {
  const root = join(tmpdir(), `splitwise-cli-cache-atomic-${Date.now()}-finalize`);
  setConfigDirOverride(root);

  try {
    const finalBatchId = generateBatchId();
    const stagedBatchId = createStagedBatchId(finalBatchId);

    writeCachePayload('user', stagedBatchId, { entity: 'friends', items: [] });
    finalizeStagedBatch('user', stagedBatchId, finalBatchId);

    const rootPath = getCacheRootPath('user');
    const stagedPath = join(rootPath, 'cache', stagedBatchId);
    const finalPayload = join(rootPath, 'cache', finalBatchId, 'friends.json');

    assert.equal(existsSync(stagedPath), false);
    assert.equal(existsSync(finalPayload), true);
  } finally {
    setConfigDirOverride(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test('removeCacheRoot deletes the cache root directory', () => {
  const root = join(tmpdir(), `splitwise-cli-cache-atomic-${Date.now()}-remove-root`);
  setConfigDirOverride(root);

  try {
    const batchId = generateBatchId();
    writeCachePayload('user', batchId, { entity: 'friends', items: [] });
    removeCacheRoot('user');

    assert.equal(existsSync(getCacheRootPath('user')), false);
  } finally {
    setConfigDirOverride(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
