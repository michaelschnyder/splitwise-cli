import { Command } from 'commander';
import {
  SKILLS,
  installSkillFiles,
  lookupPlatform,
  projectRootOrCwd,
  resolvePlatformList,
  skillsDir,
  supportedPlatformNames,
} from '../lib/skills.js';
import {
  addOutputOption, getFormat, render, renderTuiList,
  isTuiDefault, colorize, createTuiProgress,
} from '../lib/output.js';

function resolveOrBail(input?: string): string[] {
  const platforms = resolvePlatformList(input);
  if (platforms.length === 0) {
    console.error(
      'Could not auto-detect AI assistant platform. Specify one explicitly: claude, cursor, codex, opencode, windsurf, gemini, or all.',
    );
    process.exit(1);
  }

  for (const p of platforms) {
    if (!lookupPlatform(p)) {
      console.error(
        `Unknown platform "${p}". Supported: ${supportedPlatformNames().join(', ')}, all.`,
      );
      process.exit(1);
    }
  }

  return platforms;
}

export function registerSkills(program: Command): void {
  const skills = program.command('skills').description('List, create, and install AI coding skills');

  addOutputOption(skills.command('list'))
    .description('List built-in Splitwise skills')
    .action(function (this: Command) {
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      const startedAt = Date.now();
      const progress = createTuiProgress(tuiMode);
      progress.start('Collecting skill metadata...');
      progress.stop();
      const rows = SKILLS.map((s) => ({
        name: s.name,
        type: 'skill',
        description: s.description,
      }));

      if (tuiMode && fmt === 'table') {
        renderTuiList(rows, {
          intro: 'Showing built-in skills',
          source: 'splitwise-cli built-ins',
          startedAt,
        });
        return;
      }

      render(rows, fmt);
    });

  skills
    .command('path [platform]')
    .description('Print install paths for one platform, all platforms, or auto-detected platform')
    .option('--project', 'Use project-local scope instead of user-global scope')
    .action((platform: string | undefined, opts: { project?: boolean }) => {
      const { root } = projectRootOrCwd();
      const userScope = !opts.project;
      const scopeLabel = userScope ? 'user' : 'project';
      const platforms = resolveOrBail(platform);

      for (const p of platforms) {
        const dir = skillsDir(p, root, userScope);
        if (!dir) {
          console.log(`platform: ${p} (scope: ${scopeLabel})`);
          console.log('  skills: not supported');
          continue;
        }

        console.log(`platform: ${p} (scope: ${scopeLabel})`);
        console.log(`  skills: ${dir}`);
      }
    });

  skills
    .command('install [platform]')
    .description('Install built-in skills for a platform, all platforms, or auto-detected platform')
    .option('--name <name>', 'Install only one skill by name')
    .option('--dir <path>', 'Override output directory (writes <dir>/<skill>/SKILL.md)')
    .option('--project', 'Use project-local scope instead of user-global scope')
    .option('--force', 'Overwrite existing SKILL.md files')
    .action((
      platform: string | undefined,
      opts: { name?: string; dir?: string; project?: boolean; force?: boolean },
    ) => {
      const { root } = projectRootOrCwd();
      const userScope = !opts.project;
      const selected = opts.name
        ? SKILLS.filter((s) => s.name === opts.name)
        : SKILLS;

      if (opts.name && selected.length === 0) {
        console.error(`skill not found: ${opts.name}`);
        process.exit(1);
      }

      const platforms = resolveOrBail(platform);
      let installedFiles = 0;
      const dirsUsed = new Set<string>();

      for (const p of platforms) {
        const baseDir = opts.dir ?? skillsDir(p, root, userScope);
        if (!baseDir) {
          continue;
        }

        const result = installSkillFiles(baseDir, selected, Boolean(opts.force));
        installedFiles += result.filesWritten;
        for (const d of result.directoriesTouched) dirsUsed.add(d);
      }

      if (installedFiles === 0 && (opts.name || opts.force !== true)) {
        console.error('No files were written. Use --force to overwrite existing skill files.');
        process.exit(1);
      }

      for (const d of dirsUsed) {
        console.log(`  ${d}`);
      }
      console.log(
        `Installed ${selected.length} skill(s), wrote ${installedFiles} file(s) across ${platforms.length} platform(s).`,
      );
    });

  skills
    .command('create')
    .description('Create local skill source files from currently supported splitwise-cli functionality')
    .option('--name <name>', 'Create only one skill by name')
    .option('--dir <path>', 'Destination directory for generated skills', 'skills')
    .option('--force', 'Overwrite existing SKILL.md files')
    .action((opts: { name?: string; dir: string; force?: boolean }) => {
      const selected = opts.name
        ? SKILLS.filter((s) => s.name === opts.name)
        : SKILLS;

      if (opts.name && selected.length === 0) {
        console.error(`skill not found: ${opts.name}`);
        process.exit(1);
      }

      const result = installSkillFiles(opts.dir, selected, Boolean(opts.force));
      if (result.filesWritten === 0 && !opts.force) {
        console.error('No files were written. Use --force to overwrite existing skill files.');
        process.exit(1);
      }

      for (const d of result.directoriesTouched) {
        console.log(`  ${d}`);
      }
      console.log(`Created ${selected.length} skill(s), wrote ${result.filesWritten} file(s).`);
    });
}
