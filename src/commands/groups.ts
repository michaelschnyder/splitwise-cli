import { Command } from 'commander';
import { getClient } from '../lib/config.js';
import { addOutputOption, getFormat, formatName, render, renderOne } from '../lib/output.js';

export function registerGroups(program: Command): void {
  const groups = program.command('groups').description('Manage groups');

  addOutputOption(groups.command('list'))
    .description('List groups')
    .action(async function (this: Command) {
      const sw = getClient();
      const list = await sw.groups.list();
      render(
        list.map((g) => ({ id: g.id, name: g.name, members: g.members?.length ?? 0 })),
        getFormat(this),
      );
    });

  addOutputOption(groups.command('get <id>'))
    .description('Get details for a group')
    .action(async function (this: Command, id: string) {
      const sw = getClient();
      const g = await sw.groups.get({ id: Number(id) });
      renderOne(
        {
          id: g.id,
          name: g.name,
          members: g.members?.map(formatName).join(', ') ?? '',
        },
        getFormat(this),
      );
    });
}
