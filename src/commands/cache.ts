import { Command } from 'commander';
import type { Category, Comment, Currency, CurrentUser, Expense, Group } from 'splitwise';
import {
  type CacheTarget,
  getClient,
  resolveCacheTarget,
  resolveOfflineMode,
  resolveProfile,
  resolveCredential,
  getCacheRootPath,
  setCredentialIdentity,
} from '../lib/config.js';
import {
  appendCacheEntry,
  type CategoriesCachePayload,
  type CommentsCachePayload,
  createCacheEntry,
  type CurrenciesCachePayload,
  ensureCacheManifest,
  findEquivalentCacheEntry,
  findLatestCacheEntry,
  generateBatchId,
  summarizeScope,
  type CacheEntity,
  type CacheScope,
  type ExpensesCachePayload,
  type FriendsCachePayload,
  type GroupsCachePayload,
  writeCachePayload,
} from '../lib/cache.js';
import {
  addOutputOption,
  createLogger,
  formatName,
  getFormat,
  isTuiDefault,
  render,
  renderOne,
  renderTuiList,
} from '../lib/output.js';
import { parseDate } from '../lib/dates.js';

type CacheTargetOption = {
  target?: string;
};

type CacheEntityOption = CacheTargetOption & {
  from?: string;
  to?: string;
  group?: string;
  friend?: string;
};

function addCacheTargetOption(cmd: Command): Command {
  return cmd.option('--target <target>', 'Cache target: local | user | global');
}

function resolvedTarget(cmd: Command, options?: CacheTargetOption): CacheTarget {
  return resolveCacheTarget(cmd, options?.target);
}

function addExpenseScopeOptions(cmd: Command): Command {
  return cmd
    .option('--from <date>', 'Expenses on or after date (default: -6months)')
    .option('--to <date>', 'Expenses on or before date (default: today)')
    .option('--group, -g <id|name>', 'Filter by group ID or partial name')
    .option('--friend, -u <id|name>', 'Filter by friend ID or partial name');
}

async function resolveGroupId(sw: ReturnType<typeof getClient>, value: string | undefined): Promise<number | undefined> {
  if (value === undefined) return undefined;
  const asNum = Number(value);
  if (!Number.isNaN(asNum) && String(asNum) === value) return asNum;
  const groups = await sw.groups.list();
  const needle = value.toLowerCase();
  const matches = groups.filter((group) => group.name.toLowerCase().includes(needle));
  if (matches.length === 0) {
    throw new Error(`No group matching "${value}" while exporting cache.`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous group "${value}" while exporting cache.`);
  }
  return matches[0].id;
}

async function resolveFriendId(sw: ReturnType<typeof getClient>, value: string | undefined): Promise<number | undefined> {
  if (value === undefined) return undefined;
  const asNum = Number(value);
  if (!Number.isNaN(asNum) && String(asNum) === value) return asNum;
  const friends = await sw.friends.list();
  const needle = value.toLowerCase();
  const matches = friends.filter((friend) => formatName(friend).toLowerCase().includes(needle));
  if (matches.length === 0) {
    throw new Error(`No friend matching "${value}" while exporting cache.`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous friend "${value}" while exporting cache.`);
  }
  return matches[0].id;
}

function defaultExpenseScope(options: CacheEntityOption, groupId?: number, friendId?: number): CacheScope {
  return {
    from: options.from ? parseDate(options.from) : parseDate('-6months'),
    to: options.to ? parseDate(options.to) : new Date().toISOString().slice(0, 10),
    groupId,
    friendId,
  };
}

async function resolveCurrentUser(sw: ReturnType<typeof getClient>, credentialName: string): Promise<CurrentUser> {
  const currentUser = await sw.users.getCurrent();
  setCredentialIdentity(credentialName, currentUser.id, formatName(currentUser));
  return currentUser;
}

async function exportExpenses(sw: ReturnType<typeof getClient>, scope: CacheScope): Promise<ExpensesCachePayload> {
  const params: Record<string, unknown> = {};
  if (scope.groupId !== undefined) params.groupId = scope.groupId;
  if (scope.friendId !== undefined) params.friendId = scope.friendId;
  if (scope.from !== undefined) params.datedAfter = scope.from;
  if (scope.to !== undefined) params.datedBefore = scope.to;
  if (scope.updatedAfter !== undefined) params.updatedAfter = scope.updatedAfter;
  if (scope.updatedBefore !== undefined) params.updatedBefore = scope.updatedBefore;

  const items: Expense[] = [];
  for await (const page of sw.expenses.list(params).byPage()) {
    items.push(...page);
  }

  return {
    entity: 'expenses',
    items,
  };
}

async function exportComments(sw: ReturnType<typeof getClient>, expenses: Expense[]): Promise<CommentsCachePayload> {
  const items: Record<string, Comment[]> = {};
  for (const expense of expenses) {
    items[String(expense.id)] = await sw.comments.list({ expenseId: expense.id });
  }
  return { entity: 'comments', items };
}

