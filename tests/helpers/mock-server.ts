import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Fixture = {
  current_user: Record<string, unknown>;
  friends: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
  currencies: Array<Record<string, unknown>>;
  expenses: Array<Record<string, unknown>>;
  comments_by_expense: Record<string, Array<Record<string, unknown>>>;
};

type MockServerState = {
  expenses: Array<Record<string, unknown>>;
  nextExpenseId: number;
  writeRequests: Array<{ method: string; path: string; body: Record<string, string> }>;
};

function loadFixture(): Fixture {
  const repoRoot = resolve(join(dirnameFromUrl(import.meta.url), '..', '..'));
  return JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'splitwise-response.json'), 'utf-8')) as Fixture;
}

function dirnameFromUrl(url: string): string {
  return fileURLToPath(new URL('.', url));
}

function parseRequestBody(raw: string): Record<string, string> {
  if (!raw) return {};
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase()), String(value)]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries([...new URLSearchParams(raw).entries()].map(([key, value]) => [key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase()), value]));
}

function cloneExpense(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function sendJson(res: Parameters<ReturnType<typeof createServer>['on']>[1], payload: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendNotFound(res: Parameters<ReturnType<typeof createServer>['on']>[1]): void {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function buildCreatedExpense(state: MockServerState, body: Record<string, string>): Record<string, unknown> {
  const now = new Date().toISOString();
  const expense = {
    id: state.nextExpenseId++,
    groupId: body.groupId !== undefined ? Number(body.groupId) : null,
    friendId: body.friendId !== undefined ? Number(body.friendId) : undefined,
    description: body.description ?? '',
    date: body.date ?? now.slice(0, 10),
    cost: body.cost ?? '0.00',
    currencyCode: body.currencyCode ?? 'USD',
    payment: body.payment === '1' || body.payment === 'true',
    details: body.details,
    category: body.categoryId !== undefined ? { id: Number(body.categoryId), name: '' } : undefined,
    createdAt: now,
    updatedAt: now,
    users: [],
  };
  state.expenses.push(expense);
  return expense;
}

function applyUpdate(target: Record<string, unknown>, body: Record<string, string>): Record<string, unknown> {
  const next = cloneExpense(target);
  if (body.description !== undefined) next.description = body.description;
  if (body.cost !== undefined) next.cost = body.cost;
  if (body.currencyCode !== undefined) next.currencyCode = body.currencyCode;
  if (body.date !== undefined) next.date = body.date;
  if (body.groupId !== undefined) next.groupId = Number(body.groupId);
  if (body.friendId !== undefined) next.friendId = Number(body.friendId);
  if (body.details !== undefined) next.details = body.details;
  next.updatedAt = new Date().toISOString();
  return next;
}

export async function startSplitwiseMockServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  getRequestCount: () => number;
  getWriteRequests: () => Array<{ method: string; path: string; body: Record<string, string> }>;
}> {
  const fixture = loadFixture();
  const state: MockServerState = {
    expenses: fixture.expenses.map((expense) => ({
      ...expense,
    })),
    nextExpenseId: Math.max(...fixture.expenses.map((expense) => Number(expense.id))) + 1,
    writeRequests: [],
  };

  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount += 1;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/^\/api\/v3\.0/, '') || url.pathname;

    const collectBody = async (): Promise<Record<string, string>> => new Promise((resolveBody, rejectBody) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => resolveBody(parseRequestBody(raw))); 
      req.on('error', rejectBody);
    });

    void (async () => {
      const body = await collectBody();

      if (path === '/get_current_user') {
        sendJson(res, { user: fixture.current_user });
        return;
      }

      if (path === '/get_friends') {
        sendJson(res, { friends: fixture.friends });
        return;
      }

      if (path === '/get_groups') {
        sendJson(res, { groups: fixture.groups });
        return;
      }

      const groupDetailMatch = path.match(/^\/get_group\/(\d+)$/);
      if (groupDetailMatch) {
        const groupId = Number(groupDetailMatch[1]);
        const group = fixture.groups.find((item) => Number(item.id) === groupId);
        if (!group) {
          sendNotFound(res);
          return;
        }
        sendJson(res, { group });
        return;
      }

      if (path === '/get_categories') {
        sendJson(res, { categories: fixture.categories });
        return;
      }

      if (path === '/get_currencies') {
        sendJson(res, { currencies: fixture.currencies });
        return;
      }

      if (path === '/get_comments') {
        const expenseId = url.searchParams.get('expense_id') ?? url.searchParams.get('expenseId') ?? '';
        sendJson(res, { comments: fixture.comments_by_expense[expenseId] ?? [] });
        return;
      }

      if (path === '/get_expenses') {
        const limit = Number(url.searchParams.get('limit') ?? state.expenses.length);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const from = url.searchParams.get('from') ?? null;
        const to = url.searchParams.get('to') ?? null;
        const groupId = url.searchParams.get('group_id') ?? url.searchParams.get('groupId');
        const rows = state.expenses.filter((expense) => {
          const date = String(expense.date ?? '');
          if (from !== null && date < from) return false;
          if (to !== null && date > to) return false;
          if (groupId !== null && String(expense.group_id ?? expense.groupId ?? '') !== groupId) return false;
          return true;
        });
        sendJson(res, { expenses: rows.slice(offset, offset + limit) });
        return;
      }

      const expenseDetailMatch = path.match(/^\/get_expense\/(\d+)$/);
      if (expenseDetailMatch) {
        const expenseId = Number(expenseDetailMatch[1]);
        const expense = state.expenses.find((item) => Number(item.id) === expenseId);
        if (!expense) {
          sendNotFound(res);
          return;
        }
        sendJson(res, { expense });
        return;
      }

      if (path === '/create_expense') {
        state.writeRequests.push({ method: 'POST', path, body });
        const expense = buildCreatedExpense(state, body);
        sendJson(res, { expenses: [expense] });
        return;
      }

      const updateMatch = path.match(/^\/update_expense\/(\d+)$/);
      if (updateMatch) {
        state.writeRequests.push({ method: 'POST', path, body });
        const expenseId = Number(updateMatch[1]);
        const existingIndex = state.expenses.findIndex((item) => Number(item.id) === expenseId);
        if (existingIndex < 0) {
          sendNotFound(res);
          return;
        }
        const updated = applyUpdate(state.expenses[existingIndex], body);
        state.expenses[existingIndex] = updated;
        sendJson(res, { expenses: [updated] });
        return;
      }

      const deleteMatch = path.match(/^\/delete_expense\/(\d+)$/);
      if (deleteMatch) {
        state.writeRequests.push({ method: 'POST', path, body });
        const expenseId = Number(deleteMatch[1]);
        const existing = state.expenses.find((item) => Number(item.id) === expenseId);
        if (!existing) {
          sendNotFound(res);
          return;
        }
        existing.deletedAt = new Date().toISOString();
        sendJson(res, { success: true });
        return;
      }

      sendNotFound(res);
    })().catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Failed to start mock Splitwise server');
      let closed = false;
      resolvePromise({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolveClose) => {
          if (closed) {
            resolveClose();
            return;
          }
          closed = true;
          server.close(() => resolveClose());
        }),
        getRequestCount: () => requestCount,
        getWriteRequests: () => [...state.writeRequests],
      });
    });
  });
}