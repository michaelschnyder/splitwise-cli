import { Command } from 'commander';
import { getDataClient } from '../lib/config.js';
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

      const sw = getDataClient(this);
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
          source: sw.getSourceLabel(),
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

      const sw = getDataClient(this);
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
