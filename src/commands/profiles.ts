import prompts from 'prompts';
import { Command } from 'commander';
import {
  type Profile,
  getDataClient,
  getLockRecoveryMessage,
  listCredentialNames,
  getProfilePath,
  listProfileNames,
  loadProfile,
  removeProfile,
  resolveProfile,
  saveProfile,
  setActiveProfile,
  validateSelectedProfileOrExit,
  ensureProfileMutable,
  ensureProfileSwitchable,
} from '../lib/config.js';
import {
  addOutputOption,
  getFormat,
  hasExplicitOutputOption,
  isTuiDefault,
  render,
  renderOne,
  renderTuiList,
  createLogger,
} from '../lib/output.js';

type MutableProfileOptions = {
  createExpenses?: string;
  updateExpenses?: string;
  deleteExpenses?: string;
  limitExpensesToGroups?: string;
  limitExpensesToFriends?: string;
  clearExpenseGroupLimit?: boolean;
  clearExpenseFriendLimit?: boolean;
  profileCredential?: string;
  clearProfileCredential?: boolean;
  offlineEnabled?: string;
  preferredCacheTarget?: string;
  clearPreferredCacheTarget?: boolean;
  apiEndpoint?: string;
  clearApiEndpoint?: boolean;
};

function parseBoolInput(field: string, value: string, logger: ReturnType<typeof createLogger>): boolean {
  const lowered = value.trim().toLowerCase();
  if (lowered === 'yes' || lowered === 'true') return true;
  if (lowered === 'no' || lowered === 'false') return false;
  logger.error(`${field} must be yes|no (or true|false).`);
  process.exit(1);
}

function parseRestrictionTokens(input: string): { mode: 'restrict'; values: string[] } | { mode: 'none' } | { mode: 'clear' } {
  const raw = input.trim();
  const lowered = raw.toLowerCase();
  if (lowered === 'none') return { mode: 'none' };
  if (lowered === 'null' || lowered === 'unrestricted' || lowered === 'all') return { mode: 'clear' };
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return { mode: 'restrict', values };
}

async function chooseMatch(
  kind: 'group' | 'friend',
  token: string,
  options: Array<{ id: number; label: string }>,
): Promise<number> {
  const answer = await prompts({
    type: 'select',
    name: 'id',
    message: `Multiple ${kind}s match "${token}". Choose one:`,
    choices: options.map((o) => ({ title: `${o.label} (${o.id})`, value: o.id })),
  });

  if (typeof answer.id !== 'number') {
    process.exit(1);
  }
  return answer.id;
}

async function resolveIds(
  cmd: Command,
  kind: 'group' | 'friend',
  tokens: string[],
): Promise<number[]> {
  const logger = createLogger(cmd, 'profiles');
  const sw = getDataClient(cmd);
  const interactive = isTuiDefault(cmd) && !hasExplicitOutputOption(cmd);

  if (kind === 'group') {
    const groups = await sw.groups.list();
    const out: number[] = [];

    for (const token of tokens) {
      const asNum = Number(token);
      if (!Number.isNaN(asNum) && String(asNum) === token) {
        out.push(asNum);
        continue;
      }

      const needle = token.toLowerCase();
      const matches = groups
        .filter((g) => g.name.toLowerCase().includes(needle))
        .map((g) => ({ id: g.id, label: g.name }));

      if (matches.length === 0) {
        logger.error(`No ${kind} matches "${token}".`);
        process.exit(1);
      }

      if (matches.length === 1) {
        out.push(matches[0].id);
        continue;
      }

      if (!interactive) {
        logger.error(`Ambiguous ${kind} "${token}". Use an id or run without explicit output mode to choose interactively.`);
        process.exit(1);
      }

      out.push(await chooseMatch(kind, token, matches));
    }

    return [...new Set(out)];
  }

  const friends = await sw.friends.list();
  const out: number[] = [];

  for (const token of tokens) {
    const asNum = Number(token);
    if (!Number.isNaN(asNum) && String(asNum) === token) {
      out.push(asNum);
      continue;
    }

    const needle = token.toLowerCase();
    const matches = friends
      .filter((f) => `${f.firstName ?? ''} ${f.lastName ?? ''}`.toLowerCase().includes(needle))
      .map((f) => ({ id: f.id, label: `${f.firstName ?? ''} ${f.lastName ?? ''}`.trim() }));

    if (matches.length === 0) {
      logger.error(`No ${kind} matches "${token}".`);
      process.exit(1);
    }

    if (matches.length === 1) {
      out.push(matches[0].id);
      continue;
    }

    if (!interactive) {
      logger.error(`Ambiguous ${kind} "${token}". Use an id or run without explicit output mode to choose interactively.`);
      process.exit(1);
    }

    out.push(await chooseMatch(kind, token, matches));
  }

  return [...new Set(out)];
}

