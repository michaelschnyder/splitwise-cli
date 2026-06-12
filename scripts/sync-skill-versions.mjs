import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = join(root, 'package.json');
const skillsRoot = join(root, 'src', 'skills');

if (!existsSync(packageJsonPath)) {
  throw new Error(`Missing package.json at ${packageJsonPath}`);
}

if (!existsSync(skillsRoot)) {
  throw new Error(`Missing skills directory at ${skillsRoot}`);
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

const skillFiles = collectSkillFiles(skillsRoot);
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
if (existsSync(gitDir)) {
  const addResult = spawnSync('git', ['add', ...updatedFiles], {
    cwd: root,
    stdio: 'inherit',
  });

  if (addResult.status !== 0) {
    throw new Error('Failed to stage updated skill files with git add');
  }
}

console.log(`Updated skill versions to ${nextVersion} in ${updatedFiles.length} file(s).`);
