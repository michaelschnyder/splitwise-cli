import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
    child.on('close', (status) => resolvePromise({ status: status ?? 1, stdout, stderr }));
  });
}

async function runCliOrThrow(args: string[], cwd: string, envOverrides: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await runCli(args, cwd, envOverrides);
  if (result.status !== 0) {
    throw new Error(`Command failed: splitwise-cli ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

test('profiles create/show/list preserve offline and preferred cache target fields', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'splitwise-cli-profiles-'));
  const configDir = join(tempDir, 'config');
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };

  try {
    await runCliOrThrow([
      '--config-dir', configDir,
      'profiles',
      'create',
      'offline-work',
      '--offline-enabled',
      'yes',
      '--preferred-cache-target',
      'user',
      '--api-endpoint',
      'https://example.test/api',
    ], tempDir, env);

    const showJson = (JSON.parse(await runCliOrThrow([
      '--config-dir', configDir,
      'profiles',
      'show',
      'offline-work',
      '-o',
      'json',
    ], tempDir, env)) as Array<{ offlineEnabled: boolean; preferredCacheTarget: string; apiEndpoint: string }>)[0];

    assert.equal(showJson.offlineEnabled, true);
    assert.equal(showJson.preferredCacheTarget, 'user');
    assert.equal(showJson.apiEndpoint, 'https://example.test/api');

    const listJson = JSON.parse(await runCliOrThrow([
      '--config-dir', configDir,
      'profiles',
      'list',
      '-o',
      'json',
    ], tempDir, env)) as Array<{ name: string; offlineEnabled: string; preferredCacheTarget: string }>;

    const row = listJson.find((item) => item.name === 'offline-work');
    assert.equal(row?.offlineEnabled, 'yes');
    assert.equal(row?.preferredCacheTarget, 'user');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
