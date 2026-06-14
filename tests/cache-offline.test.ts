import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCacheEntry,
  emptyCacheManifest,
  resolveOfflineExpenses,
  saveCacheManifest,
  writeCachePayload,
} from '../src/lib/cache.js';
import { setConfigDirOverride } from '../src/lib/config.js';
import { createOfflineSplitwiseClient } from '../src/lib/client-source.js';

async function withTempConfigRoot(run: () => void | Promise<void>): Promise<void> {
  const root = join(tmpdir(), `splitwise-cli-cache-offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  setConfigDirOverride(root);
  try {
    await run();
  } finally {
    setConfigDirOverride(undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

test('offline expense merge uses deterministic mutation-time dedupe', async () => {
  await withTempConfigRoot(() => {
    const payloadOlderMutation = {
      entity: 'expenses' as const,
      items: [{
        id: 100,
        date: '2026-01-15',
        description: 'older mutation but newer export',
        updatedAt: '2026-01-10T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        groupId: null,
        users: [],
        cost: '10.00',
        currencyCode: 'USD',
      }],
    };

    const payloadNewerMutation = {
      entity: 'expenses' as const,
      items: [{
        id: 100,
        date: '2026-01-15',
        description: 'newer mutation and should win',
        updatedAt: '2026-01-20T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        groupId: null,
        users: [],
        cost: '11.00',
        currencyCode: 'USD',
      }],
    };

    const pathA = writeCachePayload('user', 'batch-newer-export', payloadOlderMutation as any);
    const pathB = writeCachePayload('user', 'batch-older-export', payloadNewerMutation as any);

    const manifest = emptyCacheManifest();
    manifest.entries.push(createCacheEntry({
      batchId: 'batch-newer-export',
      entity: 'expenses',
      target: 'user',
      profileName: 'default',
      accountUserId: 1,
      exportedAt: '2026-02-01T00:00:00.000Z',
      scope: { from: '2026-01-01', to: '2026-01-31' },
      payloadPath: pathA,
      payload: payloadOlderMutation as any,
    }));
    manifest.entries.push(createCacheEntry({
      batchId: 'batch-older-export',
      entity: 'expenses',
      target: 'user',
      profileName: 'default',
      accountUserId: 1,
      exportedAt: '2026-01-31T00:00:00.000Z',
      scope: { from: '2026-01-01', to: '2026-01-31' },
      payloadPath: pathB,
      payload: payloadNewerMutation as any,
    }));
    saveCacheManifest('user', manifest);

    const result = resolveOfflineExpenses('user', 1, { from: '2026-01-01', to: '2026-01-31' }, 'default');
    assert.equal(result.expenses.length, 1);
    assert.equal(result.expenses[0].description, 'newer mutation and should win');
  });
});

test('offline expenses list throws actionable message when cache is missing', async () => {
  await withTempConfigRoot(() => {
    const client = createOfflineSplitwiseClient({
      target: 'user',
      sourceLabel: 'test-cache-root',
      profileName: 'default',
      profile: {},
      credentialName: 'default',
      credential: { accessToken: 'token', userId: 7, userName: 'Tester' },
    }) as any;

    assert.throws(
      () => client.expenses.list({ from: '2026-01-01', to: '2026-01-31' }),
      /Offline cache miss for expenses[\s\S]*cache add expenses --target user --from 2026-01-01 --to 2026-01-31/,
    );
  });
});

test('offline friends list remains backward-compatible and returns empty list when cache is missing', async () => {
  await withTempConfigRoot(async () => {
    const client = createOfflineSplitwiseClient({
      target: 'user',
      sourceLabel: 'test-cache-root',
      profileName: 'default',
      profile: {},
      credentialName: 'default',
      credential: { accessToken: 'token', userId: 7, userName: 'Tester' },
    }) as any;

    const rows = await client.friends.list();
    assert.deepEqual(rows, []);
  });
});
