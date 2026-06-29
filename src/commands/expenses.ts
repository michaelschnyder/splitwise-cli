import { Command } from 'commander';
import prompts from 'prompts';
import { dump as yamlDump } from 'js-yaml';
import { type Expense, type ExpenseCreateParams } from 'splitwise';
import { appendFileSync } from 'node:fs';
import {
  getDataClient,
  ensureCreateExpenseAllowed,
  ensureDeleteExpenseAllowed,
  ensureExpenseGroupAllowed,
  ensureExpenseFriendAllowed,
  resolveCacheTarget,
  resolveCredential,
  resolveProfile,
} from '../lib/config.js';
import {
  findLatestCacheEntry,
  loadLatestFriends,
  loadLatestGroups,
  saveLookupEntitySnapshot,
} from '../lib/cache.js';
import {
  addOutputOption, getFormat, formatName,
  render, renderOne, renderEmptyList, renderTuiList,
  isTuiDefault, colorize, createTuiProgress, createLogger, writeTuiInfoSpacer,
  visualWidth, padStartVisual, padEndVisual,
  type OutputFormat,
} from '../lib/output.js';
import { parseDate } from '../lib/dates.js';
import { buildExpenseCreateParams, parseExpenseShareInput } from '../lib/expense-writes.js';
import {
  parseImportFile,
  normalizeToCreateParams,
  exactMatch,
  intelligentMatch,
  buildExpenseUpdateParams,
  type ImportExpenseRecord,
  type ImportContext,
  type MatchScope,
} from '../lib/import.js';

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const MIN_TRUNCATED_WIDTH = 13; // 10 visible characters + "..."
const LOOKUP_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type TruncationKey = 'group' | 'paidBy' | 'description' | 'category';

function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, '');
}

function truncateVisual(input: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const plain = stripAnsi(input);
  if (visualWidth(plain) <= maxWidth) return plain;
  if (maxWidth <= 3) return '.'.repeat(maxWidth);

  const target = maxWidth - 3;
  let out = '';
  let used = 0;
  const hasGraphemeSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
  const segments = hasGraphemeSegmenter
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(plain)].map((s) => s.segment)
    : Array.from(plain);

  for (const segment of segments) {
    const segmentWidth = visualWidth(segment);
    if (used + segmentWidth > target) break;
    out += segment;
    used += segmentWidth;
  }
  return `${out}...`;
}

function isFreshEnough(exportedAt?: string): boolean {
  if (!exportedAt) return false;
  const parsed = Date.parse(exportedAt);
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed <= LOOKUP_CACHE_MAX_AGE_MS;
}

function uniquePrefixLength(value: string, allValues: string[]): number {
  const normalized = value.toLocaleLowerCase();
  if (!normalized) return 0;
  for (let len = 1; len <= normalized.length; len++) {
    const prefix = normalized.slice(0, len);
    const collisions = allValues.filter((other) => {
      if (other === normalized) return false;
      return other.startsWith(prefix);
    });
    if (collisions.length === 0) return len;
  }
  return normalized.length;
}

function minWidthForDistinctValues(values: string[]): number {
  const normalized = [...new Set(values
    .map((v) => stripAnsi(v).trim().toLocaleLowerCase())
    .filter(Boolean))];
  if (normalized.length <= 1) return MIN_TRUNCATED_WIDTH;
  const maxPrefix = Math.max(...normalized.map((v) => uniquePrefixLength(v, normalized)));
  return Math.max(MIN_TRUNCATED_WIDTH, maxPrefix + 3);
}

function terminalColumns(): number {
  const cols = process.stdout.columns;
  if (typeof cols !== 'number' || cols <= 0) return Number.POSITIVE_INFINITY;
  return cols;
}

function normalizeDisplayWhitespace(input: string): string {
  return input.replace(/\s{2,}/g, ' ').trim();
}

type TableRow = { id: number; date: string; group: string; paidBy: string; description: string; cost: string; category: string; share: string };
type SplitRow = { userId: number; name: string; paid: string; owes: string };
type CommentRow = { id: number; content: string; author: string; createdAt: string };
type FullRow = {
  id: number; date: string; description: string; cost: string; currency: string;
  categoryId?: number; category: string;
  isPayment: boolean;
  notes?: string;
  paidById: number | undefined; paidBy: string; groupId: number | null; group: string | null;
  splits: SplitRow[];
  createdAt: string; createdById?: number; createdByName: string;
  updatedAt?: string; updatedById?: number; updatedByName: string;
  deletedAt?: string | null; deletedById?: number; deletedByName: string;
  comments?: CommentRow[];
};

function createExpenseRenderers(context: {
  groupLookup: Map<number, string>;
  meIdForTui?: number;
}) {
  const resolveGroup = (id: number | null): string | null =>
    id != null ? (context.groupLookup.get(id) ?? null) : null;

  const toTableRow = (e: Expense): TableRow => {
    const payer = e.users?.find((u) => Number(u.paidShare) > 0);
    let description = e.description;
    if (e.payment) {
      const payee = e.users?.find((u) => u.userId !== payer?.userId && Number(u.owedShare) > 0);
      if (payee) description += ` → ${formatName(payee.user)}`;
    }

    const myEntry = context.meIdForTui !== undefined
      ? e.users?.find((u) => u.userId === context.meIdForTui)
      : undefined;
    const myPaid = Number(myEntry?.paidShare ?? 0);
    const myOwes = Number(myEntry?.owedShare ?? 0);
    const net = myPaid - myOwes;
    const isEffectivelyZero = Math.abs(net) < 0.005;

    let share = '';
    if (myEntry) {
      const absShare = `${Math.abs(net).toFixed(2)} ${e.currencyCode}`;
      if (isEffectivelyZero) share = colorize(absShare, 'dim');
      else if (net < 0) share = colorize(absShare, 'red');
      else share = colorize(absShare, 'green');
    }

    const costNum = Number(e.cost);
    const rawCost = `${isNaN(costNum) ? e.cost : costNum.toFixed(2)} ${e.currencyCode}`;
    const cost = myEntry
      ? (net < 0 ? colorize(rawCost, 'red') : (net > 0 ? colorize(rawCost, 'green') : rawCost))
      : rawCost;

    const styledDescription = e.payment ? colorize(description, 'dim') : description;
    const styledCategory = e.payment ? colorize(e.category?.name ?? '', 'dim') : (e.category?.name ?? '');

    return {
      id: e.id,
      date: e.date ? new Date(e.date).toLocaleDateString() : '?',
      group: normalizeDisplayWhitespace(resolveGroup(e.groupId) ?? ''),
      paidBy: payer ? formatName(payer.user) : '',
      description: styledDescription,
      cost,
      category: styledCategory,
      share,
    };
  };

  const toFullRow = (e: Expense): FullRow => {
    const payer = e.users?.find((u) => Number(u.paidShare) > 0);
    return {
      id: e.id,
      date: e.date,
      description: e.description,
      cost: e.cost,
      currency: e.currencyCode,
      categoryId: e.category?.id,
      category: e.category?.name ?? '',
      isPayment: e.payment,
      notes: e.details || undefined,
      paidById: payer?.userId,
      paidBy: payer ? formatName(payer.user) : '',
      groupId: e.groupId,
      group: resolveGroup(e.groupId),
      splits: (e.users ?? []).map((u) => ({
        userId: u.userId,
        name: formatName(u.user),
        paid: u.paidShare,
        owes: u.owedShare,
      })),
      createdAt: e.createdAt,
      createdById: e.createdBy?.id,
      createdByName: formatName(e.createdBy),
      updatedAt: e.updatedAt,
      updatedById: e.updatedBy?.id,
      updatedByName: formatName(e.updatedBy),
      deletedAt: e.deletedAt,
      deletedById: e.deletedBy?.id,
      deletedByName: formatName(e.deletedBy),
      comments: e.comments?.map((c) => ({
        id: c.id,
        content: c.content,
        author: formatName(c.user),
        createdAt: c.createdAt,
      })),
    };
  };

  return { toTableRow, toFullRow };
}

