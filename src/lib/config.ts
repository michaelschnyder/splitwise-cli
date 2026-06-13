import { Splitwise } from 'splitwise';
import type { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './output.js';

const CONFIG_DIR = join(homedir(), '.splitwise-cli');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const PROFILES_DIR = join(CONFIG_DIR, 'profiles');

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface Config {
  accessToken?: string;
  consumerKey?: string;
  consumerSecret?: string;
  activeProfile?: string;
}

export interface Profile {
  locked?: boolean;
  createExpenses?: boolean;
  updateExpenses?: boolean;
  deleteExpenses?: boolean;
  limitExpensesToGroupIds?: number[] | null;
  limitExpensesToFriendIds?: number[] | null;
}

export type ResolvedProfile = {
  name: string;
  profile: Profile;
  activeName: string;
  activeProfile: Profile;
};

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

function defaultProfile(): Profile {
  return {};
}

function parseJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function profilePath(name: string): string {
  return join(PROFILES_DIR, `${name}.json`);
}

function profileFileExists(name: string): boolean {
  return existsSync(profilePath(name));
}

function ensureValidProfileNameOrExit(name: string, cmd?: Command): void {
  const logger = createLogger(cmd, 'profiles');
  if (!PROFILE_NAME_RE.test(name)) {
    logger.error(`Invalid profile name "${name}". Use letters, numbers, dot, underscore, or dash.`);
    process.exit(1);
  }
}

function restrictionFieldError(
  fieldName: 'limitExpensesToGroupIds' | 'limitExpensesToFriendIds',
  value: unknown,
): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return `${fieldName} must be an array, null, or omitted.`;
  for (const entry of value) {
    if (!Number.isInteger(entry) || (entry as number) <= 0) {
      return `${fieldName} must contain only positive integer ids.`;
    }
  }
  return null;
}

function boolFieldError(name: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') return `${name} must be a boolean when provided.`;
  return null;
}

function profileValidationErrors(name: string, profile: Profile): string[] {
  const errors: string[] = [];

  const checks: Array<[string, unknown]> = [
    ['locked', profile.locked],
    ['createExpenses', profile.createExpenses],
    ['updateExpenses', profile.updateExpenses],
    ['deleteExpenses', profile.deleteExpenses],
  ];

  for (const [field, value] of checks) {
    const err = boolFieldError(field, value);
    if (err) errors.push(err);
  }

  const groupsErr = restrictionFieldError('limitExpensesToGroupIds', profile.limitExpensesToGroupIds);
  if (groupsErr) errors.push(groupsErr);

  const friendsErr = restrictionFieldError('limitExpensesToFriendIds', profile.limitExpensesToFriendIds);
  if (friendsErr) errors.push(friendsErr);

  if (errors.length > 0) {
    return errors.map((line) => `Profile "${name}": ${line}`);
  }
  return errors;
}

function lockRecoveryMessage(name: string): string {
  const path = profilePath(name);
  return `Active profile "${name}" is locked. Edit ${path} and set "locked" to false, or remove the file manually.`;
}

export function getLockRecoveryMessage(name: string): string {
  return lockRecoveryMessage(name);
}

function ensureProfileExistsOrExit(name: string, cmd?: Command): void {
  if (name === 'default') return;
  if (profileFileExists(name)) return;
  const logger = createLogger(cmd, 'profiles');
  logger.error(`Profile "${name}" does not exist. Expected file: ${profilePath(name)}`);
  process.exit(1);
}

function restrictionAllows(list: number[] | null | undefined, id: number): boolean {
  if (list === undefined || list === null) return true;
  return list.includes(id);
}

function loadProfileFromDisk(name: string): Profile {
  if (name === 'default' && !profileFileExists(name)) {
    return defaultProfile();
  }
  const path = profilePath(name);
  return parseJson<Profile>(path);
}

function resolveRequestedProfileName(cmd?: Command): string | undefined {
  return (cmd?.optsWithGlobals() as { profile?: string } | undefined)?.profile;
}

