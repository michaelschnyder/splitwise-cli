import { Command } from 'commander';
import { getClient } from '../lib/config.js';
import {
  addOutputOption, getFormat, formatName, render, renderOne, renderTuiList,
  isTuiDefault, colorize, createTuiProgress,
} from '../lib/output.js';

export function registerGroups(program: Command): void {
  const groups = program.command('groups').description('Manage groups');

  addOutputOption(groups.command('list'))
    .description('List groups')
    .action(async function (this: Command) {
      const sw = getClient();
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      const startedAt = Date.now();
      const progress = createTuiProgress(tuiMode);
      progress.start('Fetching groups...');
      const list = await sw.groups.list();
      progress.stop();
      const rows = list.map((g) => ({ id: g.id, name: g.name, members: g.members?.length ?? 0 }));

      if (tuiMode && fmt === 'table') {
        renderTuiList(rows, {
          intro: 'Showing groups',
          source: 'Splitwise API',
          startedAt,
        });
        return;
      }

      render(rows, fmt);
    });

  addOutputOption(groups.command('get <id>'))
    .description('Get details for a group')
    .action(async function (this: Command, id: string) {
      const sw = getClient();
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      if (tuiMode) console.log(colorize(`Showing group details for ${id}`, 'cyan'));
      const progress = createTuiProgress(tuiMode);
      progress.start('Fetching group details...');
      const g = await sw.groups.get({ id: Number(id) });
      progress.stop(colorize('Fetched group details.', 'green'));
      renderOne(
        {
          id: g.id,
          name: g.name,
          members: g.members?.map(formatName).join(', ') ?? '',
        },
        fmt,
      );
    });
}
