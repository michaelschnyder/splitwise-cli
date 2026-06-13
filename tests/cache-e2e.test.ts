import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const requireE2e = process.env.SPLITWISE_E2E === '1';
const explicitCredential = process.env.SPLITWISE_E2E_CREDENTIAL?.trim() || null;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntry = resolve(repoRoot, 'src', 'index.ts');

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runCliOrThrow(args: string[], cwd: string): string {
  const result = spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: splitwise-cli ${args.join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  return result.stdout;
}

function canonicalizeExpenses(rawJson: string): unknown {
  const parsed = JSON.parse(rawJson) as Array<Record<string, unknown>>;
  return [...parsed].sort((left, right) => Number(left.id) - Number(right.id));
}

test('e2e cache export then offline query returns same result for one month in 2026', { skip: !requireE2e }, async (t) => {
  if (explicitCredential) {
    const tempDir = mkdtempSync(join(tmpdir(), 'splitwise-cli-e2e-'));
    const cacheDir = join(tempDir, '.splitwise');
    const profileName = `e2e-cache-${Date.now()}`;

    try {
      const createProfile = runCli([
        'profiles',
        'create',
        profileName,
        '--profile-credential',
        explicitCredential,
        '--preferred-cache-target',
        'local',
        '--offline-enabled',
        'no',
      ], tempDir);

      if (createProfile.status !== 0) {
        t.skip(`Could not create E2E profile for credential ${explicitCredential}. stderr: ${createProfile.stderr.trim()}`);
        return;
      }

      rmSync(cacheDir, { recursive: true, force: true });

      const commonArgs = [
        '--profile', profileName,
        'expenses',
        'list',
        '--from', '2026-01-01',
        '--to', '2026-01-31',
        '--all',
        '-o', 'json',
      ];

      const onlineJson = runCliOrThrow(commonArgs, tempDir);

      runCliOrThrow([
        '--profile', profileName,
        'cache',
        'export',
        'expenses',
        '--from', '2026-01-01',
        '--to', '2026-01-31',
        '--target', 'local',
      ], tempDir);

      const offlineJson = runCliOrThrow([
        '--profile', profileName,
        '--offline',
        'expenses',
        'list',
        '--from', '2026-01-01',
        '--to', '2026-01-31',
        '--all',
        '-o', 'json',
      ], tempDir);

      assert.deepEqual(canonicalizeExpenses(offlineJson), canonicalizeExpenses(onlineJson));
      return;
    } finally {
      runCli(['profiles', 'remove', profileName], tempDir);
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const statusRaw = runCli(['login', 'status', '-o', 'json'], repoRoot);
  if (statusRaw.status !== 0) {
    t.skip(`No usable login credential for E2E run. stderr: ${statusRaw.stderr.trim()}`);
    return;
  }

  const loginStatus = JSON.parse(statusRaw.stdout) as {
    name: string;
    userId: number | null;
  } | Array<{
    name: string;
    userId: number | null;
  }>;
  const activeCredential = Array.isArray(loginStatus)
    ? loginStatus[0]?.name
    : loginStatus.name;
  if (!activeCredential) {
    t.skip('No active/default credential resolved for E2E run.');
    return;
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'splitwise-cli-e2e-'));
  const cacheDir = join(tempDir, '.splitwise');
  const profileName = `e2e-cache-${Date.now()}`;

  try {
    const createProfile = runCli([
      'profiles',
      'create',
      profileName,
      '--profile-credential',
      activeCredential,
      '--preferred-cache-target',
      'local',
      '--offline-enabled',
      'no',
    ], tempDir);

    if (createProfile.status !== 0) {
      t.skip(`Could not create E2E profile. stderr: ${createProfile.stderr.trim()}`);
      return;
    }

    rmSync(cacheDir, { recursive: true, force: true });

    const commonArgs = [
      '--profile', profileName,
      'expenses',
      'list',
      '--from', '2026-01-01',
      '--to', '2026-01-31',
      '--all',
      '-o', 'json',
    ];

    const onlineJson = runCliOrThrow(commonArgs, tempDir);

    runCliOrThrow([
      '--profile', profileName,
      'cache',
      'export',
      'expenses',
      '--from', '2026-01-01',
      '--to', '2026-01-31',
      '--target', 'local',
    ], tempDir);

    const offlineJson = runCliOrThrow([
      '--profile', profileName,
      '--offline',
      'expenses',
      'list',
      '--from', '2026-01-01',
      '--to', '2026-01-31',
      '--all',
      '-o', 'json',
    ], tempDir);

    assert.deepEqual(canonicalizeExpenses(offlineJson), canonicalizeExpenses(onlineJson));
  } finally {
    runCli(['profiles', 'remove', profileName], tempDir);
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(tempDir, { recursive: true, force: true });
  }
});