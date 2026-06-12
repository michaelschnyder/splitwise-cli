#!/usr/bin/env node

import { Command } from 'commander';
import figlet from 'figlet';
import { registerAuth } from './commands/auth.js';
import { registerFriends } from './commands/friends.js';
import { registerGroups } from './commands/groups.js';
import { registerExpenses } from './commands/expenses.js';
import { registerSkills } from './commands/skills.js';

const program = new Command();

program
  .name('splitwise-cli')
  .description(figlet.textSync('Splitwise CLI', { horizontalLayout: 'full' }))
  .version('1.0.0');

registerAuth(program);
registerFriends(program);
registerGroups(program);
registerExpenses(program);
registerSkills(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
