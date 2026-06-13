import { Command } from 'commander';
import { dump as yamlDump } from 'js-yaml';
import { type Expense } from 'splitwise';
import {
  getClient,
  getCacheRootPath,
  resolveCacheTarget,
  resolveCredential,
  resolveOfflineMode,
  ensureExpenseGroupAllowed,
  ensureExpenseFriendAllowed,
  resolveProfile,
} from '../lib/config.js';
import { findOfflineExpenseById, loadLatestFriends, loadLatestGroups, resolveOfflineExpenses } from '../lib/cache.js';
import {
  addOutputOption, getFormat, formatName,
  render, renderOne, renderEmptyList, renderTuiList,
  isTuiDefault, colorize, createTuiProgress, createLogger, writeTuiInfoSpacer,
  visualWidth, padStartVisual, padEndVisual,
  type OutputFormat,
} from '../lib/output.js';
import { parseDate } from '../lib/dates.js';

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const MIN_TRUNCATED_WIDTH = 13; // 10 visible characters + "..."

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
      const { profile, name: profileName } = resolveProfile(this);

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

      if (resolveOfflineMode(this)) {
        const target = resolveCacheTarget(this);
        const { credential } = resolveCredential(this);
        const startedAt = Date.now();
        const cachedGroups = loadLatestGroups(target, credential.userId, profileName);
        const cachedFriends = loadLatestFriends(target, credential.userId, profileName);
        const groupLookup = new Map<number, string>();
        for (const group of cachedGroups) groupLookup.set(group.id, group.name);

        const resolveOfflineUser = (label: string, value: string): number | undefined => {
          if (value === '@me') return credential.userId;
          const asNum = Number(value);
          if (!Number.isNaN(asNum) && String(asNum) === value) return asNum;
          const needle = value.toLowerCase();
          const me = credential.userId && credential.userName
            ? [{ id: credential.userId, firstName: credential.userName, lastName: null }]
            : [];
          const unique = [...new Map(
            [...cachedFriends, ...me]
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

        let groupId: number | undefined;
        if (opts.group !== undefined) {
          const asNum = Number(opts.group);
          if (!Number.isNaN(asNum) && String(asNum) === opts.group) {
            ensureExpenseGroupAllowed(this, asNum, 'expenses list');
            groupId = asNum;
          } else {
            const needle = opts.group.toLowerCase();
            const matches = cachedGroups.filter((group) => group.name.toLowerCase().includes(needle));
            if (matches.length === 0) {
              logger.warn(`Warning: no group matching "${opts.group}" - returning empty list.`);
              renderEmptyList(fmt);
              return;
            }
            if (matches.length > 1) {
              logger.error(
                `Ambiguous group "${opts.group}" — matches: ${matches.map((group) => `"${group.name}"`).join(', ')}. Be more specific.`,
              );
              process.exit(1);
            }
            ensureExpenseGroupAllowed(this, matches[0].id, 'expenses list');
            groupId = matches[0].id;
          }
        }

        let friendId: number | undefined;
        if (opts.friend !== undefined) {
          const asNum = Number(opts.friend);
          if (!Number.isNaN(asNum) && String(asNum) === opts.friend) {
            ensureExpenseFriendAllowed(this, asNum, 'expenses list');
            friendId = asNum;
          } else {
            const needle = opts.friend.toLowerCase();
            const matches = cachedFriends.filter((friend) => formatName(friend).toLowerCase().includes(needle));
            if (matches.length === 0) {
              logger.warn(`Warning: no friend matching "${opts.friend}" - returning empty list.`);
              renderEmptyList(fmt);
              return;
            }
            if (matches.length > 1) {
              logger.error(
                `Ambiguous friend "${opts.friend}" — matches: ${matches.map((friend) => `"${formatName(friend)}"`).join(', ')}. Be more specific.`,
              );
              process.exit(1);
            }
            ensureExpenseFriendAllowed(this, matches[0].id, 'expenses list');
            friendId = matches[0].id;
          }
        }

        const datedAfter = opts.from ? parseDate(opts.from) : undefined;
        const datedBefore = opts.to ? parseDate(opts.to) : undefined;
        const involvedId = opts.involved !== undefined
          ? resolveOfflineUser('--involved', opts.involved)
          : undefined;
        if (involvedId !== undefined) ensureExpenseFriendAllowed(this, involvedId, 'expenses list');

        const payerId = (opts.mine ? '@me' : opts.payer) !== undefined
          ? resolveOfflineUser('--payer', opts.mine ? '@me' : opts.payer!)
          : undefined;
        if (payerId !== undefined) ensureExpenseFriendAllowed(this, payerId, 'expenses list');

        const offline = resolveOfflineExpenses(target, credential.userId, {
          from: datedAfter,
          to: datedBefore,
          groupId,
          friendId,
        });
        for (const warning of offline.warnings) logger.warn(warning);
        for (const [groupKey, groupName] of Object.entries(offline.groupNamesById)) {
          const cachedGroupId = Number(groupKey);
          if (!Number.isNaN(cachedGroupId) && !groupLookup.has(cachedGroupId)) {
            groupLookup.set(cachedGroupId, groupName);
          }
        }

        const passesFilter = (e: Expense): boolean => {
          if (profile.limitExpensesToGroupIds !== undefined && profile.limitExpensesToGroupIds !== null) {
            if (e.groupId === null || !profile.limitExpensesToGroupIds.includes(e.groupId)) return false;
          }
          if (profile.limitExpensesToFriendIds !== undefined && profile.limitExpensesToFriendIds !== null) {
            const participantIds = (e.users ?? []).map((u) => u.userId);
            const hasAllowed = participantIds.some((id) => profile.limitExpensesToFriendIds!.includes(id));
            if (!hasAllowed) return false;
          }
          if (involvedId !== undefined && !e.users?.some((u) => u.userId === involvedId)) return false;
          if (payerId !== undefined && !e.users?.some((u) => u.userId === payerId && Number(u.paidShare) > 0)) return false;
          return true;
        };

        const resolveGroup = (id: number | null) => id != null ? (groupLookup.get(id) ?? String(id)) : '';
        const meIdForTui = credential.userId;
        const rows = offline.expenses.filter(passesFilter);

        const toTableRow = (e: Expense) => {
          const payer = e.users?.find((u) => Number(u.paidShare) > 0);
          let description = e.description;
          if (e.payment) {
            const payee = e.users?.find((u) => u.userId !== payer?.userId && Number(u.owedShare) > 0);
            if (payee) description += ` → ${formatName(payee.user)}`;
          }
          const myEntry = meIdForTui !== undefined
            ? e.users?.find((u) => u.userId === meIdForTui)
            : undefined;
          const myPaid = Number(myEntry?.paidShare ?? 0);
          const myOwes = Number(myEntry?.owedShare ?? 0);
          const net = myPaid - myOwes;
          const share = myEntry ? `${Math.abs(net).toFixed(2)} ${e.currencyCode}` : '';
          return {
            id: e.id,
            date: e.date ? new Date(e.date).toLocaleDateString() : '?',
            group: normalizeDisplayWhitespace(resolveGroup(e.groupId)),
            paidBy: payer ? formatName(payer.user) : '',
            description,
            cost: `${Number(e.cost).toFixed(2)} ${e.currencyCode}`,
            category: e.category?.name ?? '',
            share,
          };
        };

        const toFullRow = (e: Expense) => {
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

        if (rows.length === 0) {
          renderEmptyList(fmt);
          return;
        }

        if (tuiMode && fmt === 'table') {
          renderTuiList(rows.map(toTableRow), {
            intro: `Showing expenses from ${datedAfter ?? 'cache-start'} to ${datedBefore ?? 'cache-end'}`,
            source: getCacheRootPath(target),
            startedAt,
            logger,
          });
          return;
        }

        if (fmt === 'table') {
          render(rows.map(toTableRow), fmt);
        } else {
          render(rows.map(toFullRow), fmt);
        }
        return;
      }

      const sw = getClient(this);

      // ── Resolve dates ─────────────────────────────────────────────────────
      const datedAfter  = opts.from ? parseDate(opts.from) : undefined;
      const datedBefore = opts.to   ? parseDate(opts.to)   : undefined;

      const startedAt = Date.now();

      // ── Fetch lookup data in parallel ─────────────────────────────────────
      const [allGroups, allFriends] = await Promise.all([
        sw.groups.list(),
        sw.friends.list(),
      ]);

      const groupLookup = new Map<number, string>();
      for (const g of allGroups) groupLookup.set(g.id, g.name);

      // ── Lazy current user (fetched at most once) ──────────────────────────
      let meCache: Awaited<ReturnType<typeof sw.users.getCurrent>> | undefined;
      const getMe = async () => {
        if (!meCache) meCache = await sw.users.getCurrent();
        return meCache;
      };

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
          const matches = allGroups.filter((g) => g.name.toLowerCase().includes(needle));
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
          const matches = allFriends.filter((f) =>
            `${f.firstName} ${f.lastName}`.toLowerCase().includes(needle) ||
            (f.firstName ?? '').toLowerCase().includes(needle),
          );
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

      if (tuiMode) {
        const fromLabel = datedAfter ?? 'Splitwise implicit default start';
        const toLabel = datedBefore ?? 'today';
        logger.info(`Showing expenses from ${fromLabel} to ${toLabel}`);
      }

      const progress = createTuiProgress(tuiMode);

      // ── Row builders ──────────────────────────────────────────────────────
      type TableRow = { id: number; date: string; group: string; paidBy: string; description: string; cost: string; category: string; share: string };
      type SplitRow = { userId: number; name: string; paid: string; owes: string };
      type CommentRow = { id: number; content: string; author: string; createdAt: string };
      type FullRow = {
        id: number; date: string; description: string; cost: string; currency: string;
        categoryId?: number; category: string;
        isPayment: boolean;
        notes?: string;
        paidById: number | undefined; paidBy: string; groupId: number | null; group: string;
        splits: SplitRow[];
        createdAt: string; createdById?: number; createdByName: string;
        updatedAt?: string; updatedById?: number; updatedByName: string;
        deletedAt?: string | null; deletedById?: number; deletedByName: string;
        comments?: CommentRow[];
      };

      const resolveGroup = (id: number | null) =>
        id != null ? (groupLookup.get(id) ?? String(id)) : '';

      const toTableRow = (e: Expense): TableRow => {
        const payer = e.users?.find((u) => Number(u.paidShare) > 0);
        let description = e.description;
        if (e.payment) {
          const payee = e.users?.find((u) => u.userId !== payer?.userId && Number(u.owedShare) > 0);
          if (payee) description += ` → ${formatName(payee.user)}`;
        }

        const myEntry = meIdForTui !== undefined
          ? e.users?.find((u) => u.userId === meIdForTui)
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
          group: normalizeDisplayWhitespace(resolveGroup(e.groupId)),
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
          // Comments only present if the API returned them inline in the list response.
          comments: e.comments?.map((c) => ({
            id: c.id,
            content: c.content,
            author: formatName(c.user),
            createdAt: c.createdAt,
          })),
        };
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

      const flushPage = (page: Expense[], remaining = Infinity): number => {
        const filtered = page.filter(passesFilter).slice(0, remaining);
        if (filtered.length === 0) return 0;
        if (fmt === 'table') flushTableRows(filtered.map(toTableRow));
        else flushFullRows(filtered.map(toFullRow));
        return filtered.length;
      };

      const finalize = () => {
        if (fmt === 'json') process.stdout.write(jsonStarted ? '\n]\n' : '[]\n');
        else if (totalPrinted === 0) process.stdout.write(fmt === 'yaml' ? '[]\n' : '(no results)\n');
        if (tuiMode) {
          const elapsed = Date.now() - startedAt;
          logger.info(`• ${totalPrinted} item(s) | ${elapsed} ms | source: Splitwise API`);
        }
      };

      // ── Execute ───────────────────────────────────────────────────────────
      if (opts.all) {
        let pageCount = 0;
        progress.start('Fetching expenses...');
        for await (const page of sw.expenses.list(params).byPage()) {
          progress.stop();
          pageCount++;
          flushPage(page);
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
          emitted += flushPage(page, max - emitted);
          if (emitted >= max) break;
          progress.start(`Fetched ${pageCount} page(s), loading more...`);
        }
        progress.stop();
      } else {
        params.limit = max;
        progress.start('Fetching expenses...');
        const page = await sw.expenses.list(params);
        progress.stop();
        flushPage(page);
      }

      finalize();
    });

  addOutputOption(expenses.command('get <id>'))
    .description('Get details for an expense')
    .action(async function (this: Command, id: string) {
      const logger = createLogger(this, 'expenses');
      const fmt: OutputFormat = getFormat(this);
      const tuiMode = isTuiDefault(this);

      if (resolveOfflineMode(this)) {
        const target = resolveCacheTarget(this);
        const { credential } = resolveCredential(this);
        const cached = findOfflineExpenseById(target, credential.userId, Number(id));
        if (!cached) {
          logger.error(`Expense ${id} was not found in cached data at ${getCacheRootPath(target)}.`);
          process.exit(1);
        }
        const e = cached.expense;
        const comments = cached.comments.map((c) => ({
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
        return;
      }

      const sw = getClient(this);
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
