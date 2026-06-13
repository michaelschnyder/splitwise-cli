#!/usr/bin/env node

import { Command } from 'commander';
import figlet from 'figlet';
import { registerLogin } from './commands/login.js';
import { registerFriends } from './commands/friends.js';
import { registerGroups } from './commands/groups.js';
import { registerExpenses } from './commands/expenses.js';
import { registerSkills } from './commands/skills.js';
import { registerProfiles } from './commands/profiles.js';
import { loadConfig, maskCredentialToken, resolveCredentialName, resolveProfile, validateSelectedProfileOrExit } from './lib/config.js';
import { addCredentialOption, addLoggingOptions, addProfileOption, createLogger } from './lib/output.js';

const program = new Command();

program
  .name('splitwise-cli')
  .description(figlet.textSync('Splitwise CLI', { horizontalLayout: 'full' }))
  .version('1.0.0');

addLoggingOptions(program);
addProfileOption(program);
addCredentialOption(program);

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

registerLogin(program);
registerFriends(program);
registerGroups(program);
registerExpenses(program);
registerSkills(program);
registerProfiles(program);

if (argv.length === 0) {
  try {
    const profile = resolveProfile();
    const credentialName = resolveCredentialName();
    const config = loadConfig();
    const credential = config.credentials?.[credentialName];
    process.stderr.write(`Active profile: ${profile.name}\n`);
    process.stderr.write(`Active credential: ${credentialName}\n`);
    if (credential) {
      process.stderr.write(`Credential token: ${maskCredentialToken(credential)}\n`);
      if (credential.userName || credential.userId) {
        process.stderr.write(`Credential user: ${credential.userName ?? ''} (${credential.userId ?? 'unknown'})\n`);
      }
    }
  } catch {
    // Let normal command error handling explain missing setup on explicit commands.
  }
}

program.parseAsync(process.argv).catch((err: unknown) => {
  const logger = createLogger();
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
