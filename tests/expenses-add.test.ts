import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildExpenseCreateParams, parseExpenseShareInput } from '../src/lib/expense-writes.js';
import { startSplitwiseMockServer } from './helpers/mock-server.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntry = resolve(repoRoot, 'src', 'index.ts');

type CliResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function runCli(args: string[], cwd: string, envOverrides: NodeJS.ProcessEnv = {}, stdinData = ''): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (status) => resolvePromise({ status: status ?? 1, stdout, stderr }));
    if (stdinData.length > 0) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}

async function runCliOrThrow(args: string[], cwd: string, envOverrides: NodeJS.ProcessEnv = {}, stdinData = ''): Promise<CliResult> {
  const result = await runCli(args, cwd, envOverrides, stdinData);
  if (result.status !== 0) {
    throw new Error(`Command failed: splitwise-cli ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

async function setupEnvironment(): Promise<{
  tempDir: string;
  configDir: string;
  profileName: string;
  credentialName: string;
  env: NodeJS.ProcessEnv;
  server: Awaited<ReturnType<typeof startSplitwiseMockServer>>;
}> {
  const server = await startSplitwiseMockServer();
  const tempDir = mkdtempSync(join(tmpdir(), 'splitwise-cli-expenses-add-'));
  const configDir = join(tempDir, 'config');
  const profileName = `add-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
    server.baseUrl,
  ], tempDir, env);

  return { tempDir, configDir, profileName, credentialName, env, server };
}

async function teardownEnvironment(input: {
  tempDir: string;
  configDir: string;
  profileName: string;
  credentialName: string;
  env: NodeJS.ProcessEnv;
  server: Awaited<ReturnType<typeof startSplitwiseMockServer>>;
}): Promise<void> {
  await runCli(['--config-dir', input.configDir, 'profiles', 'remove', input.profileName], input.tempDir, input.env);
  await runCli(['--config-dir', input.configDir, 'login', 'remove', input.credentialName], input.tempDir, input.env);
  rmSync(input.tempDir, { recursive: true, force: true });
  await input.server.close();
}

test('expense create helper builds the expected splitwise payload', () => {
  const params = buildExpenseCreateParams({
    description: 'Coffee',
    cost: '4.50',
    date: '2026-01-03',
    currencyCode: 'USD',
    groupId: 301,
    details: 'after dinner',
    shares: [parseExpenseShareInput('123:2.25:2.25'), parseExpenseShareInput('201:0:2.25')],
  });

  assert.equal(params.description, 'Coffee');
  assert.equal(params.cost, '4.50');
  assert.equal(params.date, '2026-01-03');
  assert.equal(params.currencyCode, 'USD');
  assert.equal(params.groupId, 301);
  assert.equal(params.details, 'after dinner');
  assert.deepEqual(params.users, [
    { userId: 123, paidShare: '2.25', owedShare: '2.25' },
    { userId: 201, paidShare: '0', owedShare: '2.25' },
  ]);
});

test('expense create keeps split equally enabled when no custom shares are provided', () => {
  const params = buildExpenseCreateParams({
    description: 'Lunch',
    cost: '18.00',
    groupId: 301,
  });

  assert.equal(params.splitEqually, true);
  assert.equal(params.users, undefined);
});

test('expenses add writes a new expense through the mock API', async () => {
  const env = await setupEnvironment();

  try {
    const result = await runCliOrThrow([
      '--config-dir', env.configDir,
      '--profile', env.profileName,
      'expenses',
      'add',
      '--description', 'Coffee',
      '--cost', '4.50',
      '--date', '2026-01-03',
      '--currency', 'USD',
      '--group', '301',
      '--payer', '@me',
      '-o', 'json',
    ], env.tempDir, env.env);

    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description, 'Coffee');
    assert.equal(rows[0].cost, '4.50');
    assert.equal(env.server.getWriteRequests().length, 1);
    assert.equal(env.server.getWriteRequests()[0].path, '/create_expense');
    assert.equal(env.server.getWriteRequests()[0].body.description, 'Coffee');
    assert.equal(env.server.getWriteRequests()[0].body.groupId, '301');
    assert.equal(env.server.getWriteRequests()[0].body.date, '2026-01-03');
  } finally {
    await teardownEnvironment(env);
  }
});

test('expenses add is blocked by profile permission', async () => {
  const env = await setupEnvironment();

  try {
    await runCliOrThrow([
      '--config-dir', env.configDir,
      'profiles',
      'edit',
      env.profileName,
      '--create-expenses',
      'no',
    ], env.tempDir, env.env);

    const result = await runCli([
      '--config-dir', env.configDir,
      '--profile', env.profileName,
      'expenses',
      'add',
      '--description', 'Blocked',
      '--cost', '1.00',
    ], env.tempDir, env.env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /blocks create expense operations/i);
    assert.equal(env.server.getWriteRequests().length, 0);
  } finally {
    await teardownEnvironment(env);
  }
});