import { Splitwise } from 'splitwise';
import type { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './output.js';

const CONFIG_DIR = join(homedir(), '.splitwise-cli');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export interface Config {
  accessToken?: string;
  consumerKey?: string;
  consumerSecret?: string;
}

type RequestHookEvent = {
  method: string;
  url: string;
  attempt: number;
};

type ResponseHookEvent = RequestHookEvent & {
  status: number;
  durationMs: number;
};

type ErrorHookEvent = RequestHookEvent & {
  error: unknown;
  durationMs: number;
};

function statusMessage(status: number): string {
  if (status >= 500) return 'server error';
  if (status >= 400) return 'client error';
  if (status >= 300) return 'redirect';
  if (status >= 200) return 'ok';
  return 'unknown';
}

function sanitizeUrlForLog(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    const [withoutQuery] = raw.split('?');
    const [withoutHash] = withoutQuery.split('#');
    return withoutHash;
  }
}

function createHttpHooks(logger: ReturnType<typeof createLogger>) {
  const http = logger.withTag('http');
  return {
    onRequest(event: RequestHookEvent) {
      const attempt = event.attempt > 1 ? ` attempt=${event.attempt}` : '';
      const url = sanitizeUrlForLog(event.url);
      http.debug(`request ${event.method} ${url}${attempt}`);
    },
    onResponse(event: ResponseHookEvent) {
      const msg = statusMessage(event.status);
      const url = sanitizeUrlForLog(event.url);
      const line = `response ${event.method} ${url} -> ${event.status} (${msg}) ${event.durationMs}ms`;
      if (event.status >= 500) http.error(line);
      else if (event.status >= 400) http.warn(line);
      else http.debug(line);
    },
    onError(event: ErrorHookEvent) {
      const url = sanitizeUrlForLog(event.url);
      const message = event.error instanceof Error ? event.error.message : String(event.error);
      http.error(`error ${event.method} ${url} (${event.durationMs}ms): ${message}`);
    },
  };
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Config;
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getClient(cmd?: Command): Splitwise {
  const logger = createLogger(cmd, 'client');
  const hooks = createHttpHooks(logger);
  const config = loadConfig();
  if (config.accessToken) {
    return new Splitwise({ accessToken: config.accessToken, hooks });
  }
  if (config.consumerKey && config.consumerSecret) {
    return new Splitwise({
      consumerKey: config.consumerKey,
      consumerSecret: config.consumerSecret,
      hooks,
    });
  }
  logger.error('Not authenticated. Run splitwise-cli auth set-token <token> first.');
  process.exit(1);
}
