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
const CREDENTIAL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const DEFAULT_CREDENTIAL_NAME = 'default';

export type CacheTarget = 'local' | 'user' | 'global';

export interface Config {
  accessToken?: string;
  consumerKey?: string;
  consumerSecret?: string;
  activeProfile?: string;
  activeCredential?: string;
  defaultCredential?: string;
  credentials?: Record<string, Credential>;
}

export interface Credential {
  accessToken?: string;
  consumerKey?: string;
  consumerSecret?: string;
  userId?: number;
  userName?: string;
  lastUsedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Profile {
  locked?: boolean;
  createExpenses?: boolean;
  updateExpenses?: boolean;
  deleteExpenses?: boolean;
  limitExpensesToGroupIds?: number[] | null;
  limitExpensesToFriendIds?: number[] | null;
  credential?: string;
  offlineEnabled?: boolean;
  preferredCacheTarget?: CacheTarget;
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

function ensureValidCredentialNameOrExit(name: string, cmd?: Command): void {
  const logger = createLogger(cmd, 'login');
  if (!CREDENTIAL_NAME_RE.test(name)) {
    logger.error(`Invalid credential name "${name}". Use letters, numbers, dot, underscore, or dash.`);
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
    ['offlineEnabled', profile.offlineEnabled],
  ];

  for (const [field, value] of checks) {
    const err = boolFieldError(field, value);
    if (err) errors.push(err);
  }

  const groupsErr = restrictionFieldError('limitExpensesToGroupIds', profile.limitExpensesToGroupIds);
  if (groupsErr) errors.push(groupsErr);

  const friendsErr = restrictionFieldError('limitExpensesToFriendIds', profile.limitExpensesToFriendIds);
  if (friendsErr) errors.push(friendsErr);

  if (profile.credential !== undefined) {
    if (typeof profile.credential !== 'string' || profile.credential.trim().length === 0) {
      errors.push('credential must be a non-empty string when provided.');
    } else if (!CREDENTIAL_NAME_RE.test(profile.credential)) {
      errors.push('credential name contains invalid characters.');
    }
  }

  if (profile.preferredCacheTarget !== undefined) {
    if (!['local', 'user', 'global'].includes(profile.preferredCacheTarget)) {
      errors.push('preferredCacheTarget must be one of: local, user, global.');
    }
  }

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

function credentialValidationErrors(name: string, credential: Credential): string[] {
  const errors: string[] = [];
  if (!credential.accessToken && !(credential.consumerKey && credential.consumerSecret)) {
    errors.push(`Credential "${name}" must provide either accessToken or consumerKey+consumerSecret.`);
  }
  if (credential.accessToken && (credential.consumerKey || credential.consumerSecret)) {
    errors.push(`Credential "${name}" cannot store token and oauth fields at the same time.`);
  }
  return errors;
}

function listCredentialNamesFromConfig(config: Config): string[] {
  return Object.keys(config.credentials ?? {}).sort((a, b) => a.localeCompare(b));
}

function sanitizeConfigForSave(config: Config): Config {
  const next: Config = { ...config };
  const names = listCredentialNamesFromConfig(next);
  if (names.length > 0) {
    delete next.accessToken;
    delete next.consumerKey;
    delete next.consumerSecret;
  }
  return next;
}

function migrateLegacyCredentials(config: Config): Config {
  const existingNames = listCredentialNamesFromConfig(config);
  const hasLegacyToken = Boolean(config.accessToken);
  const hasLegacyOAuth = Boolean(config.consumerKey && config.consumerSecret);
  if (existingNames.length > 0 || (!hasLegacyToken && !hasLegacyOAuth)) {
    return config;
  }

  const now = new Date().toISOString();
  const migrated: Credential = hasLegacyToken
    ? {
      accessToken: config.accessToken,
      createdAt: now,
      updatedAt: now,
    }
    : {
      consumerKey: config.consumerKey,
      consumerSecret: config.consumerSecret,
      createdAt: now,
      updatedAt: now,
    };

  return {
    ...config,
    credentials: {
      [DEFAULT_CREDENTIAL_NAME]: migrated,
    },
    activeCredential: config.activeCredential ?? DEFAULT_CREDENTIAL_NAME,
    defaultCredential: config.defaultCredential ?? DEFAULT_CREDENTIAL_NAME,
  };
}

function normalizeCredentialPointers(config: Config): Config {
  const names = listCredentialNamesFromConfig(config);
  if (names.length === 0) return config;

  const next: Config = { ...config };
  if (!next.defaultCredential || !names.includes(next.defaultCredential)) {
    next.defaultCredential = names.includes(DEFAULT_CREDENTIAL_NAME) ? DEFAULT_CREDENTIAL_NAME : names[0];
  }
  if (!next.activeCredential || !names.includes(next.activeCredential)) {
    next.activeCredential = next.defaultCredential;
  }
  return next;
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
  const parsed = parseJson<Config>(CONFIG_PATH);
  return normalizeCredentialPointers(migrateLegacyCredentials(parsed));
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const normalized = normalizeCredentialPointers(config);
  const sanitized = sanitizeConfigForSave(normalized);
  writeFileSync(CONFIG_PATH, JSON.stringify(sanitized, null, 2), { mode: 0o600 });
}

export function listCredentialNames(): string[] {
  return listCredentialNamesFromConfig(loadConfig());
}

export function getCredential(name: string, cmd?: Command): Credential {
  ensureValidCredentialNameOrExit(name, cmd);
  const config = loadConfig();
  const credential = config.credentials?.[name];
  if (!credential) {
    const logger = createLogger(cmd, 'login');
    logger.error(`Credential "${name}" does not exist in ${CONFIG_PATH}.`);
    process.exit(1);
  }
  return credential;
}

export function setTokenCredential(name: string, accessToken: string, cmd?: Command): void {
  ensureValidCredentialNameOrExit(name, cmd);
  const config = loadConfig();
  const now = new Date().toISOString();
  const previous = config.credentials?.[name];
  const next: Credential = {
    accessToken,
    userId: previous?.userId,
    userName: previous?.userName,
    lastUsedAt: previous?.lastUsedAt,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  const errors = credentialValidationErrors(name, next);
  if (errors.length > 0) {
    const logger = createLogger(cmd, 'login');
    logger.error(errors.join(' '));
    process.exit(1);
  }
  config.credentials = { ...(config.credentials ?? {}), [name]: next };
  config.activeCredential = config.activeCredential ?? name;
  config.defaultCredential = config.defaultCredential ?? name;
  saveConfig(config);
}

export function setOauthCredential(name: string, consumerKey: string, consumerSecret: string, cmd?: Command): void {
  ensureValidCredentialNameOrExit(name, cmd);
  const config = loadConfig();
  const now = new Date().toISOString();
  const previous = config.credentials?.[name];
  const next: Credential = {
    consumerKey,
    consumerSecret,
    userId: previous?.userId,
    userName: previous?.userName,
    lastUsedAt: previous?.lastUsedAt,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  const errors = credentialValidationErrors(name, next);
  if (errors.length > 0) {
    const logger = createLogger(cmd, 'login');
    logger.error(errors.join(' '));
    process.exit(1);
  }
  config.credentials = { ...(config.credentials ?? {}), [name]: next };
  config.activeCredential = config.activeCredential ?? name;
  config.defaultCredential = config.defaultCredential ?? name;
  saveConfig(config);
}

export function setActiveCredential(name: string, cmd?: Command): void {
  ensureValidCredentialNameOrExit(name, cmd);
  const config = loadConfig();
  if (!config.credentials?.[name]) {
    const logger = createLogger(cmd, 'login');
    logger.error(`Credential "${name}" does not exist in ${CONFIG_PATH}.`);
    process.exit(1);
  }
  config.activeCredential = name;
  saveConfig(config);
}

export function setDefaultCredential(name: string, cmd?: Command): void {
  ensureValidCredentialNameOrExit(name, cmd);
  const config = loadConfig();
  if (!config.credentials?.[name]) {
    const logger = createLogger(cmd, 'login');
    logger.error(`Credential "${name}" does not exist in ${CONFIG_PATH}.`);
    process.exit(1);
  }
  config.defaultCredential = name;
  saveConfig(config);
}

export function removeCredential(name: string, cmd?: Command): void {
  ensureValidCredentialNameOrExit(name, cmd);
  const config = loadConfig();
  if (!config.credentials?.[name]) {
    const logger = createLogger(cmd, 'login');
    logger.error(`Credential "${name}" does not exist in ${CONFIG_PATH}.`);
    process.exit(1);
  }

  const nextCredentials = { ...config.credentials };
  delete nextCredentials[name];
  const remainingNames = Object.keys(nextCredentials).sort((a, b) => a.localeCompare(b));

  config.credentials = nextCredentials;
  if (remainingNames.length === 0) {
    delete config.activeCredential;
    delete config.defaultCredential;
  } else {
    if (config.activeCredential === name) {
      config.activeCredential = remainingNames[0];
    }
    if (config.defaultCredential === name) {
      config.defaultCredential = remainingNames[0];
    }
  }
  saveConfig(config);
}

function resolveRequestedCredentialName(cmd?: Command): string | undefined {
  return (cmd?.optsWithGlobals() as { credential?: string } | undefined)?.credential;
}

export function resolveCredentialName(cmd?: Command, explicitName?: string): string {
  const config = loadConfig();
  const requested = explicitName ?? resolveRequestedCredentialName(cmd);
  if (requested) ensureValidCredentialNameOrExit(requested, cmd);

  const profileCredential = resolveProfile(cmd).profile.credential;
  const selected = resolveCredentialNameFromInputs({
    requested,
    profileCredential,
    activeCredential: config.activeCredential,
    defaultCredential: config.defaultCredential,
  });

  if (!selected) {
    const logger = createLogger(cmd, 'login');
    logger.error('Not logged in. Run splitwise-cli login token <token> first.');
    process.exit(1);
  }

  ensureValidCredentialNameOrExit(selected, cmd);
  if (!config.credentials?.[selected]) {
    const logger = createLogger(cmd, 'login');
    logger.error(`Credential "${selected}" does not exist in ${CONFIG_PATH}.`);
    process.exit(1);
  }

  return selected;
}

export function resolveCredentialNameFromInputs(input: {
  requested?: string;
  profileCredential?: string;
  activeCredential?: string;
  defaultCredential?: string;
}): string | null {
  return input.requested
    ?? input.profileCredential
    ?? input.activeCredential
    ?? input.defaultCredential
    ?? null;
}

export function resolveCredential(cmd?: Command, explicitName?: string): { name: string; credential: Credential } {
  const name = resolveCredentialName(cmd, explicitName);
  const config = loadConfig();
  const credential = config.credentials?.[name];
  if (!credential) {
    const logger = createLogger(cmd, 'login');
    logger.error(`Credential "${name}" does not exist in ${CONFIG_PATH}.`);
    process.exit(1);
  }
  return { name, credential };
}

const usedCredentialNamesInProcess = new Set<string>();

function markCredentialUsed(name: string): void {
  if (usedCredentialNamesInProcess.has(name)) return;
  usedCredentialNamesInProcess.add(name);

  const config = loadConfig();
  const credential = config.credentials?.[name];
  if (!credential) return;

  const now = new Date().toISOString();
  config.credentials = {
    ...(config.credentials ?? {}),
    [name]: {
      ...credential,
      lastUsedAt: now,
      updatedAt: now,
    },
  };
  saveConfig(config);
}

export function setCredentialIdentity(name: string, userId: number, userName: string): void {
  const config = loadConfig();
  const credential = config.credentials?.[name];
  if (!credential) return;
  const now = new Date().toISOString();
  config.credentials = {
    ...(config.credentials ?? {}),
    [name]: {
      ...credential,
      userId,
      userName,
      updatedAt: now,
    },
  };
  saveConfig(config);
}

export function maskCredentialToken(credential: Credential): string {
  const raw = credential.accessToken ?? credential.consumerKey ?? '';
  if (raw.length === 0) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}****${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}****${raw.slice(-3)}`;
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

export function resolveEffectiveOffline(input: {
  requestedOffline?: boolean;
  profileOfflineEnabled?: boolean;
}): boolean {
  if (input.requestedOffline === true) return true;
  return input.profileOfflineEnabled === true;
}

export function resolveEffectiveCacheTarget(input: {
  requestedTarget?: string;
  profilePreferredTarget?: CacheTarget;
}): CacheTarget {
  if (input.requestedTarget === 'local' || input.requestedTarget === 'user' || input.requestedTarget === 'global') {
    return input.requestedTarget;
  }
  if (input.profilePreferredTarget) return input.profilePreferredTarget;
  return 'local';
}

export function resolveOfflineMode(cmd?: Command): boolean {
  const requestedOffline = (cmd?.optsWithGlobals() as { offline?: boolean } | undefined)?.offline;
  const { profile } = resolveProfile(cmd);
  return resolveEffectiveOffline({
    requestedOffline,
    profileOfflineEnabled: profile.offlineEnabled,
  });
}

export function getLocalCacheRootPath(): string {
  return join(process.cwd(), '.splitwise');
}

export function getUserCacheRootPath(): string {
  return join(CONFIG_DIR, 'cache');
}

export function getGlobalCacheRootPath(): string {
  return process.env.APPDATA
    ? join(process.env.APPDATA, 'splitwise-cli')
    : join(CONFIG_DIR, 'cache-global');
}

export function getCacheRootPath(target: CacheTarget): string {
  if (target === 'local') return getLocalCacheRootPath();
  if (target === 'user') return getUserCacheRootPath();
  return getGlobalCacheRootPath();
}

export function getCacheManifestPath(target: CacheTarget): string {
  return join(getCacheRootPath(target), 'manifest.json');
}

export function ensureCacheRoot(target: CacheTarget): string {
  const root = getCacheRootPath(target);
  mkdirSync(root, { recursive: true });
  return root;
}

export function resolveCacheTarget(cmd?: Command, explicitTarget?: string): CacheTarget {
  const { profile } = resolveProfile(cmd);
  return resolveEffectiveCacheTarget({
    requestedTarget: explicitTarget,
    profilePreferredTarget: profile.preferredCacheTarget,
  });
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
  if (activeProfile.credential) {
    const config = loadConfig();
    if (!config.credentials?.[activeProfile.credential]) {
      activeErrors.push(`Profile "${activeName}": credential "${activeProfile.credential}" does not exist.`);
    }
  }
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
    if (requestedProfile.credential) {
      const config = loadConfig();
      if (!config.credentials?.[requestedProfile.credential]) {
        requestedErrors.push(`Profile "${requested}": credential "${requestedProfile.credential}" does not exist.`);
      }
    }
    if (requestedErrors.length > 0) {
      logger.error(requestedErrors.join(' '));
      process.exit(1);
    }
    ensureProfileSwitchAllowedOrExit(activeName, activeProfile, requested, cmd);
  }
}

export function ensureLoginWritable(cmd?: Command): void {
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

export function getClient(cmd?: Command, explicitCredentialName?: string): Splitwise {
  const logger = createLogger(cmd, 'client');
  if (resolveOfflineMode(cmd)) {
    logger.error('Offline mode is active. This command cannot contact Splitwise. Export data first with the cache feature or rerun without --offline.');
    process.exit(1);
  }
  const hooks = createHttpHooks(logger);
  const { name, credential } = resolveCredential(cmd, explicitCredentialName);
  const trackedHooks = {
    ...hooks,
    onResponse(event: ResponseHookEvent) {
      hooks.onResponse(event);
      if (event.status >= 200 && event.status < 300) {
        markCredentialUsed(name);
      }
    },
  };
  if (credential.accessToken) {
    return new Splitwise({ accessToken: credential.accessToken, hooks: trackedHooks });
  }
  if (credential.consumerKey && credential.consumerSecret) {
    return new Splitwise({
      consumerKey: credential.consumerKey,
      consumerSecret: credential.consumerSecret,
      hooks: trackedHooks,
    });
  }
  logger.error(`Credential "${name}" is incomplete. Run splitwise-cli login token <token> or splitwise-cli login oauth <consumerKey> <consumerSecret>.`);
  process.exit(1);
}
