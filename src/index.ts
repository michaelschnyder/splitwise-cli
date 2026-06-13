#!/usr/bin/env node

import { Command } from 'commander';
import figlet from 'figlet';
import { registerAuth } from './commands/auth.js';
import { registerFriends } from './commands/friends.js';
import { registerGroups } from './commands/groups.js';
import { registerExpenses } from './commands/expenses.js';
import { registerSkills } from './commands/skills.js';
import { registerProfiles } from './commands/profiles.js';
import { validateSelectedProfileOrExit } from './lib/config.js';
import { addLoggingOptions, addProfileOption, createLogger } from './lib/output.js';

const program = new Command();

program
  .name('splitwise-cli')
  .description(figlet.textSync('Splitwise CLI', { horizontalLayout: 'full' }))
  .version('1.0.0');

addLoggingOptions(program);
addProfileOption(program);

const argv = process.argv.slice(2);
const asksForHelpOrVersion = argv.includes('-h') || argv.includes('--help') || argv.includes('-V') || argv.includes('--version');
if (!asksForHelpOrVersion) {
  validateSelectedProfileOrExit();
}

program.hook('preAction', (_thisCommand, actionCommand) => {
  const commandName = actionCommand.name();
  if (commandName === 'help') return;
  validateSelectedProfileOrExit(actionCommand);
});

registerAuth(program);
registerFriends(program);
registerGroups(program);
registerExpenses(program);
registerSkills(program);
registerProfiles(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const logger = createLogger();
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
