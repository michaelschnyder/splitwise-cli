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
  appendCacheEntries,
  cachePayloadPath,
  type CategoriesCachePayload,
  classifyEntryCoverage,
  type CommentsCachePayload,
  createStagedBatchId,
  createCacheEntry,
  deriveExpenseRefreshPlan,
  type CurrenciesCachePayload,
  ensureCacheManifest,
  finalizeStagedBatch,
  findEquivalentCacheEntry,
  findLatestCacheEntry,
  generateBatchId,
  removeBatch,
  removeCacheRoot,
  saveCacheManifest,
  summarizeScope,
  type CacheEntity,
  type CacheScope,
  type CacheManifestEntry,
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
  if (scope.createdAfter !== undefined) params.createdAfter = scope.createdAfter;
  if (scope.createdBefore !== undefined) params.createdBefore = scope.createdBefore;
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

async function persistExport(target: CacheTarget, input: {
  writeBatchId: string;
  finalBatchId: string;
  entity: Exclude<CacheEntity, 'all'>;
  payload: ExpensesCachePayload | CommentsCachePayload | FriendsCachePayload | GroupsCachePayload | CategoriesCachePayload | CurrenciesCachePayload;
  scope: CacheScope | undefined;
  exportedAt: string;
}, context: {
  profileName: string;
  credentialName: string;
  currentUser: CurrentUser;
  logger: ReturnType<typeof createLogger>;
}): Promise<CacheManifestEntry> {
  const existing = findEquivalentCacheEntry(target, {
    entity: input.entity,
    accountUserId: context.currentUser.id,
    profileName: context.profileName,
    scope: input.scope,
  });

  if (existing) {
    context.logger.warn(`Equivalent ${input.entity} cache scope already exists in batch ${existing.batchId}. Creating a new immutable export anyway.`);
  }

  writeCachePayload(target, input.writeBatchId, input.payload);
  const requestUrl = input.entity === 'expenses'
    ? '/get_expenses'
    : input.entity === 'comments'
      ? '/get_comments'
    : input.entity === 'groups'
      ? '/get_groups'
      : input.entity === 'friends'
        ? '/get_friends'
      : input.entity === 'categories'
          ? '/get_categories'
          : '/get_currencies';

  return createCacheEntry({
    batchId: input.finalBatchId,
    entity: input.entity,
    target,
    profileName: context.profileName,
    credentialName: context.credentialName,
    accountUserId: context.currentUser.id,
    accountUserName: formatName(context.currentUser),
    exportedAt: input.exportedAt,
    scope: input.scope,
    request: {
      method: 'GET',
      url: requestUrl,
    },
    payloadPath: cachePayloadPath(input.finalBatchId, input.payload),
    payload: input.payload,
  });
}