async function applyMutableOptions(
  cmd: Command,
  targetName: string,
  baseProfile: Profile,
  options: MutableProfileOptions,
): Promise<Profile> {
  const logger = createLogger(cmd, 'profiles');
  const next: Profile = { ...baseProfile };

  if (options.createExpenses !== undefined) next.createExpenses = parseBoolInput('--create-expenses', options.createExpenses, logger);
  if (options.updateExpenses !== undefined) next.updateExpenses = parseBoolInput('--update-expenses', options.updateExpenses, logger);
  if (options.deleteExpenses !== undefined) next.deleteExpenses = parseBoolInput('--delete-expenses', options.deleteExpenses, logger);
  if (options.offlineEnabled !== undefined) next.offlineEnabled = parseBoolInput('--offline-enabled', options.offlineEnabled, logger);

  if (options.clearExpenseGroupLimit) {
    next.limitExpensesToGroupIds = null;
  }

  if (options.clearExpenseFriendLimit) {
    next.limitExpensesToFriendIds = null;
  }

  if (options.clearProfileCredential) {
    delete next.credential;
  }

  if (options.clearPreferredCacheTarget) {
    delete next.preferredCacheTarget;
  }

  if (options.clearApiEndpoint) {
    delete next.apiEndpoint;
  }

  if (options.profileCredential !== undefined) {
    const name = options.profileCredential.trim();
    const credentials = new Set(listCredentialNames());
    if (!credentials.has(name)) {
      logger.error(`Credential "${name}" does not exist.`);
      process.exit(1);
    }
    next.credential = name;
  }

  if (options.preferredCacheTarget !== undefined) {
    const value = options.preferredCacheTarget.trim().toLowerCase();
    if (value !== 'local' && value !== 'user' && value !== 'global') {
      logger.error('--preferred-cache-target must be one of: local, user, global.');
      process.exit(1);
    }
    next.preferredCacheTarget = value;
  }

  if (options.apiEndpoint !== undefined) {
    const value = options.apiEndpoint.trim();
    try {
      new URL(value);
    } catch {
      logger.error('--api-endpoint must be a valid absolute URL.');
      process.exit(1);
    }
    next.apiEndpoint = value;
  }

  if (options.limitExpensesToGroups !== undefined) {
    const parsed = parseRestrictionTokens(options.limitExpensesToGroups);
    if (parsed.mode === 'none') next.limitExpensesToGroupIds = [];
    else if (parsed.mode === 'clear') next.limitExpensesToGroupIds = null;
    else next.limitExpensesToGroupIds = await resolveIds(cmd, 'group', parsed.values);
  }

  if (options.limitExpensesToFriends !== undefined) {
    const parsed = parseRestrictionTokens(options.limitExpensesToFriends);
    if (parsed.mode === 'none') next.limitExpensesToFriendIds = [];
    else if (parsed.mode === 'clear') next.limitExpensesToFriendIds = null;
    else next.limitExpensesToFriendIds = await resolveIds(cmd, 'friend', parsed.values);
  }

  // Ensure immutable-by-CLI lock semantics are retained once enabled.
  if (baseProfile.locked) next.locked = true;

  const path = getProfilePath(targetName);
  logger.debug(`saving profile at ${path}`);
  return next;
}

