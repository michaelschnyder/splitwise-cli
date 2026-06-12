import { Command } from 'commander';
import { getClient } from '../lib/config.js';
import { addOutputOption, getFormat, formatName, render } from '../lib/output.js';

export function registerFriends(program: Command): void {
  const friends = program.command('friends').description('Manage friends');

  addOutputOption(friends.command('list'))
    .description('List friends and balances')
    .action(async function (this: Command) {
      const sw = getClient();
      const list = await sw.friends.list();
      render(
        list.map((f) => {
          const balances = f.balance ?? [];
          return {
            id: f.id,
            name: formatName(f),
            balance: balances.length === 0
              ? 'settled up'
              : balances.map((b) => `${b.amount} ${b.currencyCode}`).join(', '),
          };
        }),
        getFormat(this),
      );
    });
}
