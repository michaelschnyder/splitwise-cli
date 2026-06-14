import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = join(root, 'package.json');
const defaultSkillsRoot = join(root, 'src', 'skills');
const targetDirArgIndex = process.argv.findIndex((arg) => arg === '--dir');
const targetDir = targetDirArgIndex >= 0
  ? process.argv[targetDirArgIndex + 1]
  : undefined;

if (targetDirArgIndex >= 0 && (!targetDir || targetDir.startsWith('--'))) {
  throw new Error('Expected a directory path after --dir');
}

if (!existsSync(packageJsonPath)) {
  throw new Error(`Missing package.json at ${packageJsonPath}`);
}

const resolvedSkillsRoot = targetDir ? join(root, targetDir) : defaultSkillsRoot;

if (!existsSync(resolvedSkillsRoot)) {
  throw new Error(`Missing skills directory at ${resolvedSkillsRoot}`);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const nextVersion = packageJson.version;

if (typeof nextVersion !== 'string' || nextVersion.trim() === '') {
  throw new Error('package.json version is missing or invalid');
}

function collectSkillFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectSkillFiles(fullPath));
      continue;
    }

    if (entry === 'SKILL.md') {
      files.push(fullPath);
    }
  }
  return files;
}

const skillFiles = collectSkillFiles(resolvedSkillsRoot);
const updatedFiles = [];

for (const filePath of skillFiles) {
  const before = readFileSync(filePath, 'utf8');
  const after = before.replace(
    /^(\s*version:\s*")([^"]+)("\s*)$/m,
    `$1${nextVersion}$3`
  );

  if (after !== before) {
    writeFileSync(filePath, after, 'utf8');
    updatedFiles.push(filePath);
  }
}

if (updatedFiles.length === 0) {
  console.log('No skill versions changed.');
  process.exit(0);
}

const gitDir = join(root, '.git');
if (existsSync(gitDir) && resolvedSkillsRoot === defaultSkillsRoot) {
  const addResult = spawnSync('git', ['add', ...updatedFiles], {
    cwd: root,
    stdio: 'inherit',
  });

  if (addResult.status !== 0) {
    throw new Error('Failed to stage updated skill files with git add');
  }
}

console.log(`Updated skill versions to ${nextVersion} in ${updatedFiles.length} file(s) under ${resolvedSkillsRoot}.`);