async function performExport(cmd: Command, entity: CacheEntity, options: CacheEntityOption, refreshMode = false): Promise<void> {
  const logger = createLogger(cmd, 'cache');
  const exportLogger = logger.withTag('cache-export');
  if (resolveOfflineMode(cmd)) {
    logger.error('Offline mode is active. cache add and cache refresh require server access.');
    process.exit(1);
  }

  const target = resolvedTarget(cmd, options);
  ensureCacheManifest(target);
  const sw = getClient(cmd);
  const profileName = resolveProfile(cmd).name;
  const credentialName = resolveCredential(cmd).name;
  const currentUser = await resolveCurrentUser(sw, credentialName);
  const batchId = generateBatchId();
  const stagedBatchId = createStagedBatchId(batchId);
  const exportedAt = new Date().toISOString();
  exportLogger.debug(`Preparing ${refreshMode ? 'refresh' : 'export'} for ${entity} in target ${target} with staged batch ${stagedBatchId}.`);

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
  const refreshPlan = refreshMode
    ? deriveExpenseRefreshPlan({ latestEntry: latestExpenseEntry, baseScope: baseExpenseScope })
    : { strategy: 'full' as const, scope: baseExpenseScope };
  const refreshScope = refreshPlan.scope;
  if (refreshMode) {
    exportLogger.info(`Refresh strategy for ${entity}: ${refreshPlan.strategy}.`);
    exportLogger.debug(`Refresh scope: ${summarizeScope(refreshScope)}.`);
    exportLogger.trace(`Refresh baseline batch: ${latestExpenseEntry?.batchId ?? 'none'}.`);
  }

  const context = { profileName, credentialName, currentUser, logger };
  const tasks: Array<Promise<CacheManifestEntry[]>> = [];

  if (entity === 'friends' || entity === 'all') {
    tasks.push(exportFriends(sw).then(async (payload) => [await persistExport(target, {
      writeBatchId: stagedBatchId,
      finalBatchId: batchId,
      entity: 'friends',
      payload,
      scope: undefined,
      exportedAt,
    }, context)]));
  }
  if (entity === 'groups' || entity === 'all') {
    tasks.push(exportGroups(sw).then(async (payload) => [await persistExport(target, {
      writeBatchId: stagedBatchId,
      finalBatchId: batchId,
      entity: 'groups',
      payload,
      scope: undefined,
      exportedAt,
    }, context)]));
  }
  if (entity === 'lookup' || entity === 'all') {
    tasks.push(
      exportLookup(sw).then(async (payloads) => {
        const categoriesEntry = await persistExport(target, {
          writeBatchId: stagedBatchId,
          finalBatchId: batchId,
          entity: 'categories',
          payload: payloads.categories,
          scope: undefined,
          exportedAt,
        }, context);
        const currenciesEntry = await persistExport(target, {
          writeBatchId: stagedBatchId,
          finalBatchId: batchId,
          entity: 'currencies',
          payload: payloads.currencies,
          scope: undefined,
          exportedAt,
        }, context);
        return [categoriesEntry, currenciesEntry];
      }),
    );
  }
  if (entity === 'expenses' || entity === 'all') {
    tasks.push(
      exportExpenses(sw, refreshScope).then(async (payload) => {
        const entries: CacheManifestEntry[] = [];
        entries.push(await persistExport(target, {
          writeBatchId: stagedBatchId,
          finalBatchId: batchId,
          entity: 'expenses',
          payload,
          scope: refreshScope,
          exportedAt,
        }, context));
        const commentPayload = await exportComments(sw, payload.items);
        entries.push(await persistExport(target, {
          writeBatchId: stagedBatchId,
          finalBatchId: batchId,
          entity: 'comments',
          payload: commentPayload,
          scope: refreshScope,
          exportedAt,
        }, context));
        if (entity === 'expenses') {
          const groupsPayload = await exportGroupsLite(sw);
          entries.push(await persistExport(target, {
            writeBatchId: stagedBatchId,
            finalBatchId: batchId,
            entity: 'groups',
            payload: groupsPayload,
            scope: undefined,
            exportedAt,
          }, context));
        }
        return entries;
      }),
    );
  }

  let finalized = false;
  try {
    const entries = (await Promise.all(tasks)).flat();
    exportLogger.debug(`Finalizing staged batch ${stagedBatchId} as ${batchId}.`);
    finalizeStagedBatch(target, stagedBatchId, batchId);
    finalized = true;
    appendCacheEntries(target, entries);
    exportLogger.debug(`Manifest updated with ${entries.length} entries for batch ${batchId}.`);
  } catch (err) {
    if (!finalized) {
      exportLogger.warn(`Removing staged batch ${stagedBatchId} after export failure.`);
      removeBatch(target, stagedBatchId);
    }
    throw err;
  }

  logger.success(`${refreshMode ? 'Refreshed' : 'Added'} ${entity} into cache target ${target} with cache id ${batchId}.`);
}

function deleteCacheEntry(target: CacheTarget, cacheId: string): void {
  const manifest = ensureCacheManifest(target);
  const nextEntries = manifest.entries.filter((entry) => entry.batchId !== cacheId);
  if (nextEntries.length === manifest.entries.length) {
    throw new Error(`Cache id ${cacheId} was not found for target ${target}.`);
  }

  manifest.entries = nextEntries;
  saveCacheManifest(target, manifest);
  removeBatch(target, cacheId);
}

function formatDateRange(min?: string, max?: string): string {
  if (!min && !max) return 'n/a';
  if (min && max && min === max) return min;
  if (min && max) return `${min} to ${max}`;
  return min ?? max ?? 'n/a';
}

