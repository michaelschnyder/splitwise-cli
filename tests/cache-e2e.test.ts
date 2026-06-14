import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'splitwise-response.json'), 'utf-8')) as {
  current_user: Record<string, unknown>;
  friends: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
  currencies: Array<Record<string, unknown>>;
  expenses: Array<Record<string, unknown>>;
  comments_by_expense: Record<string, Array<Record<string, unknown>>>;
};
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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (status) => {
      resolvePromise({ status: status ?? 1, stdout, stderr });
    });
  });
}

async function runCliOrThrow(args: string[], cwd: string, envOverrides: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await runCli(args, cwd, envOverrides);
  if (result.status !== 0) {
    throw new Error(`Command failed: splitwise-cli ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function canonicalizeExpenses(rawJson: string): unknown {
  const parsed = JSON.parse(rawJson) as Array<Record<string, unknown>>;
  return [...parsed].sort((left, right) => Number(left.id) - Number(right.id));
}

function canonicalizeById(rawJson: string): unknown {
  const parsed = JSON.parse(rawJson) as Array<Record<string, unknown>>;
  return [...parsed].sort((left, right) => Number(left.id) - Number(right.id));
}

function startMockServer() {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/^\/api\/v3\.0/, '') || url.pathname;
    const sendJson = (payload: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (path === '/get_current_user') {
      sendJson({ user: fixture.current_user });
      return;
    }

    if (path === '/get_friends') {
      sendJson({ friends: fixture.friends });
      return;
    }

    if (path === '/get_groups') {
      sendJson({ groups: fixture.groups });
      return;
    }

    const groupDetailMatch = path.match(/^\/get_group\/(\d+)$/);
    if (groupDetailMatch) {
      const groupId = Number(groupDetailMatch[1]);
      const group = fixture.groups.find((item) => Number(item.id) === groupId);
      if (!group) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      sendJson({ group });
      return;
    }

    if (path === '/get_categories') {
      sendJson({ categories: fixture.categories });
      return;
    }

    if (path === '/get_currencies') {
      sendJson({ currencies: fixture.currencies });
      return;
    }

    if (path === '/get_comments') {
      const expenseId = url.searchParams.get('expense_id') ?? url.searchParams.get('expenseId') ?? '';
      sendJson({ comments: fixture.comments_by_expense[expenseId] ?? [] });
      return;
    }

    if (path === '/get_expenses') {
      const limit = Number(url.searchParams.get('limit') ?? fixture.expenses.length);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const from = url.searchParams.get('from') ?? null;
      const to = url.searchParams.get('to') ?? null;
      const groupId = url.searchParams.get('group_id') ?? url.searchParams.get('groupId');
      const rows = fixture.expenses.filter((expense) => {
        const date = String(expense.date ?? '');
        if (from !== null && date < from) return false;
        if (to !== null && date > to) return false;
        if (groupId !== null && String(expense.group_id ?? '') !== groupId) return false;
        return true;
      });
      sendJson({ expenses: rows.slice(offset, offset + limit) });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return new Promise<{ baseUrl: string; close: () => Promise<void>; getRequestCount: () => number }>((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Failed to start mock Splitwise server');
      let closed = false;
      resolvePromise({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolveClose) => {
          if (closed) {
            resolveClose();
            return;
          }
          closed = true;
          server.close(() => resolveClose());
        }),
        getRequestCount: () => requestCount,
      });
    });
  });
}

async function setupE2EEnvironment(): Promise<{
  tempDir: string;
  configDir: string;
  profileName: string;
  credentialName: string;
  env: NodeJS.ProcessEnv;
  mockServer: { baseUrl: string; close: () => Promise<void>; getRequestCount: () => number };
}> {
  const mockServer = await startMockServer();
  const tempDir = mkdtempSync(join(tmpdir(), 'splitwise-cli-e2e-'));
  const configDir = join(tempDir, 'config');
  const profileName = `e2e-cache-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const credentialName = 'e2e';
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };

  await runCliOrThrow(['--config-dir', configDir, 'login', 'token', 'test-token', '--name', credentialName], tempDir, env);
  await runCliOrThrow([
    '--config-dir', configDir,
    'profiles',
    'create',
    profileName,
    '--profile-credential',
    credentialName,
    '--preferred-cache-target',
    'local',
    '--offline-enabled',
    'no',
    '--api-endpoint',
    mockServer.baseUrl,
  ], tempDir, env);

  return { tempDir, configDir, profileName, credentialName, env, mockServer };
}

async function teardownE2EEnvironment(input: {
  tempDir: string;
  configDir: string;
  profileName: string;
  credentialName: string;
  env: NodeJS.ProcessEnv;
  mockServer: { close: () => Promise<void>; getRequestCount: () => number };
}): Promise<void> {
  await runCli(['--config-dir', input.configDir, 'profiles', 'remove', input.profileName], input.tempDir, input.env);
  await runCli(['--config-dir', input.configDir, 'login', 'remove', input.credentialName], input.tempDir, input.env);
  rmSync(input.tempDir, { recursive: true, force: true });
  await input.mockServer.close();
}

test('e2e cache export then offline query returns same result against a local mock Splitwise server', async (t) => {
  const e2e = await setupE2EEnvironment();

  try {
    const commonArgs = [
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'expenses',
      'list',
      '--from', '2026-01-01',
      '--to', '2026-01-31',
      '--all',
      '-o', 'json',
    ];

    const onlineJson = await runCliOrThrow(commonArgs, e2e.tempDir, e2e.env);

    await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'add',
      'expenses',
      '--from', '2026-01-01',
      '--to', '2026-01-31',
      '--target',
      'local',
    ], e2e.tempDir, e2e.env);

    const offlineJson = await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      '--offline',
      'expenses',
      'list',
      '--from', '2026-01-01',
      '--to', '2026-01-31',
      '--all',
      '-o', 'json',
    ], e2e.tempDir, e2e.env);

    assert.deepEqual(canonicalizeExpenses(offlineJson), canonicalizeExpenses(onlineJson));
  } finally {
    await teardownE2EEnvironment(e2e);
  }
});

