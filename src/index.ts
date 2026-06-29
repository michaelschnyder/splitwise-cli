#!/usr/bin/env node

import { Command } from 'commander';
import { createRequire } from 'node:module';
import figlet from 'figlet';
import { registerLogin } from './commands/login.js';
import { registerFriends } from './commands/friends.js';
import { registerGroups } from './commands/groups.js';
import { registerExpenses } from './commands/expenses.js';
import { registerSkills } from './commands/skills.js';
import { registerProfiles } from './commands/profiles.js';
import { registerCache } from './commands/cache.js';
import { loadConfig, maskCredentialToken, resolveCredentialName, resolveProfile, setConfigDirOverride, validateSelectedProfileOrExit } from './lib/config.js';
import { addCredentialOption, addLoggingOptions, addOfflineOption, addProfileOption, createLogger } from './lib/output.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: string };

const program = new Command();

program
  .name('splitwise-cli')
  .description(figlet.textSync('Splitwise CLI', { horizontalLayout: 'full' }))
  .version(packageJson.version ?? '0.0.0');

addLoggingOptions(program);
addProfileOption(program);
addCredentialOption(program);
addOfflineOption(program);
program.option('--config-dir <path>', 'Override the Splitwise CLI config directory');

function resolveConfigDirFromArgv(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg.startsWith('--config-dir=')) {
      return arg.slice('--config-dir='.length);
    }
    if (arg === '--config-dir') {
      return argv[index + 1];
    }
  }
  return undefined;
}

const argv = process.argv.slice(2);
try {
  setConfigDirOverride(resolveConfigDirFromArgv(argv));
} catch (err) {
  const logger = createLogger();
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

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
registerCache(program);

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