export function registerExpenses(program: Command): void {
  const expenses = program.command('expenses').description('View and create expenses');

  addOutputOption(expenses.command('list'))
    .description('List recent expenses')
    .option('--group, -g <id|name>', 'Filter by group ID or partial name')
    .option('--friend, -u <id|name>', 'Filter by friend ID or partial name')
    .option('--from, -f <date>', 'Expenses on or after date (YYYY-MM-DD or -10d / -2w / -1month)')
    .option('--to <date>', 'Expenses on or before date (YYYY-MM-DD or relative)')
    .option('-m, --max <n>', 'Max number of results to return (default 20; ignored with --all)', '20')
    .option('--all', 'Fetch all pages automatically (ignores --max)')
    .option('--mine', 'Shorthand for --payer @me')
    .option('--involved <@me|id|name>', 'Only expenses where this user is a participant (client-side)')
    .option('--payer <@me|id|name>', 'Only expenses where this user paid (client-side)')
    .option(
      '--query <string>',
      'Shorthand query, e.g. --query "payer:@me involved:Alice group:Flatmates from:-30d"',
    )
    .action(async function (
      this: Command,
      opts: {
        group?: string; friend?: string; from?: string; to?: string;
        max: string; all?: boolean; mine?: boolean;
        involved?: string; payer?: string; query?: string;
      },
    ) {
      const logger = createLogger(this, 'expenses');
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);
      const { profile } = resolveProfile(this);

      // ── Parse --query and merge (explicit flags win) ──────────────────────
      if (opts.query) {
        for (const token of (opts.query.match(/\S+/g) ?? [])) {
          const colon = token.indexOf(':');
          if (colon < 1) continue;
          const key = token.slice(0, colon).toLowerCase();
          const val = token.slice(colon + 1);
          if (!val) continue;
          if (key === 'group')  opts.group  ??= val;
          if (key === 'friend') opts.friend ??= val;
          if (key === 'from')   opts.from   ??= val;
          if (key === 'to')     opts.to     ??= val;
        }
      }

      const sw = getDataClient(this);

      // ── Resolve dates ─────────────────────────────────────────────────────
      const datedAfter  = opts.from ? parseDate(opts.from) : undefined;
      const datedBefore = opts.to   ? parseDate(opts.to)   : undefined;

      const startedAt = Date.now();
      const target = resolveCacheTarget(this);
      const profileName = resolveProfile(this).name;
      const { name: credentialName, credential } = resolveCredential(this);
      const accountUserId = credential.userId;

      const latestGroupsEntry = findLatestCacheEntry(target, { entity: 'groups', accountUserId, profileName });
      const latestFriendsEntry = findLatestCacheEntry(target, { entity: 'friends', accountUserId, profileName });
      let allGroups = isFreshEnough(latestGroupsEntry?.exportedAt)
        ? loadLatestGroups(target, accountUserId, profileName)
        : [];
      let allFriends = isFreshEnough(latestFriendsEntry?.exportedAt)
        ? loadLatestFriends(target, accountUserId, profileName)
        : [];
      let groupsLoadedFromApi = false;
      let friendsLoadedFromApi = false;

      // ── Lazy current user (fetched at most once) ──────────────────────────
      let meCache: Awaited<ReturnType<typeof sw.users.getCurrent>> | undefined;
      async function getMe() {
        if (!meCache) meCache = await sw.users.getCurrent();
        return meCache;
      }

      const refreshGroupsFromApi = async () => {
        if (sw.getSourceKind() === 'cache') return allGroups;
        const summaries = await sw.groups.list();
        const fullGroups = [] as typeof summaries;
        for (const summary of summaries) {
          fullGroups.push(await sw.groups.get({ id: summary.id }));
        }
        const me = await getMe();
        saveLookupEntitySnapshot({
          target,
          entity: 'groups',
          profileName,
          credentialName,
          accountUserId: me.id,
          accountUserName: formatName(me),
          items: fullGroups,
        });
        allGroups = fullGroups;
        groupsLoadedFromApi = true;
        return allGroups;
      };

      const refreshFriendsFromApi = async () => {
        if (sw.getSourceKind() === 'cache') return allFriends;
        const remoteFriends = await sw.friends.list();
        const me = await getMe();
        saveLookupEntitySnapshot({
          target,
          entity: 'friends',
          profileName,
          credentialName,
          accountUserId: me.id,
          accountUserName: formatName(me),
          items: remoteFriends,
        });
        allFriends = remoteFriends;
        friendsLoadedFromApi = true;
        return allFriends;
      };

      if (allGroups.length === 0 && sw.getSourceKind() !== 'cache') {
        allGroups = await refreshGroupsFromApi();
      }
      if (allFriends.length === 0 && sw.getSourceKind() !== 'cache') {
        allFriends = await refreshFriendsFromApi();
      }

      const groupLookup = new Map<number, string>();
      for (const g of allGroups) groupLookup.set(g.id, g.name);

      // ── Resolve any user value (@me / id / partial name) to a userId ──────
      const resolveUser = async (label: string, value: string): Promise<number | undefined> => {
        if (value === '@me') return (await getMe()).id;
        const asNum = Number(value);
        if (!isNaN(asNum) && String(asNum) === value) return asNum;

        const needle = value.toLowerCase();
        const me = await getMe();
        const unique = [...new Map(
          [...allFriends, me]
            .filter((u) => formatName(u).toLowerCase().includes(needle))
            .map((u) => [u.id, u]),
        ).values()];

        if (unique.length === 0) {
          logger.warn(`Warning: no user matching "${value}" for ${label} - filter ignored.`);
          return undefined;
        }
        if (unique.length > 1) {
          logger.error(
            `Ambiguous ${label} "${value}" — matches: ${unique.map((u) => `"${formatName(u)}"`).join(', ')}. Be more specific.`,
          );
          process.exit(1);
        }
        return unique[0].id;
      };

      // ── Resolve group filter ──────────────────────────────────────────────
      let groupId: number | undefined;

      if (opts.group !== undefined) {
        const asNum = Number(opts.group);
        if (!isNaN(asNum) && String(asNum) === opts.group) {
          ensureExpenseGroupAllowed(this, asNum, 'expenses list');
          groupId = asNum;
        } else {
          const needle = opts.group.toLowerCase();
          let matches = allGroups.filter((g) => g.name.toLowerCase().includes(needle));
          if (matches.length === 0 && !groupsLoadedFromApi && sw.getSourceKind() !== 'cache') {
            allGroups = await refreshGroupsFromApi();
            groupLookup.clear();
            for (const g of allGroups) groupLookup.set(g.id, g.name);
            matches = allGroups.filter((g) => g.name.toLowerCase().includes(needle));
          }
          if (matches.length === 0) {
            logger.warn(`Warning: no group matching "${opts.group}" - returning empty list.`);
            renderEmptyList(fmt);
            return;
          }
          if (matches.length > 1) {
            logger.error(
              `Ambiguous group "${opts.group}" — matches: ${matches.map((g) => `"${g.name}"`).join(', ')}. Be more specific.`,
            );
            process.exit(1);
          }
          ensureExpenseGroupAllowed(this, matches[0].id, 'expenses list');
          groupId = matches[0].id;
        }
      }

      // ── Resolve friend filter ─────────────────────────────────────────────
      let friendId: number | undefined;

      if (opts.friend !== undefined) {
        const asNum = Number(opts.friend);
        if (!isNaN(asNum) && String(asNum) === opts.friend) {
          ensureExpenseFriendAllowed(this, asNum, 'expenses list');
          friendId = asNum;
        } else {
          const needle = opts.friend.toLowerCase();
          let matches = allFriends.filter((f) =>
            `${f.firstName} ${f.lastName}`.toLowerCase().includes(needle) ||
            (f.firstName ?? '').toLowerCase().includes(needle),
          );
          if (matches.length === 0 && !friendsLoadedFromApi && sw.getSourceKind() !== 'cache') {
            allFriends = await refreshFriendsFromApi();
            matches = allFriends.filter((f) =>
              `${f.firstName} ${f.lastName}`.toLowerCase().includes(needle) ||
              (f.firstName ?? '').toLowerCase().includes(needle),
            );
          }
          if (matches.length === 0) {
            logger.warn(`Warning: no friend matching "${opts.friend}" - returning empty list.`);
            renderEmptyList(fmt);
            return;
          }
          if (matches.length > 1) {
            logger.error(
              `Ambiguous friend "${opts.friend}" — matches: ${matches.map((f) => `"${formatName(f)}"`).join(', ')}. Be more specific.`,
            );
            process.exit(1);
          }
          ensureExpenseFriendAllowed(this, matches[0].id, 'expenses list');
          friendId = matches[0].id;
        }
      }

      // ── Resolve client-side filters ───────────────────────────────────────
      const involvedId = opts.involved !== undefined
        ? await resolveUser('--involved', opts.involved)
        : undefined;
      if (involvedId !== undefined) ensureExpenseFriendAllowed(this, involvedId, 'expenses list');

      const payerId = (opts.mine ? '@me' : opts.payer) !== undefined
        ? await resolveUser('--payer', opts.mine ? '@me' : opts.payer!)
        : undefined;
      if (payerId !== undefined) ensureExpenseFriendAllowed(this, payerId, 'expenses list');

      const hasLocalFilter = involvedId !== undefined || payerId !== undefined;

      const passesFilter = (e: Expense): boolean => {
        if (profile.limitExpensesToGroupIds !== undefined && profile.limitExpensesToGroupIds !== null) {
          if (e.groupId === null || !profile.limitExpensesToGroupIds.includes(e.groupId)) return false;
        }
        if (profile.limitExpensesToFriendIds !== undefined && profile.limitExpensesToFriendIds !== null) {
          const participantIds = (e.users ?? []).map((u) => u.userId);
          const hasAllowed = participantIds.some((id) => profile.limitExpensesToFriendIds!.includes(id));
          if (!hasAllowed) return false;
        }
        if (involvedId !== undefined &&
            !e.users?.some((u) => u.userId === involvedId)) return false;
        if (payerId !== undefined &&
            !e.users?.some((u) => u.userId === payerId && Number(u.paidShare) > 0)) return false;
        return true;
      };

      // ── Fetch params ──────────────────────────────────────────────────────
      const params: Record<string, unknown> = {};
      if (groupId !== undefined)     params.groupId = groupId;
      if (friendId !== undefined)    params.friendId = friendId;
      if (datedAfter !== undefined)  params.datedAfter = datedAfter;
      if (datedBefore !== undefined) params.datedBefore = datedBefore;

      const max = opts.all ? Infinity : Number(opts.max);

      let meIdForTui: number | undefined;
      if (tuiMode && fmt === 'table') {
        meIdForTui = (await getMe()).id;
      }

      const { toTableRow, toFullRow } = createExpenseRenderers({
        groupLookup,
        meIdForTui,
      });

      if (tuiMode) {
        const fromLabel = datedAfter ?? 'Splitwise implicit default start';
        const toLabel = datedBefore ?? 'today';
        logger.info(`Showing expenses from ${fromLabel} to ${toLabel}`);
      }

      const progress = createTuiProgress(tuiMode);

      const consumeClientWarnings = () => {
        for (const warning of sw.consumeWarnings()) logger.warn(warning);
      };

      const ensureGroupNamesResolved = async (expenses: Expense[]) => {
        const unresolved = expenses
          .map((expense) => expense.groupId)
          .filter((groupId): groupId is number => groupId !== null)
          .filter((groupId) => !groupLookup.has(groupId));
        if (unresolved.length === 0 || groupsLoadedFromApi || sw.getSourceKind() === 'cache') return;
        allGroups = await refreshGroupsFromApi();
        groupLookup.clear();
        for (const group of allGroups) groupLookup.set(group.id, group.name);
      };

      // ── Streaming renderers ───────────────────────────────────────────────
      const TABLE_COLUMNS: { key: keyof TableRow; label: string }[] = [
        { key: 'id', label: tuiMode ? 'ID' : 'id' },
        { key: 'date', label: tuiMode ? 'Date' : 'date' },
        { key: 'group', label: tuiMode ? 'Group/Friend' : 'group' },
        { key: 'paidBy', label: tuiMode ? 'Paid By' : 'paidBy' },
        { key: 'description', label: tuiMode ? 'Description' : 'description' },
        { key: 'cost', label: tuiMode ? 'Costs' : 'costs' },
        { key: 'category', label: tuiMode ? 'Category' : 'category' },
        { key: 'share', label: tuiMode ? 'Share' : 'share' },
      ];
      const RIGHT_ALIGN = new Set<keyof TableRow>(['cost', 'share']);
      const TRUNCATABLE = new Set<TruncationKey>(['group', 'paidBy', 'description', 'category']);
      const SHRINK_PRIORITY: TruncationKey[] = ['category', 'paidBy', 'group', 'description'];
      const tableGap = tuiMode ? '   ' : '  ';
      let tableWidths: number[] | null = null;
      let jsonStarted = false;
      let totalPrinted = 0;

      const rawGroupNames = allGroups.map((g) => g.name);
      const rawFriendNames = allFriends.map((f) => formatName(f));

      const plannedMinWidth = (
        key: keyof TableRow,
        rows: TableRow[],
        labelWidth: number,
      ): number => {
        const rowValues = rows.map((r) => String(r[key] ?? ''));
        if (key === 'group') {
          const width = minWidthForDistinctValues([...rawGroupNames, ...rawFriendNames, ...rowValues]);
          return Math.max(labelWidth, width);
        }
        if (key === 'description') {
          const width = minWidthForDistinctValues(rowValues);
          return Math.max(labelWidth, width);
        }
        if (key === 'paidBy' || key === 'category') {
          return Math.max(labelWidth, MIN_TRUNCATED_WIDTH);
        }
        return labelWidth;
      };

      const planTableWidths = (rows: TableRow[]): number[] => {
        const labels = TABLE_COLUMNS.map((c) => c.label);
        const naturalWidths = TABLE_COLUMNS.map(({ key }, i) => {
          const labelWidth = visualWidth(labels[i]);
          return Math.max(labelWidth, ...rows.map((r) => visualWidth(String(r[key] ?? ''))));
        });
        const minWidths = TABLE_COLUMNS.map(({ key }, i) =>
          plannedMinWidth(key, rows, visualWidth(labels[i])),
        );

        const available = terminalColumns();
        if (!Number.isFinite(available)) return naturalWidths;

        const widths = [...naturalWidths];
        const gapWidth = visualWidth(tableGap) * (TABLE_COLUMNS.length - 1);
        const total = () => widths.reduce((sum, w) => sum + w, 0) + gapWidth;

        if (total() <= available) return widths;

        while (total() > available) {
          let shrunk = false;
          for (const key of SHRINK_PRIORITY) {
            const colIndex = TABLE_COLUMNS.findIndex((c) => c.key === key);
            if (colIndex < 0) continue;
            if (widths[colIndex] > minWidths[colIndex]) {
              widths[colIndex] -= 1;
              shrunk = true;
              if (total() <= available) return widths;
            }
          }
          if (!shrunk) break;
        }

        if (total() <= available) return widths;

        const fallbackOrder: Array<keyof TableRow> = ['date', 'id'];
        const fallbackMins: Partial<Record<keyof TableRow, number>> = {
          date: Math.max(visualWidth('Date'), 10),
          id: Math.max(visualWidth('ID'), 6),
        };
        for (const key of fallbackOrder) {
          const colIndex = TABLE_COLUMNS.findIndex((c) => c.key === key);
          if (colIndex < 0) continue;
          const min = Math.max(
            visualWidth(TABLE_COLUMNS[colIndex].label),
            fallbackMins[key] ?? 0,
          );
          while (total() > available && widths[colIndex] > min) {
            widths[colIndex] -= 1;
          }
          if (total() <= available) return widths;
        }

        return widths;
      };

      const fitCell = (key: keyof TableRow, value: string, width: number): string => {
        if (visualWidth(stripAnsi(value)) <= width) return value;
        if (!TRUNCATABLE.has(key as TruncationKey)) return value;
        return truncateVisual(value, width);
      };

      const flushTableRows = (rows: TableRow[]) => {
        if (rows.length === 0) return;
        if (tableWidths === null) {
          if (tuiMode) process.stdout.write('\n');
          tableWidths = planTableWidths(rows);
          process.stdout.write(
            TABLE_COLUMNS.map(({ key, label }, i) =>
              RIGHT_ALIGN.has(key) ? padStartVisual(label, tableWidths![i]) : padEndVisual(label, tableWidths![i]),
            ).join(tableGap) + '\n',
          );
          process.stdout.write(tableWidths.map((w) => '─'.repeat(w)).join(tableGap) + '\n');
        }
        for (const row of rows) {
          process.stdout.write(
            TABLE_COLUMNS.map(({ key }, i) => {
              const k = key;
              const cell = fitCell(k, String(row[k] ?? ''), tableWidths![i]);
              return RIGHT_ALIGN.has(k) ? padStartVisual(cell, tableWidths![i]) : padEndVisual(cell, tableWidths![i]);
            }).join(tableGap) + '\n',
          );
          totalPrinted++;
        }
      };

      const flushFullRows = (rows: FullRow[]) => {
        for (const row of rows) {
          const serialized = '  ' + JSON.stringify(row, null, 2).replace(/\n/g, '\n  ');
          if (fmt === 'json') {
            if (!jsonStarted) { process.stdout.write('[\n'); jsonStarted = true; }
            else { process.stdout.write(',\n'); }
            process.stdout.write(serialized);
          } else {
            process.stdout.write(yamlDump([row], { lineWidth: -1 }));
          }
          totalPrinted++;
        }
      };

      const flushPage = async (page: Expense[], remaining = Infinity): Promise<number> => {
        const filtered = page.filter(passesFilter).slice(0, remaining);
        if (filtered.length === 0) return 0;
        await ensureGroupNamesResolved(filtered);
        if (fmt === 'table') flushTableRows(filtered.map(toTableRow));
        else flushFullRows(filtered.map(toFullRow));
        return filtered.length;
      };

      const finalize = () => {
        if (fmt === 'json') process.stdout.write(jsonStarted ? '\n]\n' : '[]\n');
        else if (totalPrinted === 0) process.stdout.write(fmt === 'yaml' ? '[]\n' : '(no results)\n');
        consumeClientWarnings();
        if (tuiMode) {
          const elapsed = Date.now() - startedAt;
          logger.info(`• ${totalPrinted} item(s) | ${elapsed} ms | source: ${sw.getSourceLabel()}`);
        }
      };

      // ── Execute ───────────────────────────────────────────────────────────
      if (opts.all) {
        let pageCount = 0;
        progress.start('Fetching expenses...');
        for await (const page of sw.expenses.list(params).byPage()) {
          progress.stop();
          pageCount++;
          await flushPage(page);
          progress.start(`Fetched ${pageCount} page(s), loading more...`);
        }
        progress.stop();
      } else if (hasLocalFilter) {
        let emitted = 0;
        let pageCount = 0;
        progress.start('Fetching expenses...');
        for await (const page of sw.expenses.list(params).byPage()) {
          progress.stop();
          pageCount++;
          emitted += await flushPage(page, max - emitted);
          if (emitted >= max) break;
          progress.start(`Fetched ${pageCount} page(s), loading more...`);
        }
        progress.stop();
      } else {
        params.limit = max;
        progress.start('Fetching expenses...');
        const page = await sw.expenses.list(params);
        progress.stop();
        await flushPage(page);
      }

      finalize();
    });

  addOutputOption(expenses.command('add'))
    .description('Add a new expense')
    .option('-d, --description <text>', 'Expense description')
    .option('-a, --cost <amount>', 'Expense cost')
    .option('--date <date>', 'Expense date (YYYY-MM-DD or relative)')
    .option('-C, --currency <code>', 'Currency code')
    .option('-g, --group <id|name>', 'Group ID or partial name')
    .option('-u, --friend <id|name>', 'Friend ID or partial name')
    .option('--notes <text>', 'Additional notes')
    .option('--category <id|name>', 'Category ID or partial name')
    .option('--payer <@me|id|name>', 'User who paid the expense', '@me')
    .option('--split-equally', 'Split equally when no custom shares are provided', true)
    .option('--user-share <spec>', 'Custom user share as id:paid:owed', (value: string, previous: string[]) => [...previous, value], [] as string[])
    .action(async function (
      this: Command,
      opts: {
        description?: string;
        cost?: string;
        date?: string;
        currency?: string;
        group?: string;
        friend?: string;
        notes?: string;
        category?: string;
        payer?: string;
        splitEqually?: boolean;
        userShare?: string[];
      },
    ) {
      const logger = createLogger(this, 'expenses');
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);

      ensureCreateExpenseAllowed(this);

      const sw = getDataClient(this);
      const { profile, name: profileName } = resolveProfile(this);
      const target = resolveCacheTarget(this);
      const { name: credentialName, credential } = resolveCredential(this);
      const accountUserId = credential.userId;

      let description = opts.description;
      let cost = opts.cost;
      if (tuiMode && (!description || !cost)) {
        const answer = await prompts([
          ...(description ? [] : [{ type: 'text' as const, name: 'description', message: 'Expense description' }]),
          ...(cost ? [] : [{ type: 'text' as const, name: 'cost', message: 'Expense cost' }]),
        ]);
        description ??= typeof answer.description === 'string' ? answer.description : undefined;
        cost ??= typeof answer.cost === 'string' ? answer.cost : undefined;
      }

      if (!description || !cost) {
        logger.error('Expense description and cost are required.');
        process.exit(1);
      }

      const latestGroupsEntry = findLatestCacheEntry(target, { entity: 'groups', accountUserId, profileName });
      const latestFriendsEntry = findLatestCacheEntry(target, { entity: 'friends', accountUserId, profileName });
      let allGroups = isFreshEnough(latestGroupsEntry?.exportedAt)
        ? loadLatestGroups(target, accountUserId, profileName)
        : [];
      let allFriends = isFreshEnough(latestFriendsEntry?.exportedAt)
        ? loadLatestFriends(target, accountUserId, profileName)
        : [];
      let groupsLoadedFromApi = false;
      let friendsLoadedFromApi = false;

      let meCache: Awaited<ReturnType<typeof sw.users.getCurrent>> | undefined;
      async function getMe() {
        if (!meCache) meCache = await sw.users.getCurrent();
        return meCache;
      }

      const refreshGroupsFromApi = async () => {
        if (sw.getSourceKind() === 'cache') return allGroups;
        const summaries = await sw.groups.list();
        const fullGroups = [] as typeof summaries;
        for (const summary of summaries) {
          fullGroups.push(await sw.groups.get({ id: summary.id }));
        }
        const me = await getMe();
        saveLookupEntitySnapshot({
          target,
          entity: 'groups',
          profileName,
          credentialName,
          accountUserId: me.id,
          accountUserName: formatName(me),
          items: fullGroups,
        });
        allGroups = fullGroups;
        groupsLoadedFromApi = true;
        return allGroups;
      };

      const refreshFriendsFromApi = async () => {
        if (sw.getSourceKind() === 'cache') return allFriends;
        const remoteFriends = await sw.friends.list();
        const me = await getMe();
        saveLookupEntitySnapshot({
          target,
          entity: 'friends',
          profileName,
          credentialName,
          accountUserId: me.id,
          accountUserName: formatName(me),
          items: remoteFriends,
        });
        allFriends = remoteFriends;
        friendsLoadedFromApi = true;
        return allFriends;
      };

      if (allGroups.length === 0 && sw.getSourceKind() !== 'cache') {
        allGroups = await refreshGroupsFromApi();
      }
      if (allFriends.length === 0 && sw.getSourceKind() !== 'cache') {
        allFriends = await refreshFriendsFromApi();
      }

      const groupLookup = new Map<number, string>();
      for (const group of allGroups) groupLookup.set(group.id, group.name);

      const resolveUser = async (label: string, value: string): Promise<number | undefined> => {
        if (value === '@me') return (await getMe()).id;
        const asNum = Number(value);
        if (!Number.isNaN(asNum) && String(asNum) === value) return asNum;

        const needle = value.toLowerCase();
        const me = await getMe();
        const unique = [...new Map(
          [...allFriends, me]
            .filter((user) => formatName(user).toLowerCase().includes(needle))
            .map((user) => [user.id, user]),
        ).values()];

        if (unique.length === 0) {
          logger.error(`No user matching "${value}" for ${label}.`);
          process.exit(1);
        }
        if (unique.length > 1) {
          logger.error(
            `Ambiguous ${label} "${value}" — matches: ${unique.map((user) => `"${formatName(user)}"`).join(', ')}. Be more specific.`,
          );
          process.exit(1);
        }
        return unique[0].id;
      };

      const resolveGroupId = async (value?: string): Promise<number | undefined> => {
        if (value === undefined) return undefined;
        const asNum = Number(value);
        if (!Number.isNaN(asNum) && String(asNum) === value) {
          ensureExpenseGroupAllowed(this, asNum, 'expenses add');
          return asNum;
        }

        const needle = value.toLowerCase();
        let matches = allGroups.filter((group) => group.name.toLowerCase().includes(needle));
        if (matches.length === 0 && !groupsLoadedFromApi && sw.getSourceKind() !== 'cache') {
          allGroups = await refreshGroupsFromApi();
          groupLookup.clear();
          for (const group of allGroups) groupLookup.set(group.id, group.name);
          matches = allGroups.filter((group) => group.name.toLowerCase().includes(needle));
        }

        if (matches.length === 0) {
          logger.error(`No group matching "${value}".`);
          process.exit(1);
        }
        if (matches.length > 1) {
          logger.error(
            `Ambiguous group "${value}" — matches: ${matches.map((group) => `"${group.name}"`).join(', ')}. Be more specific.`,
          );
          process.exit(1);
        }
        ensureExpenseGroupAllowed(this, matches[0].id, 'expenses add');
        return matches[0].id;
      };

      const resolveFriendId = async (value?: string): Promise<number | undefined> => {
        if (value === undefined) return undefined;
        const asNum = Number(value);
        if (!Number.isNaN(asNum) && String(asNum) === value) {
          ensureExpenseFriendAllowed(this, asNum, 'expenses add');
          return asNum;
        }

        const needle = value.toLowerCase();
        let matches = allFriends.filter((friend) =>
          `${friend.firstName} ${friend.lastName}`.toLowerCase().includes(needle)
          || (friend.firstName ?? '').toLowerCase().includes(needle),
        );
        if (matches.length === 0 && !friendsLoadedFromApi && sw.getSourceKind() !== 'cache') {
          allFriends = await refreshFriendsFromApi();
          matches = allFriends.filter((friend) =>
            `${friend.firstName} ${friend.lastName}`.toLowerCase().includes(needle)
            || (friend.firstName ?? '').toLowerCase().includes(needle),
          );
        }

        if (matches.length === 0) {
          logger.error(`No friend matching "${value}".`);
          process.exit(1);
        }
        if (matches.length > 1) {
          logger.error(
            `Ambiguous friend "${value}" — matches: ${matches.map((friend) => `"${formatName(friend)}"`).join(', ')}. Be more specific.`,
          );
          process.exit(1);
        }
        ensureExpenseFriendAllowed(this, matches[0].id, 'expenses add');
        return matches[0].id;
      };

      const resolveCategoryId = async (value?: string): Promise<number | undefined> => {
        if (value === undefined) return undefined;
        const asNum = Number(value);
        if (!Number.isNaN(asNum) && String(asNum) === value) return asNum;
        const categories = await sw.categories.list();
        const needle = value.toLowerCase();
        const matches = categories.filter((category) => category.name.toLowerCase().includes(needle));
        if (matches.length === 0) {
          logger.error(`No category matching "${value}".`);
          process.exit(1);
        }
        if (matches.length > 1) {
          logger.error(
            `Ambiguous category "${value}" — matches: ${matches.map((category) => `"${category.name}"`).join(', ')}. Be more specific.`,
          );
          process.exit(1);
        }
        return matches[0].id;
      };

      const payerId = await resolveUser('--payer', opts.payer ?? '@me');
      const groupId = await resolveGroupId(opts.group);
      const friendId = await resolveFriendId(opts.friend);
      const categoryId = await resolveCategoryId(opts.category);
      const date = parseDate(opts.date ?? new Date().toISOString().slice(0, 10));
      const me = await getMe();
      const currencyCode = opts.currency ?? me.defaultCurrency ?? 'USD';
      const shares = (opts.userShare ?? []).map(parseExpenseShareInput);

      const created = await sw.expenses.create(buildExpenseCreateParams({
        description,
        cost,
        date,
        currencyCode,
        ...(groupId !== undefined && { groupId }),
        ...(friendId !== undefined && { friendId }),
        ...(opts.notes !== undefined && { details: opts.notes }),
        ...(categoryId !== undefined && { categoryId }),
        ...(payerId !== undefined && shares.length > 0 && { shares }),
        ...(payerId !== undefined && shares.length === 0 && { splitEqually: opts.splitEqually ?? true }),
      }));

      renderOne({
        id: created.id,
        description: created.description,
        cost: created.cost,
        currency: created.currencyCode,
        date: created.date ?? '',
        category: created.category?.name ?? '',
        group: created.groupId !== null ? (groupLookup.get(created.groupId ?? -1) ?? String(created.groupId ?? '')) : '',
        payment: String(created.payment),
      }, fmt, { tuiMode });
    });

  expenses.command('delete <id>')
    .description('Delete an expense')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async function (this: Command, id: string, opts: { yes?: boolean }) {
      const logger = createLogger(this, 'expenses');
      const sw = getDataClient(this);
      const tuiMode = isTuiDefault(this);

      ensureDeleteExpenseAllowed(this);

      const expenseId = Number(id);
      if (!Number.isInteger(expenseId) || expenseId <= 0) {
        logger.error(`Invalid expense id "${id}".`);
        process.exit(1);
      }

      if (!opts.yes) {
        const expense = await sw.expenses.get({ id: expenseId });
        if (tuiMode) writeTuiInfoSpacer(true);
        logger.info(`Delete expense ${expense.id}: ${expense.description} (${expense.cost} ${expense.currencyCode})?`);
        const answer = await prompts({
          type: 'confirm',
          name: 'confirmed',
          message: 'Delete this expense?',
          initial: false,
        });
        if (answer.confirmed !== true) {
          logger.warn('Delete aborted.');
          process.exit(1);
        }
      }

      await sw.expenses.delete({ id: expenseId });
      logger.success(`Deleted expense ${expenseId}.`);
    });

  expenses
    .command('import <file>')
    .description('Import expenses from a YAML or JSON file')
    .option('--dry-run', 'Preview changes without writing')
    .option('--log-import [file]', 'Append per-row import events as JSONL (defaults to <import-file>.jsonl)')
    .option('--matcher <type>', 'Duplicate matching strategy: exact|intelligent', 'exact')
    .option('--match-scope <scope>', 'Duplicate match scope: target|account', 'target')
    .option('--on-duplicate <action>', 'Action on duplicate: skip|update', 'skip')
    .option('--limit <number>', 'Limit to first N records')
    .option('--no-cache', 'Do not cache results')
    .option('-o, --output <format>', 'Output format')
    .action(async function (this: Command, file: string, opts: any) {
      const fmt: OutputFormat = getFormat(this);
      const logger = createLogger(this, 'expenses import');
      const tuiMode = isTuiDefault(this);
      ensureCreateExpenseAllowed(this);

      if (tuiMode) writeTuiInfoSpacer(true);

      const progress = createTuiProgress(tuiMode);

      const matcherName = String(opts.matcher ?? '').trim().toLowerCase();
      const onDuplicate = String(opts.onDuplicate ?? '').trim().toLowerCase();
      const matchScope = String(opts.matchScope ?? '').trim().toLowerCase() as MatchScope;

      if (matcherName !== 'exact' && matcherName !== 'intelligent') {
        logger.error(`Invalid --matcher value "${opts.matcher}". Expected one of: exact, intelligent.`);
        process.exit(1);
      }
      if (onDuplicate !== 'skip' && onDuplicate !== 'update') {
        logger.error(`Invalid --on-duplicate value "${opts.onDuplicate}". Expected one of: skip, update.`);
        process.exit(1);
      }
      if (matchScope !== 'target' && matchScope !== 'account') {
        logger.error(`Invalid --match-scope value "${opts.matchScope}". Expected one of: target, account.`);
        process.exit(1);
      }

      logger.debug(`Matcher: ${matcherName}`);
      logger.debug(`Match scope: ${matchScope}`);
      logger.debug(`On duplicate: ${onDuplicate}`);
      logger.debug(
        `Import options => dryRun=${opts.dryRun === true}, limit=${opts.limit ?? 'none'}, noCache=${opts.cache === false}`,
      );

      const logImportPath = (() => {
        const rawValue = opts.logImport;
        if (rawValue === undefined || rawValue === false) return undefined;
        if (typeof rawValue === 'string' && rawValue.trim().length > 0) return rawValue.trim();
        return `${file}.jsonl`;
      })();

      if (logImportPath) {
        try {
          // Ensure path is writable early and keep append-only semantics.
          appendFileSync(logImportPath, '');
          logger.debug(`Import logging enabled at ${logImportPath}`);
        } catch (err) {
          logger.error(`Unable to open import log file "${logImportPath}" for append.`);
          logger.error((err as Error).message);
          process.exit(1);
        }
      }

      const appendImportLog = (entry: Record<string, unknown>) => {
        if (!logImportPath) return;
        const { action, description, ...rest } = entry;
        const row = {
          ts: new Date().toISOString(),
          sourceFile: file,
          action,
          description,
          ...rest,
        };
        try {
          appendFileSync(logImportPath, `${JSON.stringify(row)}\n`);
        } catch (err) {
          logger.error(`Failed to append import log entry to "${logImportPath}".`);
          logger.error((err as Error).message);
          process.exit(1);
        }
      };

      // Parse import file
      let records: ImportExpenseRecord[];
      try {
        progress.start('Parsing import file...');
        records = parseImportFile(file);
        
        // Apply limit if specified
        if (opts.limit !== undefined) {
          const limitNum = Number(opts.limit);
          if (!Number.isInteger(limitNum) || limitNum <= 0) {
            throw new Error(`Invalid --limit value "${opts.limit}". Must be a positive integer.`);
          }
          records = records.slice(0, limitNum);
        }
        
        progress.stop(`Parsed ${records.length} record(s)`, 'success');
      } catch (err) {
        progress.fail(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const sw = getDataClient(this);
      const profile = resolveProfile(this);

      // Fetch current state for duplicate matching
      let currentUser;
      let allExpenses: Expense[] = [];
      let friends: any[] = [];
      let groups: any[] = [];
      let categories: any[] = [];

      try {
        progress.start('Fetching reference data...');
        [currentUser, friends, groups, categories] = await Promise.all([
          sw.users.getCurrent(),
          sw.friends.list({}),
          sw.groups.list({}),
          sw.categories.list(),
        ]);
        progress.stop('Reference data loaded', 'success');
      } catch (err) {
        progress.fail('Failed to fetch reference data.');
        logger.error((err as Error).message);
        process.exit(1);
      }

      // Build import context
      const flattenedCategories = categories.flatMap((category: any) => {
        const base = [{ id: category.id, name: category.name }];
        const subs = Array.isArray(category.subcategories)
          ? category.subcategories.flatMap((sub: any) => {
              const rows: Array<{ id: number; name: string }> = [];
              if (typeof sub?.name === 'string' && sub.name.trim().length > 0) {
                rows.push({ id: sub.id, name: sub.name });
                if (typeof category?.name === 'string' && category.name.trim().length > 0) {
                  rows.push({ id: sub.id, name: `${category.name} - ${sub.name}` });
                }
              }
              return rows;
            })
          : [];
        return [...base, ...subs];
      });

      const context: ImportContext = {
        groups: groups.map((g: any) => ({ id: g.id, name: g.name })),
        friends: friends.map((f: any) => ({ id: f.id, firstName: f.firstName, lastName: f.lastName })),
        categories: flattenedCategories,
        meId: currentUser.id,
        lookupMap: new Map(),
      };

      const matchesImportScope = (params: ExpenseCreateParams, existing: Expense): boolean => {
        if (params.groupId !== undefined) {
          const existingGroupId = Number((existing as any).groupId ?? (existing as any).group_id);
          return Number.isFinite(existingGroupId) && existingGroupId === params.groupId;
        }

        if (params.friendId !== undefined) {
          if (existing.groupId !== null && existing.groupId !== undefined) return false;

          const existingFriendId = Number((existing as any).friendId ?? (existing as any).friend_id);
          if (!Number.isNaN(existingFriendId)) {
            return existingFriendId === params.friendId;
          }

          const participantIds = (existing.users ?? []).map((u) => u.userId);
          if (participantIds.length === 0) return false;
          return participantIds.includes(params.friendId) && participantIds.includes(context.meId);
        }

        return true;
      };

      const preparedRecords = records.map((record) => ({
        record,
        params: normalizeToCreateParams(record, context),
      }));

      const matcher = matcherName === 'intelligent' ? intelligentMatch : exactMatch;

      // Load existing expenses for duplicate detection
      try {
        progress.start('Fetching existing expenses...');

        const shiftIsoDate = (isoDate: string, days: number): string => {
          const base = new Date(`${isoDate}T00:00:00Z`);
          if (Number.isNaN(base.getTime())) return isoDate;
          base.setUTCDate(base.getUTCDate() + days);
          return base.toISOString().slice(0, 10);
        };

        const dates = records
          .map((r) => String(r.date ?? '').trim().slice(0, 10))
          .filter(Boolean)
          .sort();
        const hasUndatedRecords = records.some((r) => String(r.date ?? '').trim().length === 0);
        const datedAfter = dates[0]
          ? shiftIsoDate(dates[0], -1)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const datedBefore = dates[dates.length - 1]
          ? shiftIsoDate(dates[dates.length - 1], 1)
          : new Date().toISOString().slice(0, 10);

        const fetchParams: Record<string, unknown> = sw.getSourceKind() === 'cache'
          ? { from: datedAfter, to: datedBefore }
          : { datedAfter, datedBefore };

        const groupTargets = new Set(preparedRecords
          .map(({ params }) => params?.groupId)
          .filter((id): id is number => id !== undefined));
        const friendTargets = new Set(preparedRecords
          .map(({ params }) => params?.friendId)
          .filter((id): id is number => id !== undefined));

        if (matchScope === 'target' && groupTargets.size === 1 && friendTargets.size === 0) {
          fetchParams.groupId = [...groupTargets][0];
        } else if (matchScope === 'target' && friendTargets.size === 1 && groupTargets.size === 0) {
          fetchParams.friendId = [...friendTargets][0];
        }

        // Undated records can be created with provider-default dates (often today).
        // If a single target is known, fetch all target expenses to avoid missing rerun duplicates.
        if (
          hasUndatedRecords
          && matchScope === 'target'
          && ((groupTargets.size === 1 && friendTargets.size === 0) || (friendTargets.size === 1 && groupTargets.size === 0))
        ) {
          delete fetchParams.datedAfter;
          delete fetchParams.datedBefore;
          delete fetchParams.from;
          delete fetchParams.to;
          logger.debug('Detected undated import rows; fetching full target scope without date bounds for duplicate detection.');
        }

        for await (const page of sw.expenses.list(fetchParams).byPage()) {
          allExpenses.push(...page);
        }

        progress.stop('Fetched existing expenses in date window', 'success');
      } catch (err) {
        progress.fail('Failed to fetch existing expenses.');
        logger.error((err as Error).message);
        process.exit(1);
      }

      logger.debug(
        `Prepared ${preparedRecords.length} record(s); ${preparedRecords.filter((r) => r.params !== null).length} valid for matching`,
      );

      const scopedExistingCount = allExpenses.filter((expense) =>
        matchScope === 'account'
          ? true
          : preparedRecords.some(({ params }) => params !== null && matchesImportScope(params, expense)),
      ).length;

      logger.debug(`Loaded ${allExpenses.length} existing expense(s) in date window.`);
      logger.debug(`Found ${scopedExistingCount} existing expense(s) in import scope.`);

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      const emitImportItem = (item: Record<string, unknown>) => {
        render([item], fmt);
      };

      // Process records
      progress.start('Processing records...');
      for (let index = 0; index < preparedRecords.length; index++) {
        const { record, params } = preparedRecords[index];
        const label = String(record.description ?? `record#${index + 1}`);
        const rawIdHint = (record as any).id_hint ?? (record as any).idHint;
        const idHint = rawIdHint === undefined || rawIdHint === null
          ? undefined
          : Number(String(rawIdHint).trim());
        const validIdHint = Number.isInteger(idHint) && Number(idHint) > 0 ? Number(idHint) : undefined;
        const logDate = String(record.date ?? '').trim() || undefined;
        const logAmount = String(record.cost ?? '').trim() || undefined;
        const logCurrency = String((record as any).currency ?? (record as any).currencyCode ?? '').trim().toUpperCase() || undefined;
        const logNotes = String((record as any).notes ?? (record as any).details ?? '').trim() || undefined;
        const baseLogPayload = {
          row: index + 1,
          description: label,
          date: logDate,
          amount: logAmount,
          currency: logCurrency,
          notes: logNotes,
          idHint: validIdHint,
        };
        const rawCategory = record.categoryId ?? (record as any).category_id ?? record.category;

        if (!params) {
          logger.debug(`[${index + 1}/${preparedRecords.length}] ${label}: invalid input (missing description/cost)`);
          const reason = 'Missing required fields (description, cost)';
          errorCount++;
          appendImportLog({
            ...baseLogPayload,
            action: 'error',
            reason,
          });
          emitImportItem({
            index: index + 1,
            description: label,
            status: 'error',
            reason,
          });
          continue;
        }

        if (rawCategory !== undefined && rawCategory !== null && String(rawCategory).trim().length > 0 && params.categoryId === undefined) {
          const reason = `Unknown or ambiguous category "${String(rawCategory)}"`;
          logger.debug(`[${index + 1}/${preparedRecords.length}] ${label}: invalid category - ${reason}`);
          errorCount++;
          appendImportLog({
            ...baseLogPayload,
            action: 'error',
            reason,
            category: String(rawCategory),
          });
          emitImportItem({
            index: index + 1,
            description: label,
            status: 'error',
            reason,
          });
          continue;
        }

        logger.debug(
          `[${index + 1}/${preparedRecords.length}] ${label}: evaluating duplicate using ${matcherName}/${matchScope}`,
        );
        logger.debug(
          `[${index + 1}/${preparedRecords.length}] ${label}: resolved target groupId=${params.groupId ?? 'none'} friendId=${params.friendId ?? 'none'} categoryId=${params.categoryId ?? 'none'}`,
        );

        const duplicateByHint = validIdHint === undefined
          ? undefined
          : allExpenses.find((e) => Number(e.id) === validIdHint);

        if (validIdHint !== undefined) {
          logger.debug(
            duplicateByHint
              ? `[${index + 1}/${preparedRecords.length}] ${label}: id_hint=${validIdHint} matched loaded expense #${duplicateByHint.id}`
              : `[${index + 1}/${preparedRecords.length}] ${label}: id_hint=${validIdHint} not found in loaded expenses; falling back to ${matcherName}/${matchScope}`,
          );
        }

        const duplicate = duplicateByHint ?? allExpenses.find((e) => matcher(params, e, context.meId, matchScope));

        if (duplicate) {
          logger.debug(
            `[${index + 1}/${preparedRecords.length}] ${label}: duplicate matched expense #${duplicate.id}`,
          );

          if (onDuplicate === 'update' && !opts.dryRun) {
            const updateParams = buildExpenseUpdateParams(duplicate.id, params, duplicate);
            if (updateParams) {
              try {
                const updatedExpense = await sw.expenses.update(updateParams);
                updatedCount++;
                appendImportLog({
                  ...baseLogPayload,
                  action: 'updated',
                  expenseId: Number(updatedExpense.id),
                  duplicateId: Number(duplicate.id),
                });
                emitImportItem({
                  index: index + 1,
                  description: label,
                  status: 'updated',
                  expenseId: Number(updatedExpense.id),
                  duplicateId: Number(duplicate.id),
                });
                logger.debug(
                  `[${index + 1}/${preparedRecords.length}] ${label}: updated duplicate expense #${updatedExpense.id}`,
                );
                // Replace the old entry in allExpenses so subsequent records see the updated version
                const idx = allExpenses.indexOf(duplicate);
                if (idx >= 0) allExpenses[idx] = updatedExpense;
              } catch (err) {
                logger.debug(
                  `[${index + 1}/${preparedRecords.length}] ${label}: update failed - ${(err as Error).message}`,
                );
                errorCount++;
                appendImportLog({
                  ...baseLogPayload,
                  action: 'error',
                  reason: (err as Error).message,
                  duplicateId: Number(duplicate.id),
                });
                emitImportItem({
                  index: index + 1,
                  description: label,
                  status: 'error',
                  reason: (err as Error).message,
                  duplicateId: Number(duplicate.id),
                });
              }
            } else {
              // No actual changes to make
              logger.debug(
                `[${index + 1}/${preparedRecords.length}] ${label}: duplicate unchanged - skipping update`,
              );
              skippedCount++;
              appendImportLog({
                ...baseLogPayload,
                action: 'skipped',
                reason: 'no_changes',
                duplicateId: Number(duplicate.id),
              });
              emitImportItem({
                index: index + 1,
                description: label,
                status: 'skipped',
                duplicateId: Number(duplicate.id),
              });
            }
          } else {
            logger.debug(
              `[${index + 1}/${preparedRecords.length}] ${label}: duplicate action ${onDuplicate}${opts.dryRun ? ' (dry-run)' : ''} => skip`,
            );
            skippedCount++;
            appendImportLog({
              ...baseLogPayload,
              action: 'skipped',
              reason: `duplicate_${onDuplicate}${opts.dryRun ? '_dry_run' : ''}`,
              duplicateId: Number(duplicate.id),
            });
            emitImportItem({
              index: index + 1,
              description: label,
              status: 'skipped',
              duplicateId: Number(duplicate.id),
            });
          }
        } else {
          if (!opts.dryRun) {
            try {
              const created_expense = await sw.expenses.create(params);
              createdCount++;
              appendImportLog({
                ...baseLogPayload,
                action: 'created',
                expenseId: Number(created_expense.id),
              });
              emitImportItem({
                index: index + 1,
                description: label,
                status: 'created',
                expenseId: Number(created_expense.id),
              });
              allExpenses.push(created_expense); // Track for subsequent records
              logger.debug(
                `[${index + 1}/${preparedRecords.length}] ${label}: created new expense #${created_expense.id}`,
              );
            } catch (err) {
              logger.debug(
                `[${index + 1}/${preparedRecords.length}] ${label}: create failed - ${(err as Error).message}`,
              );
              errorCount++;
              appendImportLog({
                ...baseLogPayload,
                action: 'error',
                reason: (err as Error).message,
              });
              emitImportItem({
                index: index + 1,
                description: label,
                status: 'error',
                reason: (err as Error).message,
              });
            }
          } else {
            logger.debug(
              `[${index + 1}/${preparedRecords.length}] ${label}: would create (dry-run)`,
            );
            createdCount++;
            appendImportLog({
              ...baseLogPayload,
              action: 'dry-run-create',
            });
            emitImportItem({
              index: index + 1,
              description: label,
              status: 'dry-run-create',
            });
          }
        }
      }

      progress.stop('Done', 'success');

      renderOne({
        matcher: matcherName,
        matchScope,
        onDuplicate,
        dryRun: opts.dryRun === true,
        created: createdCount,
        updated: updatedCount,
        skipped: skippedCount,
        errors: errorCount,
      }, fmt, { tuiMode });

      if (opts.dryRun) {
        logger.warn('(Dry-run mode: no changes written)');
      }
    });

  addOutputOption(expenses.command('get <id>'))
    .description('Get details for an expense')
    .action(async function (this: Command, id: string) {
      const logger = createLogger(this, 'expenses');
      const fmt: OutputFormat = getFormat(this);
      const tuiMode = isTuiDefault(this);

      const sw = getDataClient(this);
      if (tuiMode) {
        writeTuiInfoSpacer(true);
        logger.info(`Showing expense details for ${id}`);
      }
      const progress = createTuiProgress(tuiMode);
      let e;
      let fetchedComments;
      progress.start('Fetching expense details...');
      try {
        [e, fetchedComments] = await Promise.all([
          sw.expenses.get({ id: Number(id) }),
          sw.comments.list({ expenseId: Number(id) }),
        ]);
      } catch (err) {
        progress.fail('Failed to fetch expense details.');
        throw err;
      }
      progress.stop('Fetched expense details.', 'success');

      const comments = fetchedComments.map((c) => ({
        id: c.id,
        content: c.content,
        author: formatName(c.user),
        createdAt: c.createdAt,
      }));

      if (e.groupId !== null) ensureExpenseGroupAllowed(this, e.groupId, 'expenses get');

      if (fmt === 'table') {
        renderOne(
          {
            id: e.id,
            description: e.description ?? '',
            cost: `${e.cost} ${e.currencyCode}`,
            category: e.category?.name ?? '',
            isPayment: String(e.payment),
            date: e.date ?? '',
            ...(e.details ? { notes: e.details } : {}),
            createdAt: e.createdAt,
            createdBy: formatName(e.createdBy),
            updatedAt: e.updatedAt ?? '',
            updatedBy: formatName(e.updatedBy),
          },
          fmt,
          { tuiMode },
        );
        if (e.users && e.users.length > 0) {
          if (tuiMode) writeTuiInfoSpacer(true);
          logger.info('Shares:');
          if (tuiMode) process.stdout.write('\n');
          console.table(
            e.users.map((u) => ({
              name: formatName(u.user),
              paid: u.paidShare,
              owes: u.owedShare,
            })),
          );
          if (tuiMode) process.stdout.write('\n');
        }
        if (comments.length > 0) {
          if (tuiMode) writeTuiInfoSpacer(true);
          logger.info('Comments:');
          if (tuiMode) process.stdout.write('\n');
          console.table(comments);
          if (tuiMode) process.stdout.write('\n');
        }
      } else {
        render(
          [
            {
              id: e.id,
              description: e.description ?? '',
              cost: e.cost,
              currency: e.currencyCode,
              categoryId: e.category?.id,
              category: e.category?.name ?? '',
              isPayment: e.payment,
              date: e.date ?? '',
              notes: e.details || undefined,
              createdAt: e.createdAt,
              createdById: e.createdBy?.id,
              createdByName: formatName(e.createdBy),
              updatedAt: e.updatedAt,
              updatedById: e.updatedBy?.id,
              updatedByName: formatName(e.updatedBy),
              deletedAt: e.deletedAt,
              deletedById: e.deletedBy?.id,
              deletedByName: formatName(e.deletedBy),
              shares: e.users?.map((u) => ({
                name: formatName(u.user),
                paid: u.paidShare,
                owes: u.owedShare,
              })) ?? [],
              comments,
            },
          ],
          fmt,
        );
      }
    });
}
