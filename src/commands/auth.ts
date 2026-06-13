import { Command } from 'commander';
import { loadConfig, saveConfig, getClient } from '../lib/config.js';
import {
  addOutputOption, getFormat, formatName, renderOne,
  isTuiDefault, colorize, createTuiProgress, createLogger, writeTuiInfoSpacer,
} from '../lib/output.js';

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('Manage authentication');

  auth
    .command('set-token <token>')
    .description('Save a pre-obtained Splitwise access token')
    .action((token: string) => {
      const logger = createLogger(undefined, 'auth');
      const config = loadConfig();
      config.accessToken = token;
      delete config.consumerKey;
      delete config.consumerSecret;
      saveConfig(config);
      logger.success('Access token saved.');
    });

  auth
    .command('set-oauth <consumerKey> <consumerSecret>')
    .description('Save OAuth consumer key and secret (Client Credentials flow)')
    .action((consumerKey: string, consumerSecret: string) => {
      const logger = createLogger(undefined, 'auth');
      const config = loadConfig();
      config.consumerKey = consumerKey;
      config.consumerSecret = consumerSecret;
      delete config.accessToken;
      saveConfig(config);
      logger.success('OAuth credentials saved.');
    });

  addOutputOption(auth.command('whoami'))
    .description('Show the currently authenticated user')
    .action(async function (this: Command) {
      const sw = getClient(this);
      const logger = createLogger(this, 'auth');
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      if (tuiMode) {
        writeTuiInfoSpacer(true);
        logger.info('Showing currently authenticated user');
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
      renderOne(
        { id: me.id, name: formatName(me), email: me.email },
        fmt,
        { tuiMode },
      );
    });
}
