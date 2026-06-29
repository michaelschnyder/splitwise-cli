import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Expense } from 'splitwise';
import {
  parseImportFile,
  detectShape,
  normalizeToCreateParams,
  exactMatch,
  intelligentMatch,
  type ImportExpenseRecord,
  type ImportContext,
} from '../src/lib/import.js';
import { startSplitwiseMockServer } from './helpers/mock-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const tsxCli = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntry = resolve(repoRoot, 'src', 'index.ts');

type CliResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function runCli(args: string[], cwd: string, envOverrides: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      resolvePromise({ status: status ?? 1, stdout, stderr });
    });
    child.on('error', rejectPromise);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema detection tests
// ─────────────────────────────────────────────────────────────────────────────

describe('import schema detection', () => {
  it('detects full shape with splits containing userId', () => {
    const record: ImportExpenseRecord = {
      description: 'Dinner',
      cost: '30.00',
      splits: [
        { userId: 1, paidShare: '30', owedShare: '15' },
        { userId: 2, owedShare: '15' },
      ],
    };
    assert.equal(detectShape(record), 'full');
  });

  it('detects simplified shape when splits lack userId', () => {
    const record: ImportExpenseRecord = {
      description: 'Dinner',
      cost: '30.00',
      splits: [{ paidShare: '30', owedShare: '15' }],
    };
    assert.equal(detectShape(record), 'simplified');
  });

  it('detects simplified shape when no splits field', () => {
    const record: ImportExpenseRecord = {
      description: 'Dinner',
      cost: '30.00',
      group: 'Roommates',
    };
    assert.equal(detectShape(record), 'simplified');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// File parsing tests
// ─────────────────────────────────────────────────────────────────────────────

describe('import file parsing', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(__dirname, 'tmp-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it('parses YAML files by extension', () => {
    const yamlFile = join(tmpDir, 'expenses.yaml');
    const content = `
- description: Dinner
  cost: '30.00'
- description: Coffee
  cost: '5.00'
`;
    writeFileSync(yamlFile, content);
    const records = parseImportFile(yamlFile);
    assert.equal(records.length, 2);
    assert.equal(records[0].description, 'Dinner');
  });

  it('parses JSON files by extension', () => {
    const jsonFile = join(tmpDir, 'expenses.json');
    const content = JSON.stringify([
      { description: 'Lunch', cost: '15.00' },
      { description: 'Movie', cost: '25.00' },
    ]);
    writeFileSync(jsonFile, content);
    const records = parseImportFile(jsonFile);
    assert.equal(records.length, 2);
    assert.equal(records[1].description, 'Movie');
  });

  it('auto-detects JSON format on ambiguous extension', () => {
    const txtFile = join(tmpDir, 'expenses.txt');
    const content = JSON.stringify([{ description: 'Test', cost: '10.00' }]);
    writeFileSync(txtFile, content);
    const records = parseImportFile(txtFile);
    assert.equal(records.length, 1);
    assert.equal(records[0].description, 'Test');
  });

  it('throws on malformed file', () => {
    const badFile = join(tmpDir, 'bad.json');
    writeFileSync(badFile, '{ invalid json');
    assert.throws(() => parseImportFile(badFile));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalization tests
// ─────────────────────────────────────────────────────────────────────────────

describe('import normalization', () => {
  it('normalizes full shape record with splits', () => {
    const context: ImportContext = {
      groups: [],
      friends: [],
      meId: 999,
      lookupMap: new Map(),
    };
    const record: ImportExpenseRecord = {
      description: 'Dinner',
      cost: '30.00',
      currency: 'USD',
      date: '2024-01-15',
      splits: [
        { userId: 1, paidShare: '30', owedShare: '15' },
        { userId: 999, owedShare: '15' },
      ],
    };
    const params = normalizeToCreateParams(record, context);
    assert.ok(params);
    assert.equal(params.description, 'Dinner');
    assert.equal(params.cost, '30.00');
    assert.equal(params.currencyCode, 'USD');
    assert.equal(params.date, '2024-01-15');
    assert.equal(params.users?.length, 2);
  });

  it('normalizes simplified shape record with group reference', () => {
    const context: ImportContext = {
      groups: [
        { id: 100, name: 'Roommates' },
        { id: 101, name: 'Trip' },
      ],
      friends: [
        { id: 1, firstName: 'Alice', lastName: 'Smith' },
        { id: 2, firstName: 'Bob', lastName: '' },
      ],
      meId: 999,
      lookupMap: new Map(),
    };
    const record: ImportExpenseRecord = {
      description: 'Group dinner',
      cost: '60.00',
      group: 'Roommates',
      currency: 'USD',
    };
    const params = normalizeToCreateParams(record, context);
    assert.ok(params);
    assert.equal(params.description, 'Group dinner');
    assert.equal(params.groupId, 100);
  });

  it('normalizes case-insensitive group name', () => {
    const context: ImportContext = {
      groups: [
        { id: 100, name: 'Roommates' },
        { id: 101, name: 'Trip' },
      ],
      friends: [],
      meId: 999,
      lookupMap: new Map(),
    };
    const record: ImportExpenseRecord = {
      description: 'Trip activity',
      cost: '50.00',
      group: 'TRIP',
    };
    const params = normalizeToCreateParams(record, context);
    assert.ok(params);
    assert.equal(params.groupId, 101);
  });

  it('returns null for missing required fields', () => {
    const context: ImportContext = {
      groups: [],
      friends: [],
      meId: 999,
      lookupMap: new Map(),
    };
    const record: ImportExpenseRecord = { cost: '30.00' }; // missing description
    const params = normalizeToCreateParams(record, context);
    assert.equal(params, null);
  });

  it('handles optional fields like notes and category', () => {
    const context: ImportContext = {
      groups: [],
      friends: [],
      meId: 999,
      lookupMap: new Map(),
    };
    const record: ImportExpenseRecord = {
      description: 'Lunch',
      cost: '12.00',
      notes: 'With Jane',
      category: 18,
    };
    const params = normalizeToCreateParams(record, context);
    assert.ok(params);
    assert.equal(params.details, 'With Jane');
    assert.equal(params.categoryId, 18);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exact matcher tests
// ─────────────────────────────────────────────────────────────────────────────

describe('exact matcher', () => {
  const candidate = { description: 'Dinner', cost: '30.00', currencyCode: 'USD' };
  const meId = 123;

  it('matches on description, cost, currency when created by me', () => {
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      createdBy: { id: meId },
    } as any;
    assert.ok(exactMatch(candidate, existing, meId));
  });

  it('does not match on different cost', () => {
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '25.00',
      currencyCode: 'USD',
      createdBy: { id: meId },
    } as any;
    assert.ok(!exactMatch(candidate, existing, meId));
  });

  it('does not match when not created by me', () => {
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      createdBy: { id: 999 },
    } as any;
    assert.ok(!exactMatch(candidate, existing, meId));
  });

  it('matches with exact date', () => {
    const withDate = { ...candidate, date: '2024-01-15' };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      date: '2024-01-15',
      createdBy: { id: meId },
    } as any;
    assert.ok(exactMatch(withDate, existing, meId));
  });

  it('does not match on different date', () => {
    const withDate = { ...candidate, date: '2024-01-15' };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      date: '2024-01-16',
      createdBy: { id: meId },
    } as any;
    assert.ok(!exactMatch(withDate, existing, meId));
  });

  it('matches on identical user distribution', () => {
    const withUsers = {
      description: 'Dinner',
      cost: '30.00',
      users: [
        { userId: 1, paidShare: '30', owedShare: '15' },
        { userId: 2, owedShare: '15' },
      ],
    };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      users: [
        { userId: 1, paidShare: '30', owedShare: '15' },
        { userId: 2, owedShare: '15' },
      ],
      createdBy: { id: meId },
    } as any;
    assert.ok(exactMatch(withUsers, existing, meId));
  });

  it('does not match on different user distribution', () => {
    const withUsers = {
      description: 'Dinner',
      cost: '30.00',
      users: [
        { userId: 1, paidShare: '30', owedShare: '20' },
        { userId: 2, owedShare: '10' },
      ],
    };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      users: [
        { userId: 1, paidShare: '30', owedShare: '15' },
        { userId: 2, owedShare: '15' },
      ],
      createdBy: { id: meId },
    } as any;
    assert.ok(!exactMatch(withUsers, existing, meId));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Intelligent matcher tests
// ─────────────────────────────────────────────────────────────────────────────

describe('intelligent matcher', () => {
  const candidate = { description: 'Dinner', cost: '30.00', currencyCode: 'USD' };
  const meId = 123;

  it('matches exactly like exact matcher on perfect data', () => {
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      createdBy: { id: meId },
    } as any;
    assert.ok(intelligentMatch(candidate, existing, meId));
  });

  it('matches with cost digit typo (adjacent key)', () => {
    const candidate_with_typo = { ...candidate, cost: '31.00' }; // 0->1 adjacency
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      createdBy: { id: meId },
    } as any;
    assert.ok(intelligentMatch(candidate_with_typo, existing, meId));
  });

  it('matches with date within ±5 days', () => {
    const withDate = { ...candidate, date: '2024-01-15' };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      date: '2024-01-18',
      createdBy: { id: meId },
    } as any;
    assert.ok(intelligentMatch(withDate, existing, meId));
  });

  it('does not match date >5 days apart without digit typo', () => {
    const withDate = { ...candidate, date: '2024-01-01' };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      date: '2024-01-10',
      createdBy: { id: meId },
    } as any;
    assert.ok(!intelligentMatch(withDate, existing, meId));
  });

  it('matches date digit typo (e.g. 2024-01-16 vs 2024-01-15)', () => {
    const withDate = { ...candidate, date: '2024-01-16' };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      date: '2024-01-15',
      createdBy: { id: meId },
    } as any;
    assert.ok(intelligentMatch(withDate, existing, meId));
  });

  it('does not match multiple digit typos in one date component', () => {
    const withDate = { ...candidate, date: '2024-01-29' };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      date: '2024-01-15',
      createdBy: { id: meId },
    } as any;
    // 29 vs 15: more than 5 days apart and requires 2 digit changes (2->1, 9->5), so shouldn't match
    assert.ok(!intelligentMatch(withDate, existing, meId));
  });

  it('does not match on different description', () => {
    const existing: Expense = {
      id: 1,
      description: 'Lunch',
      cost: '30.00',
      currencyCode: 'USD',
      createdBy: { id: meId },
    } as any;
    assert.ok(!intelligentMatch(candidate, existing, meId));
  });

  it('requires exact currency match', () => {
    const withCurrency = { ...candidate, currencyCode: 'EUR' };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      createdBy: { id: meId },
    } as any;
    assert.ok(!intelligentMatch(withCurrency, existing, meId));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E tests with mock server
// ─────────────────────────────────────────────────────────────────────────────

async function setupE2EEnv(): Promise<{
  tempDir: string;
  configDir: string;
  profileName: string;
  credentialName: string;
  env: NodeJS.ProcessEnv;
  server: Awaited<ReturnType<typeof startSplitwiseMockServer>>;
}> {
  const server = await startSplitwiseMockServer();
  const tempDir = mkdtempSync(join(__dirname, 'tmp-import-'));
  const configDir = join(tempDir, 'config');
  const profileName = `import-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const credentialName = 'e2e-import';
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };

  await runCli(['--config-dir', configDir, 'login', 'token', 'test-token', '--name', credentialName], tempDir, env);
  await runCli([
    '--config-dir', configDir,
    'profiles', 'create', profileName,
    '--profile-credential', credentialName,
    '--preferred-cache-target', 'local',
    '--offline-enabled', 'no',
    '--api-endpoint', server.baseUrl,
  ], tempDir, env);

  return { tempDir, configDir, profileName, credentialName, env, server };
}

async function teardownE2EEnv(ctx: {
  tempDir: string;
  configDir: string;
  profileName: string;
  credentialName: string;
  env: NodeJS.ProcessEnv;
  server: Awaited<ReturnType<typeof startSplitwiseMockServer>>;
}): Promise<void> {
  await runCli(['--config-dir', ctx.configDir, 'profiles', 'remove', ctx.profileName], ctx.tempDir, ctx.env);
  await runCli(['--config-dir', ctx.configDir, 'login', 'remove', ctx.credentialName], ctx.tempDir, ctx.env);
  rmSync(ctx.tempDir, { recursive: true, force: true });
  await ctx.server.close();
}

describe('expenses import E2E', () => {
  it('imports records and creates new expenses', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');
    const content = JSON.stringify([
      {
        description: 'New dinner',
        cost: '50.00',
        date: '2024-01-15',
        currency: 'USD',
        splits: [
          { userId: 123, paidShare: '50', owedShare: '25' },
          { userId: 201, owedShare: '25' },
        ],
      },
    ]);
    writeFileSync(importFile, content);

    try {
      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
      ], ctx.tempDir, ctx.env);

      assert.match(result.stderr, /Created: 1/);
      assert.match(result.stderr, /Skipped: 0/);
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('detects duplicates and skips them', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');
    const content = JSON.stringify([
      {
        description: 'Duplicate dinner',
        cost: '50.00',
        date: '2024-01-15',
        currency: 'USD',
        splits: [
          { userId: 123, paidShare: '50', owedShare: '25' },
          { userId: 201, owedShare: '25' },
        ],
      },
      {
        description: 'Duplicate dinner',
        cost: '50.00',
        date: '2024-01-15',
        currency: 'USD',
        splits: [
          { userId: 123, paidShare: '50', owedShare: '25' },
          { userId: 201, owedShare: '25' },
        ],
      },
    ]);
    writeFileSync(importFile, content);

    try {
      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
      ], ctx.tempDir, ctx.env);

      assert.match(result.stderr, /Created: 1/);
      assert.match(result.stderr, /Skipped: 1/);
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('respects --dry-run flag and does not write any expenses to backend', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');
    const content = JSON.stringify([
      {
        description: 'Dry run test expense 1',
        cost: '25.00',
        date: '2024-01-15',
        currency: 'USD',
        splits: [
          { userId: 123, paidShare: '25', owedShare: '12.50' },
          { userId: 201, owedShare: '12.50' },
        ],
      },
      {
        description: 'Dry run test expense 2',
        cost: '50.00',
        date: '2024-01-16',
        currency: 'USD',
      },
    ]);
    writeFileSync(importFile, content);

    try {
      // Count expenses before dry-run
      const beforeResult = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'list', '--all', '-o', 'json',
      ], ctx.tempDir, ctx.env);
      const beforeExpenses = JSON.parse(beforeResult.stdout);

      // Run import with --dry-run
      const dryRunResult = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile, '--dry-run',
      ], ctx.tempDir, ctx.env);

      // Verify dry-run warning message
      assert.match(dryRunResult.stderr, /Dry-run mode: no changes written/);
      assert.match(dryRunResult.stderr, /Created: 2/);

      // Count expenses after dry-run
      const afterResult = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'list', '--all', '-o', 'json',
      ], ctx.tempDir, ctx.env);
      const afterExpenses = JSON.parse(afterResult.stdout);

      // Verify that NO expenses were created (count should be identical)
      assert.equal(
        afterExpenses.length,
        beforeExpenses.length,
        `Expected ${beforeExpenses.length} expenses before and after dry-run, but got ${afterExpenses.length} after`,
      );

      // Verify the descriptions from the import file do NOT exist
      const descriptions = afterExpenses.map((e: any) => e.description);
      assert.ok(
        !descriptions.includes('Dry run test expense 1'),
        'Expense 1 should not be created during dry-run',
      );
      assert.ok(
        !descriptions.includes('Dry run test expense 2'),
        'Expense 2 should not be created during dry-run',
      );
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('respects --dry-run with --on-duplicate=update and does not modify existing expenses', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');

    // First, create an expense
    const createResult = await runCli([
      '--config-dir', ctx.configDir,
      '--profile', ctx.profileName,
      'expenses', 'add',
      '-d', 'Original expense',
      '-a', '30.00',
      '--date', '2024-01-15',
      '-C', 'USD',
    ], ctx.tempDir, ctx.env);

    // Extract expense ID from the output (format: "id                 123456789")
    const idMatch = createResult.stdout.match(/^id\s+(\d+)/m);
    assert.ok(idMatch, 'Could not find expense ID in add output');
    const expenseIdToUpdate = idMatch[1];

    // Prepare import file with modified version of the same expense (exact match)
    const content = JSON.stringify([
      {
        description: 'Original expense',
        cost: '50.00',
        date: '2024-01-15',
        currency: 'USD',
      },
    ]);
    writeFileSync(importFile, content);

    try {
      // Get expense details before dry-run
      const beforeUpdateResult = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'get', expenseIdToUpdate, '-o', 'json',
      ], ctx.tempDir, ctx.env);
      const beforeUpdate = JSON.parse(beforeUpdateResult.stdout);
      const costBefore = beforeUpdate.cost;

      // Run import with --dry-run --on-duplicate=update
      const dryRunUpdateResult = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile, '--dry-run', '--on-duplicate', 'update',
      ], ctx.tempDir, ctx.env);

      // Verify the command succeeded and showed dry-run warning
      assert.match(dryRunUpdateResult.stderr, /Dry-run mode: no changes written/);
      // In dry-run with duplicate matched, it should be skipped (not updated)
      assert.match(dryRunUpdateResult.stderr, /Updated: 0/);

      // Get expense details after dry-run
      const afterUpdateResult = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'get', expenseIdToUpdate, '-o', 'json',
      ], ctx.tempDir, ctx.env);
      const afterUpdate = JSON.parse(afterUpdateResult.stdout);
      const costAfter = afterUpdate.cost;

      // Verify that the expense was NOT modified (cost should remain 30.00)
      assert.equal(
        costAfter,
        costBefore,
        `Cost should not be updated during dry-run. Before: ${costBefore}, After: ${costAfter}`,
      );
    } finally {
      await teardownE2EEnv(ctx);
    }
  });
});
