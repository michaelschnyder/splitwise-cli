import { Command } from 'commander';
import { getClient } from '../lib/config.js';
import {
  addOutputOption, getFormat, formatName, render, renderTuiList,
  isTuiDefault, createTuiProgress, createLogger,
} from '../lib/output.js';

export function registerFriends(program: Command): void {
  const friends = program.command('friends').description('Manage friends');

  addOutputOption(friends.command('list'))
    .description('List friends and balances')
    .action(async function (this: Command) {
      const sw = getClient(this);
      const logger = createLogger(this, 'friends');
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      const startedAt = Date.now();
      const progress = createTuiProgress(tuiMode);
      let list;
      progress.start('Fetching friends...');
      try {
        list = await sw.friends.list();
      } catch (err) {
        progress.fail('Failed to fetch friends.');
        throw err;
      }
      progress.stop(tuiMode ? 'Fetched friends.' : undefined, 'success');
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
          logger,
        });
        return;
      }

      render(rows, fmt);
    });
}
