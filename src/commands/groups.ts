import { Command } from 'commander';
import { getClient, resolveCacheTarget, resolveCredential, resolveOfflineMode, resolveProfile, getCacheRootPath } from '../lib/config.js';
import { loadLatestGroups } from '../lib/cache.js';
import {
  addOutputOption, getFormat, formatName, render, renderOne, renderTuiList,
  isTuiDefault, colorize, createTuiProgress, createLogger, writeTuiInfoSpacer,
} from '../lib/output.js';

export function registerGroups(program: Command): void {
  const groups = program.command('groups').description('Manage groups');

  addOutputOption(groups.command('list'))
    .description('List groups')
    .action(async function (this: Command) {
      const logger = createLogger(this, 'groups');
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      const startedAt = Date.now();

      if (resolveOfflineMode(this)) {
        const target = resolveCacheTarget(this);
        const profileName = resolveProfile(this).name;
        const credential = resolveCredential(this).credential;
        const list = loadLatestGroups(target, credential.userId, profileName);
        if (list.length === 0) {
          logger.error(`No cached groups data found in ${getCacheRootPath(target)} for offline mode.`);
          process.exit(1);
        }

        const rows = list.map((g) => ({ id: g.id, name: g.name, members: g.members?.length ?? 0 }));

        if (tuiMode && fmt === 'table') {
          renderTuiList(rows, {
            intro: 'Showing groups',
            source: getCacheRootPath(target),
            startedAt,
            logger,
          });
          return;
        }

        render(rows, fmt);
        return;
      }

      const sw = getClient(this);
      const progress = createTuiProgress(tuiMode);
      let list;
      progress.start('Fetching groups...');
      try {
        list = await sw.groups.list();
      } catch (err) {
        progress.fail('Failed to fetch groups.');
        throw err;
      }
      progress.stop(tuiMode ? 'Fetched groups.' : undefined, 'success');
      const rows = list.map((g) => ({ id: g.id, name: g.name, members: g.members?.length ?? 0 }));

      if (tuiMode && fmt === 'table') {
        renderTuiList(rows, {
          intro: 'Showing groups',
          source: 'Splitwise API',
          startedAt,
          logger,
        });
        return;
      }

      render(rows, fmt);
    });

  addOutputOption(groups.command('get <id>'))
    .description('Get details for a group')
    .action(async function (this: Command, id: string) {
      const logger = createLogger(this, 'groups');
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);

      if (resolveOfflineMode(this)) {
        const target = resolveCacheTarget(this);
        const profileName = resolveProfile(this).name;
        const credential = resolveCredential(this).credential;
        const groups = loadLatestGroups(target, credential.userId, profileName);
        const group = groups.find((entry) => entry.id === Number(id));
        if (!group) {
          logger.error(`Group ${id} was not found in cached data at ${getCacheRootPath(target)}.`);
          process.exit(1);
        }
        renderOne(
          {
            id: group.id,
            name: group.name,
            members: group.members?.map(formatName).join(', ') ?? '',
          },
          fmt,
          { tuiMode },
        );
        return;
      }

      const sw = getClient(this);
      if (tuiMode) {
        writeTuiInfoSpacer(true);
        logger.info(`Showing group details for ${id}`);
      }
      const progress = createTuiProgress(tuiMode);
      let g;
      progress.start('Fetching group details...');
      try {
        g = await sw.groups.get({ id: Number(id) });
      } catch (err) {
        progress.fail('Failed to fetch group details.');
        throw err;
      }
      progress.stop('Fetched group details.', 'success');
      renderOne(
        {
          id: g.id,
          name: g.name,
          members: g.members?.map(formatName).join(', ') ?? '',
        },
        fmt,
        { tuiMode },
      );
    });
}
