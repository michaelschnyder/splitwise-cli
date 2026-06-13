import { Command } from 'commander';
import { loadConfig, saveConfig, getClient } from '../lib/config.js';
import {
  addOutputOption, getFormat, formatName, renderOne,
  isTuiDefault, colorize, createTuiProgress,
} from '../lib/output.js';

export function registerAuth(program: Command): void {
  const auth = program.command('auth').description('Manage authentication');

  auth
    .command('set-token <token>')
    .description('Save a pre-obtained Splitwise access token')
    .action((token: string) => {
      const config = loadConfig();
      config.accessToken = token;
      delete config.consumerKey;
      delete config.consumerSecret;
      saveConfig(config);
      console.log('Access token saved.');
    });

  auth
    .command('set-oauth <consumerKey> <consumerSecret>')
    .description('Save OAuth consumer key and secret (Client Credentials flow)')
    .action((consumerKey: string, consumerSecret: string) => {
      const config = loadConfig();
      config.consumerKey = consumerKey;
      config.consumerSecret = consumerSecret;
      delete config.accessToken;
      saveConfig(config);
      console.log('OAuth credentials saved.');
    });

  addOutputOption(auth.command('whoami'))
    .description('Show the currently authenticated user')
    .action(async function (this: Command) {
      const sw = getClient();
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      if (tuiMode) console.log(colorize('Showing currently authenticated user', 'cyan'));
      const progress = createTuiProgress(tuiMode);
      progress.start('Fetching user profile...');
      const me = await sw.users.getCurrent();
      progress.stop(colorize('Fetched user profile.', 'green'));
      renderOne(
        { id: me.id, name: formatName(me), email: me.email },
        fmt,
      );
    });
}