async function exportFriends(sw: ReturnType<typeof getClient>): Promise<FriendsCachePayload> {
  const items = await sw.friends.list();
  return { entity: 'friends', items };
}

async function exportGroups(sw: ReturnType<typeof getClient>): Promise<GroupsCachePayload> {
  const groups = await sw.groups.list();
  const items: Group[] = [];
  for (const group of groups) {
    items.push(await sw.groups.get({ id: group.id }));
  }
  return { entity: 'groups', items };
}

async function exportGroupsLite(sw: ReturnType<typeof getClient>): Promise<GroupsCachePayload> {
  const items = await sw.groups.list();
  return { entity: 'groups', items };
}

async function exportLookup(sw: ReturnType<typeof getClient>): Promise<{ categories: CategoriesCachePayload; currencies: CurrenciesCachePayload }> {
  const [categories, currencies] = await Promise.all([sw.categories.list(), sw.currencies.list()]);
  return {
    categories: { entity: 'categories', items: categories as Category[] },
    currencies: { entity: 'currencies', items: currencies as Currency[] },
  };
}

async function persistExport(target: CacheTarget, batchId: string, entity: Exclude<CacheEntity, 'all'>, payload: ExpensesCachePayload | CommentsCachePayload | FriendsCachePayload | GroupsCachePayload | CategoriesCachePayload | CurrenciesCachePayload, scope: CacheScope | undefined, context: {
  profileName: string;
  credentialName: string;
  currentUser: CurrentUser;
  logger: ReturnType<typeof createLogger>;
}): Promise<void> {
  const existing = findEquivalentCacheEntry(target, {
    entity,
    accountUserId: context.currentUser.id,
    profileName: context.profileName,
    scope,
  });

  if (existing) {
    context.logger.warn(`Equivalent ${entity} cache scope already exists in batch ${existing.batchId}. Creating a new immutable export anyway.`);
  }

  const payloadPath = writeCachePayload(target, batchId, payload);
  const exportedAt = new Date().toISOString();
  const requestUrl = entity === 'expenses'
    ? '/get_expenses'
    : entity === 'comments'
      ? '/get_comments'
    : entity === 'groups'
      ? '/get_groups'
      : entity === 'friends'
        ? '/get_friends'
      : entity === 'categories'
          ? '/get_categories'
          : '/get_currencies';

  appendCacheEntry(target, createCacheEntry({
    batchId,
    entity,
    target,
    profileName: context.profileName,
    credentialName: context.credentialName,
    accountUserId: context.currentUser.id,
    accountUserName: formatName(context.currentUser),
    exportedAt,
    scope,
    request: {
      method: 'GET',
      url: requestUrl,
    },
    payloadPath,
    payload,
  }));
}

async function performExport(cmd: Command, entity: CacheEntity, options: CacheEntityOption, refreshMode = false): Promise<void> {
  const logger = createLogger(cmd, 'cache');
  if (resolveOfflineMode(cmd)) {
    logger.error('Offline mode is active. cache export and cache refresh require server access.');
    process.exit(1);
  }

  const target = resolvedTarget(cmd, options);
  ensureCacheManifest(target);
  const sw = getClient(cmd);
  const profileName = resolveProfile(cmd).name;
  const credentialName = resolveCredential(cmd).name;
  const currentUser = await resolveCurrentUser(sw, credentialName);
  const batchId = generateBatchId();

  let groupId: number | undefined;
  let friendId: number | undefined;
  if (entity === 'expenses' || entity === 'all') {
    groupId = await resolveGroupId(sw, options.group);
    friendId = await resolveFriendId(sw, options.friend);
  }

  const latestExpenseEntry = refreshMode
    ? findLatestCacheEntry(target, { entity: 'expenses', accountUserId: currentUser.id, profileName })
    : undefined;
  const latestScope = latestExpenseEntry?.scope;
  const baseExpenseScope = {
    from: options.from
      ? parseDate(options.from)
      : (refreshMode ? latestScope?.from : undefined) ?? parseDate('-6months'),
    to: options.to
      ? parseDate(options.to)
      : (refreshMode ? latestScope?.to : undefined) ?? new Date().toISOString().slice(0, 10),
    groupId: options.group !== undefined ? groupId : latestScope?.groupId ?? groupId,
    friendId: options.friend !== undefined ? friendId : latestScope?.friendId ?? friendId,
  } satisfies CacheScope;
  const refreshScope = refreshMode && latestExpenseEntry
    ? { ...baseExpenseScope, refreshOfBatchId: latestExpenseEntry.batchId, updatedAfter: latestExpenseEntry.coverage?.updatedAtMax }
    : baseExpenseScope;

  const context = { profileName, credentialName, currentUser, logger };
  const tasks: Array<Promise<void>> = [];

  if (entity === 'friends' || entity === 'all') {
    tasks.push(exportFriends(sw).then((payload) => persistExport(target, batchId, 'friends', payload, undefined, context)));
  }
  if (entity === 'groups' || entity === 'all') {
    tasks.push(exportGroups(sw).then((payload) => persistExport(target, batchId, 'groups', payload, undefined, context)));
  }
  if (entity === 'lookup' || entity === 'all') {
    tasks.push(
      exportLookup(sw).then(async (payloads) => {
        await persistExport(target, batchId, 'categories', payloads.categories, undefined, context);
        await persistExport(target, batchId, 'currencies', payloads.currencies, undefined, context);
      }),
    );
  }
  if (entity === 'expenses' || entity === 'all') {
    tasks.push(
      exportExpenses(sw, refreshScope).then(async (payload) => {
        await persistExport(target, batchId, 'expenses', payload, refreshScope, context);
        const commentPayload = await exportComments(sw, payload.items);
        await persistExport(target, batchId, 'comments', commentPayload, refreshScope, context);
        if (entity === 'expenses') {
          const groupsPayload = await exportGroupsLite(sw);
          await persistExport(target, batchId, 'groups', groupsPayload, undefined, context);
        }
      }),
    );
  }

  await Promise.all(tasks);
  logger.success(`${refreshMode ? 'Refreshed' : 'Exported'} ${entity} into cache target ${target} with batch ${batchId}.`);
}