function formatScopeFilters(scope?: CacheScope): string {
  const parts = [
    scope?.from ? `from: ${scope.from}` : '',
    scope?.to ? `to: ${scope.to}` : '',
    scope?.groupId !== undefined ? `group: ${scope.groupId}` : '',
    scope?.friendId !== undefined ? `friend: ${scope.friendId}` : '',
    scope?.createdAfter ? `created_after: ${scope.createdAfter}` : '',
    scope?.createdBefore ? `created_before: ${scope.createdBefore}` : '',
    scope?.updatedAfter ? `updated_after: ${scope.updatedAfter}` : '',
    scope?.updatedBefore ? `updated_before: ${scope.updatedBefore}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : 'n/a';
}

function describeCacheListEntry(entry: CacheManifestEntry): Record<string, unknown> {
  const coverageLines: string[] = [`created_at: ${formatDateRange(entry.coverage?.createdAtMin, entry.coverage?.createdAtMax)}`];
  if (entry.entity === 'expenses') {
    coverageLines.unshift(`expense_date: ${formatDateRange(entry.coverage?.expenseDateMin, entry.coverage?.expenseDateMax)}`);
    coverageLines.push(`updated_at: ${formatDateRange(entry.coverage?.updatedAtMin, entry.coverage?.updatedAtMax)}`);
  } else if (entry.coverage?.updatedAtMin || entry.coverage?.updatedAtMax) {
    coverageLines.push(`updated_at: ${formatDateRange(entry.coverage?.updatedAtMin, entry.coverage?.updatedAtMax)}`);
  }

  const filterLines: string[] = [];
  if (entry.entity === 'expenses') {
    filterLines.push(formatScopeFilters(entry.scope));
  } else {
    filterLines.push('n/a');
  }

  return {
    entity: entry.entity,
    batchId: entry.batchId,
    items: entry.rowCount ?? 0,
    coverage: coverageLines.join('\n'),
    filters: filterLines.join('\n'),
    createdAt: entry.exportedAt,
    identity: [
      `target: ${entry.target}`,
      `profile: ${entry.profileName}`,
      `credential: ${entry.credentialName ?? ''}`,
      `account: ${entry.accountUserName ?? ''} (${entry.accountUserId ?? 'unknown'})`,
    ].join('\n'),
    coverageStatus: classifyEntryCoverage(entry),
  };
}

export function registerCache(program: Command): void {
  const cache = program.command('cache').description('Inspect and manage local cache snapshots');

  addOutputOption(addCacheTargetOption(cache.command('list')))
    .description('List cached export metadata for a cache target')
    .action(function (this: Command, options: CacheTargetOption) {
      const logger = createLogger(this, 'cache');
      const cacheLogger = logger.withTag('cache-list');
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      const startedAt = Date.now();
      const target = resolvedTarget(this, options);
      const manifest = ensureCacheManifest(target);
      const rows = manifest.entries.map((entry) => {
        const row = describeCacheListEntry(entry);
        cacheLogger.trace(`Entry ${entry.entity} ${entry.batchId}: ${String(row.coverageStatus)} coverage, ${entry.rowCount ?? 0} item(s).`);
        return row;
      });

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

  addExpenseScopeOptions(addCacheTargetOption(cache.command('add <entity>')))
    .description('Add server data into the local cache')
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

  addOutputOption(addCacheTargetOption(cache.command('delete [id]')))
    .option('--all', 'Delete all cached data for the selected target')
    .description('Delete one cache id or all cache data for a target')
    .action(function (this: Command, id?: string, options?: CacheTargetOption & { all?: boolean }) {
      const logger = createLogger(this, 'cache');
      const target = resolvedTarget(this, options);

      if (options?.all) {
        removeCacheRoot(target);
        logger.success(`Deleted all cache data for target ${target}.`);
        return;
      }

      if (!id) {
        logger.error('Provide a cache id or pass --all.');
        process.exit(1);
      }

      try {
        deleteCacheEntry(target, id);
      } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      logger.success(`Deleted cache id ${id} from target ${target}.`);
    });
}