function attachMutableOptions(cmd: Command): Command {
  return addOutputOption(cmd)
    .option('--create-expenses <yes|no>', 'Allow creating expenses via API')
    .option('--update-expenses <yes|no>', 'Allow updating expenses via API')
    .option('--delete-expenses <yes|no>', 'Allow deleting expenses via API')
    .option('--offline-enabled <yes|no>', 'Enable offline mode by default for this profile')
    .option('--limit-expenses-to-groups <items>', 'Limit expenses scope to group ids or names (comma-separated). Use none for empty list, null for unrestricted')
    .option('--limit-expenses-to-friends <items>', 'Limit expenses scope to friend ids or names (comma-separated). Use none for empty list, null for unrestricted')
    .option('--clear-expense-group-limit', 'Set expense group scope to unrestricted (null)')
    .option('--clear-expense-friend-limit', 'Set expense friend scope to unrestricted (null)')
    .option('--profile-credential <name>', 'Bind this profile to a credential name')
    .option('--clear-profile-credential', 'Remove bound profile credential')
    .option('--preferred-cache-target <target>', 'Preferred cache target: local | user | global')
    .option('--clear-preferred-cache-target', 'Clear the preferred cache target')
    .option('--api-endpoint <url>', 'Override the Splitwise API base URL for this profile')
    .option('--clear-api-endpoint', 'Clear the API endpoint override');
}

