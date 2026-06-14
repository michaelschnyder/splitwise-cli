import { Command } from 'commander';
import {
  ensureLoginWritable,
  getDataClient,
  listCredentialNames,
  loadConfig,
  maskCredentialToken,
  removeCredential,
  resolveCredential,
  setActiveCredential,
  setCredentialIdentity,
  setDefaultCredential,
  setOauthCredential,
  setTokenCredential,
} from '../lib/config.js';
import {
  addOutputOption, getFormat, formatName, renderOne,
  isTuiDefault, createTuiProgress, createLogger, writeTuiInfoSpacer, render,
} from '../lib/output.js';

type CredentialNameOption = {
  name?: string;
};

function resolvedCredentialName(input?: string): string {
  const raw = (input ?? '').trim();
  return raw.length > 0 ? raw : 'default';
}

export function registerLogin(program: Command): void {
  const login = program.command('login').description('Manage stored login credentials');

  login
    .command('token <token>')
    .description('Save a Splitwise access token for a named login credential')
    .option('--name <name>', 'Credential name (default: default)')
    .action(function (this: Command, token: string, options: CredentialNameOption) {
      ensureLoginWritable(this);
      const logger = createLogger(this, 'login');
      const name = resolvedCredentialName(options.name);
      setTokenCredential(name, token, this);
      logger.success(`Saved token credential "${name}".`);
    });

  login
    .command('oauth <consumerKey> <consumerSecret>')
    .description('Save OAuth key and secret for a named login credential')
    .option('--name <name>', 'Credential name (default: default)')
    .action(function (this: Command, consumerKey: string, consumerSecret: string, options: CredentialNameOption) {
      ensureLoginWritable(this);
      const logger = createLogger(this, 'login');
      const name = resolvedCredentialName(options.name);
      setOauthCredential(name, consumerKey, consumerSecret, this);
      logger.success(`Saved OAuth credential "${name}".`);
    });

  addOutputOption(login.command('list'))
    .description('List stored login credentials')
    .action(function (this: Command) {
      const fmt = getFormat(this);
      const config = loadConfig();
      const names = listCredentialNames();
      const rows = names.map((name) => {
        const credential = config.credentials?.[name] ?? {};
        const selected = config.activeCredential === name ? 'yes' : 'no';
        const fallback = config.defaultCredential === name ? 'yes' : 'no';
        return {
          name,
          token: maskCredentialToken(credential),
          userId: credential.userId ?? null,
          userName: credential.userName ?? '',
          selected,
          default: fallback,
          lastUsed: credential.lastUsedAt ?? '',
        };
      });
      render(rows, fmt);
    });

  addOutputOption(login.command('status [name]'))
    .description('Show login status for one credential (defaults to active credential)')
    .action(function (this: Command, name?: string) {
      const fmt = getFormat(this);
      const config = loadConfig();
      const target = resolvedCredentialName(name ?? config.activeCredential ?? config.defaultCredential);
      const credential = config.credentials?.[target];
      if (!credential) {
        const logger = createLogger(this, 'login');
        logger.error(`Credential "${target}" does not exist.`);
        process.exit(1);
      }

      renderOne(
        {
          name: target,
          token: maskCredentialToken(credential),
          userId: credential.userId ?? null,
          userName: credential.userName ?? '',
          selected: config.activeCredential === target,
          default: config.defaultCredential === target,
          lastUsedAt: credential.lastUsedAt ?? null,
          createdAt: credential.createdAt ?? null,
          updatedAt: credential.updatedAt ?? null,
        },
        fmt,
        { tuiMode: isTuiDefault(this) },
      );
    });

  login
    .command('select <name>')
    .description('Set the active login credential')
    .action(function (this: Command, name: string) {
      ensureLoginWritable(this);
      const logger = createLogger(this, 'login');
      setActiveCredential(name, this);
      logger.success(`Active credential set to "${name}".`);
    });

  login
    .command('default <name>')
    .description('Set the default login credential')
    .action(function (this: Command, name: string) {
      ensureLoginWritable(this);
      const logger = createLogger(this, 'login');
      setDefaultCredential(name, this);
      logger.success(`Default credential set to "${name}".`);
    });

  login
    .command('remove <name>')
    .description('Remove a stored login credential by name')
    .action(function (this: Command, name: string) {
      ensureLoginWritable(this);
      const logger = createLogger(this, 'login');
      removeCredential(name, this);
      logger.success(`Removed credential "${name}".`);
    });

  addOutputOption(login.command('whoami'))
    .description('Show the current user for the resolved login')
    .action(async function (this: Command) {
      const { name: credentialName } = resolveCredential(this);
      const sw = getDataClient(this);
      const logger = createLogger(this, 'login');
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      if (tuiMode) {
        writeTuiInfoSpacer(true);
        logger.info(`Showing currently logged-in user for credential "${credentialName}"`);
      }
      const progress = createTuiProgress(tuiMode);
      let me;
      progress.start('Fetching user profile...');
      try {
        me = await sw.users.getCurrent();
      } catch (err) {
        progress.fail('Failed to fetch user profile.');
        throw err;
      }
      progress.stop('Fetched user profile.', 'success');
      setCredentialIdentity(credentialName, me.id, formatName(me));
      renderOne(
        { credential: credentialName, id: me.id, name: formatName(me), email: me.email },
        fmt,
        { tuiMode },
      );
    });

  login
    .command('validate [name]')
    .description('Validate a login credential by calling whoami')
    .action(async function (this: Command, name?: string) {
      const logger = createLogger(this, 'login');
      const targetName = resolveCredential(this, name).name;
      const sw = getDataClient(this, name);
      try {
        const me = await sw.users.getCurrent();
        setCredentialIdentity(targetName, me.id, formatName(me));
        logger.success(`Credential "${targetName}" is valid for ${formatName(me)}.`);
      } catch (err) {
        logger.error(`Credential "${targetName}" is not valid: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