function loadActiveProfileOrExit(cmd?: Command): { activeName: string; activeProfile: Profile } {
  const config = loadConfig();
  const activeName = config.activeProfile ?? 'default';
  ensureValidProfileNameOrExit(activeName, cmd);
  ensureProfileExistsOrExit(activeName, cmd);
  const activeProfile = loadProfileFromDisk(activeName);
  return { activeName, activeProfile };
}

function ensureProfileSwitchAllowedOrExit(
  activeName: string,
  activeProfile: Profile,
  requested: string | undefined,
  cmd?: Command,
): void {
  if (!requested) return;
  if (requested === activeName) return;
  if (!activeProfile.locked) return;

  const logger = createLogger(cmd, 'profiles');
  logger.error(lockRecoveryMessage(activeName));
  process.exit(1);
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  return parseJson<Config>(CONFIG_PATH);
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getConfigDirPath(): string {
  return CONFIG_DIR;
}

export function getProfilesDirPath(): string {
  return PROFILES_DIR;
}

export function getProfilePath(name: string): string {
  return profilePath(name);
}

export function listProfileNames(): string[] {
  const names = new Set<string>(['default']);
  if (existsSync(PROFILES_DIR)) {
    for (const entry of readdirSync(PROFILES_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      names.add(entry.name.slice(0, -5));
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export function loadProfile(name: string, cmd?: Command): Profile {
  ensureValidProfileNameOrExit(name, cmd);
  ensureProfileExistsOrExit(name, cmd);
  return loadProfileFromDisk(name);
}

export function saveProfile(name: string, profile: Profile, cmd?: Command): void {
  ensureValidProfileNameOrExit(name, cmd);
  const logger = createLogger(cmd, 'profiles');
  const errors = profileValidationErrors(name, profile);
  if (errors.length > 0) {
    logger.error(`Profile validation failed: ${errors.join(' ')}`);
    process.exit(1);
  }

  mkdirSync(PROFILES_DIR, { recursive: true });
  writeFileSync(profilePath(name), JSON.stringify(profile, null, 2), { mode: 0o600 });
}

export function removeProfile(name: string, cmd?: Command): void {
  ensureValidProfileNameOrExit(name, cmd);
  if (name === 'default') {
    if (profileFileExists(name)) unlinkSync(profilePath(name));
    const config = loadConfig();
    if ((config.activeProfile ?? 'default') === 'default') {
      delete config.activeProfile;
      saveConfig(config);
    }
    return;
  }

  ensureProfileExistsOrExit(name, cmd);
  unlinkSync(profilePath(name));

  const config = loadConfig();
  if (config.activeProfile === name) {
    delete config.activeProfile;
    saveConfig(config);
  }
}

export function setActiveProfile(name: string, cmd?: Command): void {
  ensureValidProfileNameOrExit(name, cmd);
  ensureProfileExistsOrExit(name, cmd);
  const config = loadConfig();
  config.activeProfile = name;
  saveConfig(config);
}

export function resolveProfile(cmd?: Command): ResolvedProfile {
  const { activeName, activeProfile } = loadActiveProfileOrExit(cmd);
  const requested = resolveRequestedProfileName(cmd);
  if (requested) ensureValidProfileNameOrExit(requested, cmd);
  if (requested) ensureProfileExistsOrExit(requested, cmd);

  ensureProfileSwitchAllowedOrExit(activeName, activeProfile, requested, cmd);

  const selectedName = requested ?? activeName;
  const selectedProfile = selectedName === activeName
    ? activeProfile
    : loadProfileFromDisk(selectedName);

  return {
    name: selectedName,
    profile: selectedProfile,
    activeName,
    activeProfile,
  };
}

export function validateSelectedProfileOrExit(cmd?: Command): void {
  const logger = createLogger(cmd, 'profiles');
  const config = loadConfig();
  const activeName = config.activeProfile ?? 'default';

  ensureValidProfileNameOrExit(activeName, cmd);
  ensureProfileExistsOrExit(activeName, cmd);

  const activeProfile = loadProfileFromDisk(activeName);
  const activeErrors = profileValidationErrors(activeName, activeProfile);
  if (activeErrors.length > 0) {
    logger.error(activeErrors.join(' '));
    process.exit(1);
  }

  const requested = resolveRequestedProfileName(cmd);
  if (requested) {
    ensureValidProfileNameOrExit(requested, cmd);
    ensureProfileExistsOrExit(requested, cmd);
    const requestedProfile = loadProfileFromDisk(requested);
    const requestedErrors = profileValidationErrors(requested, requestedProfile);
    if (requestedErrors.length > 0) {
      logger.error(requestedErrors.join(' '));
      process.exit(1);
    }
    ensureProfileSwitchAllowedOrExit(activeName, activeProfile, requested, cmd);
  }
}

export function ensureAuthWritable(cmd?: Command): void {
  const logger = createLogger(cmd, 'profiles');
  const { activeName, activeProfile } = resolveProfile(cmd);
  if (!activeProfile.locked) return;
  logger.error(lockRecoveryMessage(activeName));
  process.exit(1);
}

export function ensureProfileMutable(name: string, cmd?: Command): void {
  const logger = createLogger(cmd, 'profiles');
  const { activeName, activeProfile } = resolveProfile(cmd);

  if (activeProfile.locked) {
    logger.error(lockRecoveryMessage(activeName));
    process.exit(1);
  }
}

export function ensureProfileSwitchable(targetName: string, cmd?: Command): void {
  const logger = createLogger(cmd, 'profiles');
  const { activeName, activeProfile } = resolveProfile(cmd);
  if (targetName === activeName) return;
  if (!activeProfile.locked) return;
  logger.error(lockRecoveryMessage(activeName));
  process.exit(1);
}

export function ensureExpenseGroupAllowed(cmd: Command | undefined, groupId: number, context: string): void {
  const logger = createLogger(cmd, 'profiles');
  const { name, profile } = resolveProfile(cmd);
  if (restrictionAllows(profile.limitExpensesToGroupIds, groupId)) return;
  logger.error(`Profile "${name}" blocks group ${groupId} for ${context}. Update ${profilePath(name)}.`);
  process.exit(1);
}

export function ensureExpenseFriendAllowed(cmd: Command | undefined, friendId: number, context: string): void {
  const logger = createLogger(cmd, 'profiles');
  const { name, profile } = resolveProfile(cmd);
  if (restrictionAllows(profile.limitExpensesToFriendIds, friendId)) return;
  logger.error(`Profile "${name}" blocks friend ${friendId} for ${context}. Update ${profilePath(name)}.`);
  process.exit(1);
}

export function filterAllowedExpenseGroupIds(cmd: Command | undefined, ids: number[]): number[] {
  const { profile } = resolveProfile(cmd);
  if (profile.limitExpensesToGroupIds === undefined || profile.limitExpensesToGroupIds === null) return ids;
  return ids.filter((id) => profile.limitExpensesToGroupIds!.includes(id));
}

export function filterAllowedExpenseFriendIds(cmd: Command | undefined, ids: number[]): number[] {
  const { profile } = resolveProfile(cmd);
  if (profile.limitExpensesToFriendIds === undefined || profile.limitExpensesToFriendIds === null) return ids;
  return ids.filter((id) => profile.limitExpensesToFriendIds!.includes(id));
}

export function ensureExpenseOperationAllowed(
  cmd: Command | undefined,
  operation: 'create' | 'update' | 'delete',
): void {
  const logger = createLogger(cmd, 'profiles');
  const { name, profile } = resolveProfile(cmd);
  const fieldMap = {
    create: profile.createExpenses,
    update: profile.updateExpenses,
    delete: profile.deleteExpenses,
  } as const;

  const allowed = fieldMap[operation];
  if (allowed === undefined || allowed === true) return;
  logger.error(`Profile "${name}" blocks ${operation} expense operations. Update ${profilePath(name)}.`);
  process.exit(1);
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