export function registerProfiles(program: Command): void {
  const profiles = program.command('profiles').description('Manage CLI profiles');

  addOutputOption(profiles.command('list'))
    .description('List profiles')
    .action(function (this: Command) {
      const logger = createLogger(this, 'profiles');
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      const startedAt = Date.now();
      const active = resolveProfile(this).name;
      const rows = listProfileNames().map((name) => {
        const profile = loadProfile(name, this);
        return {
          name,
          active: name === active ? 'yes' : 'no',
          credential: profile.credential ?? '',
          locked: profile.locked ? 'yes' : 'no',
          offlineEnabled: profile.offlineEnabled ? 'yes' : 'no',
          preferredCacheTarget: profile.preferredCacheTarget ?? '',
          apiEndpoint: profile.apiEndpoint ?? '',
          createExpenses: profile.createExpenses ?? true,
          updateExpenses: profile.updateExpenses ?? true,
          deleteExpenses: profile.deleteExpenses ?? true,
          expenseGroupLimit: profile.limitExpensesToGroupIds === undefined || profile.limitExpensesToGroupIds === null
            ? 'unrestricted'
            : String(profile.limitExpensesToGroupIds.length),
          expenseFriendLimit: profile.limitExpensesToFriendIds === undefined || profile.limitExpensesToFriendIds === null
            ? 'unrestricted'
            : String(profile.limitExpensesToFriendIds.length),
        };
      });

      if (tuiMode && fmt === 'table') {
        renderTuiList(rows, {
          intro: 'Showing profiles',
          source: 'splitwise-cli profile store',
          startedAt,
          logger,
        });
        return;
      }

      render(rows, fmt);
    });

  addOutputOption(profiles.command('show <name>'))
    .description('Show one profile')
    .action(function (this: Command, name: string) {
      const fmt = getFormat(this);
      const profile = loadProfile(name, this);
      renderOne(
        {
          name,
          credential: profile.credential ?? null,
          locked: profile.locked ?? false,
          offlineEnabled: profile.offlineEnabled ?? false,
          preferredCacheTarget: profile.preferredCacheTarget ?? null,
          apiEndpoint: profile.apiEndpoint ?? null,
          createExpenses: profile.createExpenses,
          updateExpenses: profile.updateExpenses,
          deleteExpenses: profile.deleteExpenses,
          limitExpensesToGroupIds: profile.limitExpensesToGroupIds ?? null,
          limitExpensesToFriendIds: profile.limitExpensesToFriendIds ?? null,
          path: getProfilePath(name),
        },
        fmt,
        { tuiMode: isTuiDefault(this) },
      );
    });

  attachMutableOptions(profiles.command('create <name>'))
    .description('Create a profile file')
    .action(async function (this: Command, name: string, options: MutableProfileOptions) {
      ensureProfileMutable(name, this);
      const logger = createLogger(this, 'profiles');
      const existing = listProfileNames().includes(name);
      if (existing) {
        logger.error(`Profile "${name}" already exists.`);
        process.exit(1);
      }

      const profile = await applyMutableOptions(this, name, {}, options);
      saveProfile(name, profile, this);
      logger.success(`Created profile "${name}" at ${getProfilePath(name)}.`);
    });

  attachMutableOptions(profiles.command('edit <name>'))
    .description('Edit an existing profile')
    .action(async function (this: Command, name: string, options: MutableProfileOptions) {
      ensureProfileMutable(name, this);
      const logger = createLogger(this, 'profiles');
      const base = loadProfile(name, this);
      if (base.locked) {
        logger.error(getLockRecoveryMessage(name));
        process.exit(1);
      }
      const next = await applyMutableOptions(this, name, base, options);
      saveProfile(name, next, this);
      logger.success(`Updated profile "${name}".`);
    });

  profiles
    .command('select <name>')
    .description('Set the active profile')
    .action(function (this: Command, name: string) {
      ensureProfileSwitchable(name, this);
      setActiveProfile(name, this);
      const logger = createLogger(this, 'profiles');
      logger.success(`Active profile set to "${name}".`);
    });

  profiles
    .command('remove <name>')
    .description('Remove a profile file')
    .action(function (this: Command, name: string) {
      ensureProfileMutable(name, this);
      removeProfile(name, this);
      const logger = createLogger(this, 'profiles');
      logger.success(`Removed profile "${name}".`);
    });

  profiles
    .command('validate [name]')
    .description('Validate profile restrictions against current login')
    .action(async function (this: Command, name?: string) {
      const logger = createLogger(this, 'profiles');
      const targetName = name ?? resolveProfile(this).name;
      const profile = loadProfile(targetName, this);

      validateSelectedProfileOrExit(this);

      const sw = getDataClient(this);
      const [groups, friends] = await Promise.all([sw.groups.list(), sw.friends.list()]);
      const groupIds = new Set(groups.map((g) => g.id));
      const friendIds = new Set(friends.map((f) => f.id));

      const invalidGroups = (profile.limitExpensesToGroupIds ?? []).filter((id) => !groupIds.has(id));
      const invalidFriends = (profile.limitExpensesToFriendIds ?? []).filter((id) => !friendIds.has(id));

      if (invalidGroups.length === 0 && invalidFriends.length === 0) {
        logger.success(`Profile "${targetName}" is valid for the current login.`);
        return;
      }

      if (invalidGroups.length > 0) {
        logger.error(`Invalid group ids in profile "${targetName}": ${invalidGroups.join(', ')}`);
      }
      if (invalidFriends.length > 0) {
        logger.error(`Invalid friend ids in profile "${targetName}": ${invalidFriends.join(', ')}`);
      }
      process.exit(1);
    });

  addOutputOption(profiles.command('lock [name]'))
    .description('Lock a profile. This cannot be undone via CLI.')
    .option('--yes', 'Confirm lock in non-interactive mode')
    .action(async function (this: Command, name: string | undefined, opts: { yes?: boolean }) {
      const logger = createLogger(this, 'profiles');
      const targetName = name ?? resolveProfile(this).name;
      ensureProfileMutable(targetName, this);

      const profile = loadProfile(targetName, this);
      if (profile.locked) {
        logger.info(`Profile "${targetName}" is already locked.`);
        return;
      }

      const interactive = isTuiDefault(this) && !hasExplicitOutputOption(this);
      let confirmed = Boolean(opts.yes);

      if (interactive && !confirmed) {
        const answer = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `Lock profile "${targetName}" now? This cannot be undone via CLI.`,
          initial: false,
        });
        confirmed = Boolean(answer.ok);
      }

      if (!interactive && !confirmed) {
        logger.error('Refusing to lock profile without confirmation. Re-run with --yes.');
        process.exit(1);
      }

      if (!confirmed) {
        logger.info('Canceled. Profile was not locked.');
        return;
      }

      saveProfile(targetName, { ...profile, locked: true }, this);
      logger.success(`Locked profile "${targetName}". ${getLockRecoveryMessage(targetName)}`);
    });
}