export function registerCache(program: Command): void {
  const cache = program.command('cache').description('Inspect and manage local cache exports');

  addOutputOption(addCacheTargetOption(cache.command('list')))
    .description('List cached export metadata for a cache target')
    .action(function (this: Command, options: CacheTargetOption) {
      const logger = createLogger(this, 'cache');
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      const startedAt = Date.now();
      const target = resolvedTarget(this, options);
      const manifest = ensureCacheManifest(target);
      const rows = manifest.entries.map((entry) => ({
        batchId: entry.batchId,
        entity: entry.entity,
        target: entry.target,
        accountUserId: entry.accountUserId ?? null,
        accountUserName: entry.accountUserName ?? '',
        profileName: entry.profileName,
        credentialName: entry.credentialName ?? '',
        exportedAt: entry.exportedAt,
        rowCount: entry.rowCount ?? null,
        expenseDateMin: entry.coverage?.expenseDateMin ?? '',
        expenseDateMax: entry.coverage?.expenseDateMax ?? '',
        createdAtMin: entry.coverage?.createdAtMin ?? '',
        createdAtMax: entry.coverage?.createdAtMax ?? '',
        updatedAtMin: entry.coverage?.updatedAtMin ?? '',
        updatedAtMax: entry.coverage?.updatedAtMax ?? '',
        scope: summarizeScope(entry.scope),
      }));

      if (tuiMode && fmt === 'table') {
        renderTuiList(rows, {
          intro: `Showing cache entries for ${target}`,
          source: getCacheRootPath(target),
          startedAt,
          logger,
        });
        return;
      }

      render(rows, fmt);
    });

  addOutputOption(addCacheTargetOption(cache.command('status')))
    .description('Show cache root status for a cache target')
    .action(function (this: Command, options: CacheTargetOption) {
      const fmt = getFormat(this);
      const target = resolvedTarget(this, options);
      const manifest = ensureCacheManifest(target);
      const offline = resolveOfflineMode(this);
      const profile = resolveProfile(this);
      let credentialName: string | null = null;
      try {
        credentialName = resolveCredential(this).name;
      } catch {
        credentialName = null;
      }

      renderOne(
        {
          target,
          root: getCacheRootPath(target),
          entries: manifest.entries.length,
          offline,
          profile: profile.name,
          credential: credentialName,
        },
        fmt,
        { tuiMode: isTuiDefault(this) },
      );
    });

  addExpenseScopeOptions(addCacheTargetOption(cache.command('export <entity>')))
    .description('Export server data into the local cache')
    .action(async function (this: Command, entity: string, options: CacheEntityOption) {
      const normalized = entity as CacheEntity;
      if (!['expenses', 'friends', 'groups', 'lookup', 'all'].includes(normalized)) {
        const logger = createLogger(this, 'cache');
        logger.error(`Unknown cache entity "${entity}". Use expenses, friends, groups, lookup, or all.`);
        process.exit(1);
      }
      await performExport(this, normalized, options, false);
    });

  addExpenseScopeOptions(addCacheTargetOption(cache.command('refresh <entity>')))
    .description('Refresh cache data using the latest compatible scope')
    .action(async function (this: Command, entity: string, options: CacheEntityOption) {
      const normalized = entity as CacheEntity;
      if (!['expenses', 'friends', 'groups', 'lookup', 'all'].includes(normalized)) {
        const logger = createLogger(this, 'cache');
        logger.error(`Unknown cache entity "${entity}". Use expenses, friends, groups, lookup, or all.`);
        process.exit(1);
      }
      await performExport(this, normalized, options, true);
    });
}