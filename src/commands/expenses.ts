import { Command } from 'commander';
import { dump as yamlDump } from 'js-yaml';
import { type Expense } from 'splitwise';
import { getClient } from '../lib/config.js';
import {
  addOutputOption, getFormat, formatName,
  render, renderOne, renderEmptyList,
  isTuiDefault, colorize, createTuiProgress,
  visualWidth, padStartVisual, padEndVisual,
  type OutputFormat,
} from '../lib/output.js';
import { parseDate } from '../lib/dates.js';

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
      const sw = getClient();
      const fmt = getFormat(this);
      const tuiMode = isTuiDefault(this);

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
          console.warn(`Warning: no user matching "${value}" for ${label} — filter ignored.`);
          return undefined;
        }
        if (unique.length > 1) {
          console.error(
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
          groupId = asNum;
        } else {
          const needle = opts.group.toLowerCase();
          const matches = allGroups.filter((g) => g.name.toLowerCase().includes(needle));
          if (matches.length === 0) {
            console.warn(`Warning: no group matching "${opts.group}" — returning empty list.`);
            renderEmptyList(fmt);
            return;
          }
          if (matches.length > 1) {
            console.error(
              `Ambiguous group "${opts.group}" — matches: ${matches.map((g) => `"${g.name}"`).join(', ')}. Be more specific.`,
            );
            process.exit(1);
          }
          groupId = matches[0].id;
        }
      }

      // ── Resolve friend filter ─────────────────────────────────────────────
      let friendId: number | undefined;

      if (opts.friend !== undefined) {
        const asNum = Number(opts.friend);
        if (!isNaN(asNum) && String(asNum) === opts.friend) {
          friendId = asNum;
        } else {
          const needle = opts.friend.toLowerCase();
          const matches = allFriends.filter((f) =>
            `${f.firstName} ${f.lastName}`.toLowerCase().includes(needle) ||
            (f.firstName ?? '').toLowerCase().includes(needle),
          );
          if (matches.length === 0) {
            console.warn(`Warning: no friend matching "${opts.friend}" — returning empty list.`);
            renderEmptyList(fmt);
            return;
          }
          if (matches.length > 1) {
            console.error(
              `Ambiguous friend "${opts.friend}" — matches: ${matches.map((f) => `"${formatName(f)}"`).join(', ')}. Be more specific.`,
            );
            process.exit(1);
          }
          friendId = matches[0].id;
        }
      }

      // ── Resolve client-side filters ───────────────────────────────────────
      const involvedId = opts.involved !== undefined
        ? await resolveUser('--involved', opts.involved)
        : undefined;

      const payerId = (opts.mine ? '@me' : opts.payer) !== undefined
        ? await resolveUser('--payer', opts.mine ? '@me' : opts.payer!)
        : undefined;

      const hasLocalFilter = involvedId !== undefined || payerId !== undefined;

      const passesFilter = (e: Expense): boolean => {
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
        console.log('');
        console.log(colorize(`Showing expenses from ${fromLabel} to ${toLabel}`, 'cyan'));
      }

      const progress = createTuiProgress(tuiMode);

      // ── Row builders ──────────────────────────────────────────────────────
      type TableRow = { id: number; date: string; group: string; paidBy: string; description: string; cost: string; category: string; status: string };
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

        let status = 'n/a';
        if (myEntry) {
          if (isEffectivelyZero) status = colorize('settled', 'dim');
          else if (net < 0) status = colorize(`debit ${Math.abs(net).toFixed(2)} ${e.currencyCode}`, 'red');
          else status = colorize(`credit ${net.toFixed(2)} ${e.currencyCode}`, 'green');
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
          group: resolveGroup(e.groupId),
          paidBy: payer ? formatName(payer.user) : '',
          description: styledDescription,
          cost,
          category: styledCategory,
          status,
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
        { key: 'group', label: tuiMode ? 'Group' : 'group' },
        { key: 'paidBy', label: tuiMode ? 'Paid By' : 'paidBy' },
        { key: 'description', label: tuiMode ? 'Description' : 'description' },
        { key: 'cost', label: tuiMode ? 'Cost' : 'cost' },
        { key: 'category', label: tuiMode ? 'Category' : 'category' },
        { key: 'status', label: tuiMode ? 'Status' : 'status' },
      ];
      const RIGHT_ALIGN = new Set<keyof TableRow>(['cost']);
      const tableGap = tuiMode ? '   ' : '  ';
      let tableWidths: number[] | null = null;
      let jsonStarted = false;
      let totalPrinted = 0;

      const flushTableRows = (rows: TableRow[]) => {
        if (rows.length === 0) return;
        if (tableWidths === null) {
          if (tuiMode) process.stdout.write('\n');
          tableWidths = TABLE_COLUMNS.map(({ key, label }) =>
            Math.max(visualWidth(label), ...rows.map((r) => visualWidth(String(r[key] ?? '')))),
          );
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
              const cell = String(row[k] ?? '');
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
          console.log(colorize(`\n• ${totalPrinted} item(s) | ${elapsed} ms | source: Splitwise API`, 'dim'));
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
      const sw = getClient();
      const fmt: OutputFormat = getFormat(this);
      const tuiMode = isTuiDefault(this);
      if (tuiMode) console.log(colorize(`Showing expense details for ${id}`, 'cyan'));
      const progress = createTuiProgress(tuiMode);
      progress.start('Fetching expense details...');
      const [e, fetchedComments] = await Promise.all([
        sw.expenses.get({ id: Number(id) }),
        sw.comments.list({ expenseId: Number(id) }),
      ]);
      progress.stop(colorize('Fetched expense details.', 'green'));

      const comments = fetchedComments.map((c) => ({
        id: c.id,
        content: c.content,
        author: formatName(c.user),
        createdAt: c.createdAt,
      }));

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
        );
        if (e.users && e.users.length > 0) {
          console.log('\nShares:');
          console.table(
            e.users.map((u) => ({
              name: formatName(u.user),
              paid: u.paidShare,
              owes: u.owedShare,
            })),
          );
        }
        if (comments.length > 0) {
          console.log('\nComments:');
          console.table(comments);
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