test('e2e friends and groups list stay parity between online and offline cache source', async () => {
  const e2e = await setupE2EEnvironment();

  try {
    const onlineFriends = await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'friends',
      'list',
      '-o', 'json',
    ], e2e.tempDir, e2e.env);

    const onlineGroups = await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'groups',
      'list',
      '-o', 'json',
    ], e2e.tempDir, e2e.env);

    await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'add',
      'friends',
      '--target',
      'local',
    ], e2e.tempDir, e2e.env);

    await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'add',
      'groups',
      '--target',
      'local',
    ], e2e.tempDir, e2e.env);

    const offlineFriends = await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      '--offline',
      'friends',
      'list',
      '-o', 'json',
    ], e2e.tempDir, e2e.env);

    const offlineGroups = await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      '--offline',
      'groups',
      'list',
      '-o', 'json',
    ], e2e.tempDir, e2e.env);

    assert.deepEqual(canonicalizeById(offlineFriends), canonicalizeById(onlineFriends));
    assert.deepEqual(canonicalizeById(offlineGroups), canonicalizeById(onlineGroups));
  } finally {
    await teardownE2EEnvironment(e2e);
  }
});

test('e2e lookup export writes categories and currencies as separate cache entities', async () => {
  const e2e = await setupE2EEnvironment();

  try {
    await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'add',
      'lookup',
      '--target',
      'local',
    ], e2e.tempDir, e2e.env);

    const cacheList = await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'list',
      '--target',
      'local',
      '-o',
      'json',
    ], e2e.tempDir, e2e.env);

    const entities = (JSON.parse(cacheList) as Array<{ entity: string }>).map((row) => row.entity);
    assert.equal(entities.some((entity) => entity.startsWith('categories (')), true);
    assert.equal(entities.some((entity) => entity.startsWith('currencies (')), true);
  } finally {
    await teardownE2EEnvironment(e2e);
  }
});

test('e2e offline expenses do not hit the network after export and still work with server closed', async () => {
  const e2e = await setupE2EEnvironment();

  try {
    await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'add',
      'expenses',
      '--from', '2026-01-01',
      '--to', '2026-01-31',
      '--target',
      'local',
    ], e2e.tempDir, e2e.env);

    const beforeOffline = e2e.mockServer.getRequestCount();
    await e2e.mockServer.close();

    const offlineJson = await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      '--offline',
      'expenses',
      'list',
      '--from', '2026-01-01',
      '--to', '2026-01-31',
      '--all',
      '-o', 'json',
    ], e2e.tempDir, e2e.env);

    assert.equal(JSON.parse(offlineJson).length > 0, true);
    assert.equal(e2e.mockServer.getRequestCount(), beforeOffline);
  } finally {
    await teardownE2EEnvironment(e2e);
  }
});

test('e2e cache list exposes the reshaped cache row for expense exports', async () => {
  const e2e = await setupE2EEnvironment();

  try {
    await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'add',
      'expenses',
      '--from', '2026-01-01',
      '--to', '2026-01-31',
      '--target',
      'local',
    ], e2e.tempDir, e2e.env);

    const rows = JSON.parse(await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'list',
      '--target',
      'local',
      '-o',
      'json',
    ], e2e.tempDir, e2e.env)) as Array<{ id: string; created: string; entity: string; scope: string; Details: string }>;

    assert.equal(Object.keys(rows[0] ?? {})[0], 'id');
    assert.equal(Object.keys(rows[0] ?? {})[1], 'created');
    assert.equal(Object.keys(rows[0] ?? {})[2], 'entity');

    const expenseRow = rows.find((row) => row.entity.startsWith('expenses ('));
    assert.ok(expenseRow, 'expense row should be present in cache list');
    assert.equal(typeof expenseRow.created, 'string');
    assert.equal(expenseRow.Details.includes('location: '), true);
    assert.equal(expenseRow.Details.includes('size: '), true);
  } finally {
    await teardownE2EEnvironment(e2e);
  }
});

test('e2e cache delete removes a cache entry by id', async () => {
  const e2e = await setupE2EEnvironment();

  try {
    await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'add',
      'friends',
      '--target',
      'local',
    ], e2e.tempDir, e2e.env);

    const initialRows = JSON.parse(await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'list',
      '--target',
      'local',
      '-o',
      'json',
    ], e2e.tempDir, e2e.env)) as Array<{ id: string; entity: string }>;

    const cacheEntry = initialRows.find((row) => row.entity.startsWith('friends ('));
    assert.ok(cacheEntry);

    await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'delete',
      cacheEntry.id,
      '--target',
      'local',
    ], e2e.tempDir, e2e.env);

    const finalRows = JSON.parse(await runCliOrThrow([
      '--config-dir', e2e.configDir,
      '--profile', e2e.profileName,
      'cache',
      'list',
      '--target',
      'local',
      '-o',
      'json',
    ], e2e.tempDir, e2e.env)) as Array<Record<string, unknown>>;

    assert.equal(finalRows.length, 0);
  } finally {
    await teardownE2EEnvironment(e2e);
  }
});