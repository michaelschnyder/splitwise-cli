import { Splitwise } from 'splitwise';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.splitwise-cli');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export interface Config {
  accessToken?: string;
  consumerKey?: string;
  consumerSecret?: string;
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Config;
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getClient(): Splitwise {
  const config = loadConfig();
  if (config.accessToken) {
    return new Splitwise({ accessToken: config.accessToken });
  }
  if (config.consumerKey && config.consumerSecret) {
    return new Splitwise({
      consumerKey: config.consumerKey,
      consumerSecret: config.consumerSecret,
    });
  }
  console.error('Not authenticated. Run `splitwise-cli auth set-token <token>` first.');
  process.exit(1);
}
