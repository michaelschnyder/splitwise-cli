import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
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

  it('resolves group on full-shape records', () => {
    const context: ImportContext = {
      groups: [
        { id: 99530723, name: 'SK Test' },
      ],
      friends: [],
      meId: 999,
      lookupMap: new Map(),
    };

    const byName: ImportExpenseRecord = {
      description: 'Korean online booking',
      cost: '212.63',
      group: 'SK Test',
      splits: [
        { userId: 999, paidShare: '212.63', owedShare: '53.16' },
        { userId: 123, paidShare: '0.00', owedShare: '53.16' },
      ],
    };
    const byId: ImportExpenseRecord = {
      description: 'Tada - Rebekka+Me',
      cost: '39.07',
      group: 99530723,
      splits: [
        { userId: 999, paidShare: '39.07', owedShare: '19.54' },
        { userId: 123, paidShare: '0.00', owedShare: '19.54' },
      ],
    };

    const paramsByName = normalizeToCreateParams(byName, context);
    const paramsById = normalizeToCreateParams(byId, context);

    assert.ok(paramsByName);
    assert.ok(paramsById);
    assert.equal(paramsByName.groupId, 99530723);
    assert.equal(paramsById.groupId, 99530723);
    assert.equal(paramsByName.users?.length, 2);
    assert.equal(paramsById.users?.length, 2);
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

  it('resolves category name via category lookup context', () => {
    const context: ImportContext = {
      groups: [],
      friends: [],
      categories: [
        { id: 11, name: 'Liquor' },
        { id: 12, name: 'Taxi' },
      ],
      meId: 999,
      lookupMap: new Map(),
    };
    const record: ImportExpenseRecord = {
      description: 'Airport ride',
      cost: '39.07',
      category: 'Taxi',
    };
    const params = normalizeToCreateParams(record, context);
    assert.ok(params);
    assert.equal(params.categoryId, 12);
  });

  it('resolves category by unique substring', () => {
    const context: ImportContext = {
      groups: [],
      friends: [],
      categories: [
        { id: 21, name: 'Transportation - Taxi' },
        { id: 22, name: 'Transportation - Other' },
      ],
      meId: 999,
      lookupMap: new Map(),
    };
    const record: ImportExpenseRecord = {
      description: 'Airport ride',
      cost: '39.07',
      category: 'Taxi',
    };
    const params = normalizeToCreateParams(record, context);
    assert.ok(params);
    assert.equal(params.categoryId, 21);
  });

  it('does not resolve category when substring is ambiguous', () => {
    const context: ImportContext = {
      groups: [],
      friends: [],
      categories: [
        { id: 31, name: 'Food - Other' },
        { id: 32, name: 'Transportation - Other' },
      ],
      meId: 999,
      lookupMap: new Map(),
    };
    const record: ImportExpenseRecord = {
      description: 'Something',
      cost: '1.00',
      category: 'Other',
    };
    const params = normalizeToCreateParams(record, context);
    assert.ok(params);
    assert.equal(params.categoryId, undefined);
  });

  it('does not set categoryId for non-numeric category labels', () => {
    const context: ImportContext = {
      groups: [],
      friends: [],
      meId: 999,
      lookupMap: new Map(),
    };
    const record: ImportExpenseRecord = {
      description: 'Taxi ride',
      cost: '12.40',
      category: 'Taxi',
    };
    const params = normalizeToCreateParams(record, context);
    assert.ok(params);
    assert.equal(params.categoryId, undefined);
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

  it('matches when existing date includes timestamp for the same day', () => {
    const withDate = { ...candidate, date: '2024-01-15' };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      date: '2024-01-15T16:00:00Z',
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

  it('does not match expenses from another group', () => {
    const withGroup = { ...candidate, groupId: 100 };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      groupId: 101,
      createdBy: { id: meId },
    } as any;
    assert.ok(!exactMatch(withGroup, existing, meId, 'target'));
  });

  it('matches expenses in the same group', () => {
    const withGroup = { ...candidate, groupId: 100 };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      groupId: 100,
      createdBy: { id: meId },
    } as any;
    assert.ok(exactMatch(withGroup, existing, meId, 'target'));
  });

  it('matches expenses in the same group when existing group id is string-typed', () => {
    const withGroup = { ...candidate, groupId: 100 };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      groupId: '100' as any,
      createdBy: { id: meId },
    } as any;
    assert.ok(exactMatch(withGroup, existing, meId, 'target'));
  });

  it('can match across groups with account scope', () => {
    const withGroup = { ...candidate, groupId: 100 };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      groupId: 101,
      createdBy: { id: meId },
    } as any;
    assert.ok(exactMatch(withGroup, existing, meId, 'account'));
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

  it('matches with date within ±5 days when existing date includes timestamp', () => {
    const withDate = { ...candidate, date: '2024-01-15' };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      date: '2024-01-18T16:00:00Z',
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

  it('does not match friend-scoped candidate against group expense', () => {
    const friendScoped = { ...candidate, friendId: 201 };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      groupId: 999,
      createdBy: { id: meId },
    } as any;
    assert.ok(!intelligentMatch(friendScoped, existing, meId, 'target'));
  });

  it('matches friend-scoped candidate when participants include me and friend', () => {
    const friendScoped = { ...candidate, friendId: 201 };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      groupId: null,
      users: [
        { userId: meId, paidShare: '30', owedShare: '15' },
        { userId: 201, paidShare: '0', owedShare: '15' },
      ],
      createdBy: { id: meId },
    } as any;
    assert.ok(intelligentMatch(friendScoped, existing, meId, 'target'));
  });

  it('matches friend-scoped candidate when existing friend id is string-typed', () => {
    const friendScoped = { ...candidate, friendId: 201 };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      groupId: null,
      friendId: '201' as any,
      createdBy: { id: meId },
    } as any;
    assert.ok(intelligentMatch(friendScoped, existing, meId, 'target'));
  });

  it('matches when existing omits zero/zero participant rows', () => {
    const withUsers = {
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      users: [
        { userId: 1, paidShare: '30', owedShare: '15' },
        { userId: 2, paidShare: '0', owedShare: '15' },
        { userId: 3, paidShare: '0', owedShare: '0' },
      ],
    };
    const existing: Expense = {
      id: 1,
      description: 'Dinner',
      cost: '30.00',
      currencyCode: 'USD',
      users: [
        { userId: 1, paidShare: '30.00', owedShare: '15.00' },
        { userId: 2, paidShare: '0.00', owedShare: '15.00' },
      ],
      createdBy: { id: meId },
    } as any;
    assert.ok(intelligentMatch(withUsers, existing, meId));
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
  it('appends JSONL import events to explicit --log-import file', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');
    const logFile = join(ctx.tempDir, 'import-events.jsonl');
    const content = JSON.stringify([
      {
        description: 'Log file test expense',
        cost: '11.00',
        date: '2024-01-15',
        currency: 'USD',
        notes: 'Reconcile this row',
      },
    ]);
    writeFileSync(importFile, content);

    try {
      const first = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
        '--log-import', logFile,
      ], ctx.tempDir, ctx.env);
      assert.equal(first.status, 0);

      const second = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
        '--log-import', logFile,
      ], ctx.tempDir, ctx.env);
      assert.equal(second.status, 0);

      const lines = readFileSync(logFile, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
      assert.equal(lines.length, 2);
      assert.ok(lines[0].indexOf('"action"') < lines[0].indexOf('"description"'));

      const firstEntry = JSON.parse(lines[0]);
      const secondEntry = JSON.parse(lines[1]);
      assert.equal(firstEntry.action, 'created');
      assert.equal(secondEntry.action, 'skipped');
      assert.equal(firstEntry.sourceFile, importFile);
      assert.equal(secondEntry.sourceFile, importFile);
      assert.equal(firstEntry.row, 1);
      assert.equal(secondEntry.row, 1);
      assert.equal(typeof firstEntry.expenseId, 'number');
      assert.ok(Number.isInteger(firstEntry.expenseId));
      assert.equal(typeof secondEntry.duplicateId, 'number');
      assert.ok(Number.isInteger(secondEntry.duplicateId));
      assert.equal(firstEntry.date, '2024-01-15');
      assert.equal(firstEntry.amount, '11.00');
      assert.equal(firstEntry.currency, 'USD');
      assert.equal(firstEntry.notes, 'Reconcile this row');
      assert.equal(secondEntry.date, '2024-01-15');
      assert.equal(secondEntry.amount, '11.00');
      assert.equal(secondEntry.currency, 'USD');
      assert.equal(secondEntry.notes, 'Reconcile this row');
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('uses <import-file>.jsonl when --log-import is passed without a file', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses-default-log.json');
    const defaultLogFile = `${importFile}.jsonl`;
    const content = JSON.stringify([
      {
        description: 'Default log path expense',
        cost: '13.00',
        date: '2024-01-16',
        currency: 'USD',
        notes: 'Default file notes',
      },
    ]);
    writeFileSync(importFile, content);

    try {
      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
        '--log-import',
      ], ctx.tempDir, ctx.env);
      assert.equal(result.status, 0);
      assert.equal(existsSync(defaultLogFile), true);

      const lines = readFileSync(defaultLogFile, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.action, 'created');
      assert.equal(entry.sourceFile, importFile);
      assert.equal(entry.row, 1);
      assert.equal(typeof entry.expenseId, 'number');
      assert.ok(Number.isInteger(entry.expenseId));
      assert.equal(entry.date, '2024-01-16');
      assert.equal(entry.amount, '13.00');
      assert.equal(entry.currency, 'USD');
      assert.equal(entry.notes, 'Default file notes');
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

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

      assert.match(result.stdout, /New dinner/);
      assert.match(result.stdout, /created\s+1/i);
      assert.match(result.stdout, /skipped\s+0/i);
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

      assert.match(result.stdout, /Duplicate dinner/);
      assert.match(result.stdout, /created\s+1/i);
      assert.match(result.stdout, /skipped\s+1/i);
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
      assert.match(dryRunResult.stdout, /created\s+2/i);

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
      assert.match(dryRunUpdateResult.stdout, /updated\s+0/i);

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

  it('fails fast on invalid matcher option', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');
    writeFileSync(importFile, JSON.stringify([{ description: 'X', cost: '1.00' }]));

    try {
      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
        '--matcher', 'fuzzyish',
      ], ctx.tempDir, ctx.env);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid --matcher value/);
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('fails fast on invalid match-scope option', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');
    writeFileSync(importFile, JSON.stringify([{ description: 'X', cost: '1.00' }]));

    try {
      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
        '--match-scope', 'global',
      ], ctx.tempDir, ctx.env);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid --match-scope value/);
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('prints matcher and scope and emits debug trace lines during import', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');
    const content = JSON.stringify([
      { description: 'Trace demo', cost: '5.00', date: '2024-01-15', currency: 'USD' },
      { description: 'Trace demo', cost: '5.00', date: '2024-01-15', currency: 'USD' },
    ]);
    writeFileSync(importFile, content);

    try {
      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        '--log', 'debug',
        'expenses', 'import', importFile,
        '--matcher', 'exact',
        '--match-scope', 'target',
      ], ctx.tempDir, ctx.env);

      assert.equal(result.status, 0);
      assert.match(result.stderr, /Matcher: exact/);
      assert.match(result.stderr, /Match scope: target/);
      assert.match(result.stderr, /evaluating duplicate using exact\/target/);
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('match-scope=target allows create when duplicate exists in another group', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');

    try {
      const createElsewhere = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'add',
        '-d', 'Scope collision',
        '-a', '42.00',
        '--date', '2024-01-15',
        '-C', 'USD',
        '--group', '999',
      ], ctx.tempDir, ctx.env);
      assert.equal(createElsewhere.status, 0);

      writeFileSync(importFile, JSON.stringify([
        {
          description: 'Scope collision',
          cost: '42.00',
          date: '2024-01-15',
          currency: 'USD',
          group: 'January Trip',
        },
      ]));

      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
        '--match-scope', 'target',
      ], ctx.tempDir, ctx.env);

      assert.equal(result.status, 0);
      assert.match(result.stdout, /created\s+1/i);
      assert.match(result.stdout, /skipped\s+0/i);
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('match-scope=account skips create when duplicate exists in another group', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');

    try {
      const createElsewhere = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'add',
        '-d', 'Scope collision',
        '-a', '42.00',
        '--date', '2024-01-15',
        '-C', 'USD',
        '--group', '999',
      ], ctx.tempDir, ctx.env);
      assert.equal(createElsewhere.status, 0);

      writeFileSync(importFile, JSON.stringify([
        {
          description: 'Scope collision',
          cost: '42.00',
          date: '2024-01-15',
          currency: 'USD',
          group: 'January Trip',
        },
      ]));

      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
        '--match-scope', 'account',
      ], ctx.tempDir, ctx.env);

      assert.equal(result.status, 0);
      assert.match(result.stdout, /created\s+0/i);
      assert.match(result.stdout, /skipped\s+1/i);
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('adheres to structured output format when -o json is requested', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');
    writeFileSync(importFile, JSON.stringify([
      {
        description: 'JSON output demo',
        cost: '8.50',
        date: '2024-01-15',
        currency: 'USD',
      },
    ]));

    try {
      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
        '-o', 'json',
      ], ctx.tempDir, ctx.env);

      assert.equal(result.status, 0);
      assert.match(result.stdout, /"status":\s*"created"/);
      assert.match(result.stdout, /"description":\s*"JSON output demo"/);
      assert.match(result.stdout, /"created":\s*1/);
      assert.match(result.stdout, /"updated":\s*0/);
      assert.match(result.stdout, /"skipped":\s*0/);
      assert.match(result.stdout, /"errors":\s*0/);
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('reports unresolved category as error even in dry-run', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');
    writeFileSync(importFile, JSON.stringify([
      {
        description: 'Bad category test',
        cost: '9.90',
        date: '2024-01-15',
        currency: 'USD',
        category: 'DefinitelyNotASplitwiseCategory',
      },
    ]));

    try {
      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        'expenses', 'import', importFile,
        '--dry-run',
      ], ctx.tempDir, ctx.env);

      assert.equal(result.status, 0);
      assert.match(result.stdout, /Bad category test/);
      assert.match(result.stdout, /error/i);
      assert.match(result.stdout, /Unknown or ambiguous category/);
      assert.match(result.stdout, /errors\s+1/i);
      assert.match(result.stdout, /created\s+0/i);
      assert.match(result.stderr, /Dry-run mode: no changes written/);
    } finally {
      await teardownE2EEnv(ctx);
    }
  });

  it('applies target prefilter when importing into one target group', async () => {
    const ctx = await setupE2EEnv();
    const importFile = join(ctx.tempDir, 'expenses.json');
    writeFileSync(importFile, JSON.stringify([
      {
        description: 'Target prefilter check',
        cost: '12.00',
        date: '2024-01-15',
        currency: 'USD',
        group: 'January Trip',
      },
    ]));

    try {
      const result = await runCli([
        '--config-dir', ctx.configDir,
        '--profile', ctx.profileName,
        '--log', 'debug',
        'expenses', 'import', importFile,
        '--dry-run',
      ], ctx.tempDir, ctx.env);

      assert.equal(result.status, 0);
      assert.match(result.stderr, /request GET .*\/get_expenses/);
      assert.match(result.stderr, /(group_id|groupId)=/);
    } finally {
      await teardownE2EEnv(ctx);
    }
  });
});
