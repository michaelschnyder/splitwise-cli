import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SkillEntry {
  name: string;
  description: string;
  content: string;
}

interface PlatformSpec {
  name: string;
  aliases: string[];
  projectSkills: string;
  userSkills: string;
}

interface SkillResourceEntry {
  name: string;
  description: string;
  resourceDir: string;
}

const PLATFORMS: PlatformSpec[] = [
  {
    name: 'claude-code',
    aliases: ['claude'],
    projectSkills: '.claude/skills',
    userSkills: '.claude/skills',
  },
  {
    name: 'cursor',
    aliases: [],
    projectSkills: '.cursor/skills',
    userSkills: '.cursor/skills',
  },
  {
    name: 'codex',
    aliases: [],
    projectSkills: '.codex/skills',
    userSkills: '.codex/skills',
  },
  {
    name: 'opencode',
    aliases: [],
    projectSkills: '.opencode/skills',
    userSkills: '.config/opencode/skills',
  },
  {
    name: 'windsurf',
    aliases: [],
    projectSkills: '.windsurf/skills',
    userSkills: '.windsurf/skills',
  },
  {
    name: 'gemini-code',
    aliases: ['gemini'],
    projectSkills: '.gemini/skills',
    userSkills: '.gemini/skills',
  },
  {
    name: 'pi',
    aliases: ['pi-dev'],
    projectSkills: '.pi/skills',
    userSkills: '.pi/agent/skills',
  },
];

const SKILL_RESOURCES: SkillResourceEntry[] = [
  {
    name: 'splitwise-cli',
    description: 'Top-level splitwise-cli command reference and workflow.',
    resourceDir: 'splitwise-cli',
  },
  {
    name: 'splitwise-login',
    description: 'Login credential setup and troubleshooting.',
    resourceDir: 'splitwise-login',
  },
  {
    name: 'splitwise-expenses',
    description: 'Expense filtering, pagination, and detail inspection.',
    resourceDir: 'splitwise-expenses',
  },
  {
    name: 'splitwise-groups',
    description: 'Group discovery and details.',
    resourceDir: 'splitwise-groups',
  },
  {
    name: 'splitwise-friends',
    description: 'Friend and balance exploration.',
    resourceDir: 'splitwise-friends',
  },
  {
    name: 'splitwise-profiles',
    description: 'Profile restrictions, locking, and selection workflows.',
    resourceDir: 'splitwise-profiles',
  },
];

const SKILLS_ROOT = findSkillsRoot();

export const SKILLS: SkillEntry[] = SKILL_RESOURCES.map((entry) => ({
  name: entry.name,
  description: entry.description,
  content: loadSkillContent(entry.resourceDir),
}));

export function lookupPlatform(input: string): PlatformSpec | undefined {
  const normalized = input.trim().toLowerCase();
  return PLATFORMS.find((p) => p.name === normalized || p.aliases.includes(normalized));
}

export function resolvePlatformName(input?: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw) {
    return autoDetectPlatform();
  }
  if (raw.toLowerCase() === 'all') {
    return 'all';
  }
  const spec = lookupPlatform(raw);
  return spec?.name ?? raw.toLowerCase();
}

export function resolvePlatformList(input?: string): string[] {
  const resolved = resolvePlatformName(input);
  if (!resolved) return [];
  if (resolved === 'all') return PLATFORMS.map((p) => p.name);
  return [resolved];
}

export function supportedPlatformNames(): string[] {
  return PLATFORMS.map((p) => p.name);
}

export function skillsDir(platform: string, projectRoot: string, userScope: boolean): string | null {
  const spec = lookupPlatform(platform);
  if (!spec) return null;
  const subpath = userScope ? spec.userSkills : spec.projectSkills;
  const base = userScope ? homedir() : projectRoot;
  return join(base, ...subpath.split('/'));
}

export function projectRootOrCwd(): { root: string; foundProjectRoot: boolean } {
  const root = findProjectRoot();
  return root ? { root, foundProjectRoot: true } : { root: process.cwd(), foundProjectRoot: false };
}

function findProjectRoot(): string | null {
  let current = process.cwd();
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function autoDetectPlatform(): string | null {
  const cwd = process.cwd();
  const home = homedir();

  const checks: Array<{ name: string; projectPath: string; userPath: string }> = [
    { name: 'claude-code', projectPath: join(cwd, '.claude'), userPath: join(home, '.claude') },
    { name: 'cursor', projectPath: join(cwd, '.cursor'), userPath: join(home, '.cursor') },
    { name: 'codex', projectPath: join(cwd, '.codex'), userPath: join(home, '.codex') },
    { name: 'opencode', projectPath: join(cwd, '.opencode'), userPath: join(home, '.config', 'opencode') },
    { name: 'windsurf', projectPath: join(cwd, '.windsurf'), userPath: join(home, '.windsurf') },
    { name: 'gemini-code', projectPath: join(cwd, '.gemini'), userPath: join(home, '.gemini') },
    { name: 'pi', projectPath: join(cwd, '.pi'), userPath: join(home, '.pi') },
  ];

  const found = checks.filter((c) => existsSync(c.projectPath) || existsSync(c.userPath));
  if (found.length === 1) return found[0].name;
  return null;
}

function findSkillsRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, '..', 'skills'),
    join(moduleDir, '..', '..', 'src', 'skills'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not locate skill resources directory. Checked: ${candidates.join(', ')}`,
  );
}

function loadSkillContent(resourceDir: string): string {
  const resourcePath = join(SKILLS_ROOT, resourceDir, 'SKILL.md');
  if (!existsSync(resourcePath)) {
    throw new Error(`Missing skill resource file: ${resourcePath}`);
  }

  return readFileSync(resourcePath, 'utf-8');
}

export function formatAsSkillMd(entry: SkillEntry): string {
  const src = entry.content;
  if (src.startsWith('---')) {
    const end = src.slice(3).indexOf('---');
    if (end >= 0) {
      const frontmatter = src.slice(3, 3 + end);
      if (frontmatter.includes('name:')) {
        return src;
      }
      return `---\nname: ${entry.name}\n${frontmatter}---${src.slice(3 + end + 3)}`;
    }
  }
  return `---\nname: ${entry.name}\ndescription: ${entry.description}\n---\n\n${src}`;
}

export function installSkillFiles(
  destinationDir: string,
  entries: SkillEntry[],
  overwrite: boolean,
): { filesWritten: number; directoriesTouched: Set<string> } {
  const directoriesTouched = new Set<string>();
  let filesWritten = 0;

  for (const entry of entries) {
    const path = join(destinationDir, entry.name, 'SKILL.md');
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true });
    directoriesTouched.add(parent);

    if (!overwrite && existsSync(path)) {
      continue;
    }

    writeFileSync(path, formatAsSkillMd(entry));
    filesWritten += 1;
  }

  return { filesWritten, directoriesTouched };
}
