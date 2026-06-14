import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
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
  const tempDir = mkdtempSync(join(tmpdir(), 'splitwise-cli-expenses-delete-'));
  const configDir = join(tempDir, 'config');
  const profileName = `delete-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

test('expenses delete removes an expense when confirmed with --yes', async () => {
  const env = await setupEnvironment();

  try {
    const result = await runCliOrThrow([
      '--config-dir', env.configDir,
      '--profile', env.profileName,
      'expenses',
      'delete',
      '1001',
      '--yes',
    ], env.tempDir, env.env);

    assert.match(result.stderr, /Deleted expense 1001\./);
    assert.equal(env.server.getWriteRequests().length, 1);
    assert.equal(env.server.getWriteRequests()[0].path, '/delete_expense/1001');
  } finally {
    await teardownEnvironment(env);
  }
});

test('expenses delete prompts for confirmation when --yes is missing', async () => {
  const env = await setupEnvironment();

  try {
    const result = await runCli([
      '--config-dir', env.configDir,
      '--profile', env.profileName,
      'expenses',
      'delete',
      '1001',
    ], env.tempDir, env.env, 'n\n');

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Delete aborted\./);
    assert.equal(env.server.getWriteRequests().length, 0);
  } finally {
    await teardownEnvironment(env);
  }
});

test('expenses delete is blocked by profile permission', async () => {
  const env = await setupEnvironment();

  try {
    await runCliOrThrow([
      '--config-dir', env.configDir,
      'profiles',
      'edit',
      env.profileName,
      '--delete-expenses',
      'no',
    ], env.tempDir, env.env);

    const result = await runCli([
      '--config-dir', env.configDir,
      '--profile', env.profileName,
      'expenses',
      'delete',
      '1001',
      '--yes',
    ], env.tempDir, env.env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /blocks delete expense operations/i);
    assert.equal(env.server.getWriteRequests().length, 0);
  } finally {
    await teardownEnvironment(env);
  }
});