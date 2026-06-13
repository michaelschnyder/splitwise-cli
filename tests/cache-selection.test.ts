import assert from 'node:assert/strict';
import test from 'node:test';
import { generateBatchId, uncoveredExpenseRanges, type CacheManifestEntry } from '../src/lib/cache.js';

function expenseEntry(input: {
  batchId: string;
  min: string;
  max: string;
}): CacheManifestEntry {
  return {
    schemaVersion: 1,
    batchId: input.batchId,
    entity: 'expenses',
    target: 'local',
    profileName: 'default',
    exportedAt: `${input.max}T00:00:00.000Z`,
    machine: {
      host: 'test-host',
      platform: 'win32',
    },
    coverage: {
      expenseDateMin: input.min,
      expenseDateMax: input.max,
    },
    payloadPath: `batches/${input.batchId}/expenses.json`,
  };
}

test('generateBatchId emits lower-case ulid-shaped id', () => {
  const id = generateBatchId(1760000000000);
  assert.equal(id.length, 26);
  assert.match(id, /^[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
});

test('uncoveredExpenseRanges returns no gaps for full coverage', () => {
  const gaps = uncoveredExpenseRanges([
    expenseEntry({ batchId: 'a', min: '2024-01-01', max: '2024-12-31' }),
  ], {
    from: '2024-02-01',
    to: '2024-05-01',
  });

  assert.deepEqual(gaps, []);
});

test('uncoveredExpenseRanges reports leading and trailing gaps', () => {
  const gaps = uncoveredExpenseRanges([
    expenseEntry({ batchId: 'a', min: '2024-02-01', max: '2024-03-31' }),
    expenseEntry({ batchId: 'b', min: '2024-05-01', max: '2024-05-31' }),
  ], {
    from: '2024-01-01',
    to: '2024-06-30',
  });

  assert.deepEqual(gaps, [
    '2024-01-01 to 2024-01-31',
    '2024-04-01 to 2024-04-30',
    '2024-06-01 to 2024-06-30',
  ]);
});