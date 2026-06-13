import { Command } from 'commander';
import { getClient } from '../lib/config.js';
import {
  addOutputOption, getFormat, formatName, render, renderTuiList,
  isTuiDefault, colorize, createTuiProgress,
} from '../lib/output.js';

export function registerFriends(program: Command): void {
  const friends = program.command('friends').description('Manage friends');

  addOutputOption(friends.command('list'))
    .description('List friends and balances')
    .action(async function (this: Command) {
      const sw = getClient();
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      const startedAt = Date.now();
      const progress = createTuiProgress(tuiMode);
      progress.start('Fetching friends...');
      const list = await sw.friends.list();
      progress.stop();
      const rows = list.map((f) => {
        const balances = f.balance ?? [];
        return {
          id: f.id,
          name: formatName(f),
          balance: balances.length === 0
            ? 'settled up'
            : balances.map((b) => `${b.amount} ${b.currencyCode}`).join(', '),
        };
      });

      if (tuiMode && fmt === 'table') {
        renderTuiList(rows, {
          intro: 'Showing friends and balances',
          source: 'Splitwise API',
          startedAt,
        });
        return;
      }

      render(rows, fmt);
    });
}
