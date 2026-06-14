import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Category, Comment, Currency, Expense, Friend, Group } from 'splitwise';
import type { CacheTarget } from './config.js';
import { ensureCacheRoot, getCacheManifestPath, getCacheRootPath } from './config.js';

export type CacheEntity = 'expenses' | 'comments' | 'friends' | 'groups' | 'categories' | 'currencies' | 'lookup' | 'all';

export type CacheScope = {
  from?: string;
  to?: string;
  groupId?: number;
  friendId?: number;
  updatedAfter?: string;
  updatedBefore?: string;
  refreshOfBatchId?: string;
};

export interface CacheCoverage {
  expenseDateMin?: string;
  expenseDateMax?: string;
  createdAtMin?: string;
  createdAtMax?: string;
  updatedAtMin?: string;
  updatedAtMax?: string;
}

export interface CacheManifestEntry {
  schemaVersion: number;
  batchId: string;
  entity: Exclude<CacheEntity, 'all'>;
  target: CacheTarget;
  profileName: string;
  credentialName?: string;
  accountUserId?: number;
  accountUserName?: string;
  exportedAt: string;
  machine: {
    host: string;
    platform: NodeJS.Platform;
  };
  rowCount?: number;
  scope?: CacheScope;
  coverage?: CacheCoverage;
  request?: {
    method?: string;
    url?: string;
  };
  payloadPath: string;
}

export interface CacheManifest {
  schemaVersion: number;
  entries: CacheManifestEntry[];
}

export interface ExpensesCachePayload {
  entity: 'expenses';
  items: Expense[];
}

export interface CommentsCachePayload {
  entity: 'comments';
  items: Record<string, Comment[]>;
}

export interface FriendsCachePayload {
  entity: 'friends';
  items: Friend[];
}

export interface GroupsCachePayload {
  entity: 'groups';
  items: Group[];
}

export interface CategoriesCachePayload {
  entity: 'categories';
  items: Category[];
}

export interface CurrenciesCachePayload {
  entity: 'currencies';
  items: Currency[];
}

export type CachePayload = ExpensesCachePayload | CommentsCachePayload | FriendsCachePayload | GroupsCachePayload | CategoriesCachePayload | CurrenciesCachePayload;

export interface OfflineExpenseRequest {
  from?: string;
  to?: string;
  groupId?: number;
  friendId?: number;
}

export interface OfflineExpenseResult {
  expenses: Expense[];
  commentsByExpense: Record<string, Comment[]>;
  groupNamesById: Record<string, string>;
  warnings: string[];
  sourceEntries: CacheManifestEntry[];
}

const CACHE_SCHEMA_VERSION = 1;
const CROCKFORD32 = '0123456789abcdefghjkmnpqrstvwxyz';

export function emptyCacheManifest(): CacheManifest {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    entries: [],
  };
}

export function generateBatchId(now = Date.now()): string {
  let value = now;
  let timePart = '';
  for (let index = 0; index < 10; index++) {
    timePart = CROCKFORD32[value % 32] + timePart;
    value = Math.floor(value / 32);
  }

  let randomPart = '';
  for (let index = 0; index < 16; index++) {
    randomPart += CROCKFORD32[Math.floor(Math.random() * CROCKFORD32.length)];
  }

  return `${timePart}${randomPart}`;
}

export function loadCacheManifest(target: CacheTarget): CacheManifest {
  const path = getCacheManifestPath(target);
  if (!existsSync(path)) return emptyCacheManifest();
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as CacheManifest;
  if (!Array.isArray(parsed.entries)) return emptyCacheManifest();
  return {
    schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : CACHE_SCHEMA_VERSION,
    entries: parsed.entries,
  };
}

export function saveCacheManifest(target: CacheTarget, manifest: CacheManifest): void {
  ensureCacheRoot(target);
  const path = getCacheManifestPath(target);
  writeFileSync(path, JSON.stringify(manifest, null, 2), { mode: 0o600 });
}

export function ensureCacheManifest(target: CacheTarget): CacheManifest {
  ensureCacheRoot(target);
  const manifest = loadCacheManifest(target);
  if (!existsSync(getCacheManifestPath(target))) {
    saveCacheManifest(target, manifest);
  }
  return manifest;
}

export function getCacheBatchesDir(target: CacheTarget): string {
  const root = ensureCacheRoot(target);
  const path = join(root, 'batches');
  mkdirSync(path, { recursive: true });
  return path;
}

function getBatchDir(target: CacheTarget, batchId: string): string {
  const path = join(getCacheBatchesDir(target), batchId);
  mkdirSync(path, { recursive: true });
  return path;
}

function stableStringifyScope(scope: CacheScope | undefined): string {
  if (!scope) return '{}';
  const keys = Object.keys(scope).sort() as Array<keyof CacheScope>;
  return JSON.stringify(keys.reduce<Record<string, unknown>>((acc, key) => {
    const value = scope[key];
    if (value !== undefined) acc[key] = value;
    return acc;
  }, {}));
}

export function summarizeScope(scope: Record<string, unknown> | undefined): string {
  if (!scope) return '';
  const parts = Object.entries(scope)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.join(', ');
}

function normalizeIsoDateOnly(input: string | undefined): string | undefined {
  if (!input) return undefined;
  return input.slice(0, 10);
}

function dateToOrdinal(input: string | undefined): number | null {
  const normalized = normalizeIsoDateOnly(input);
  if (!normalized) return null;
  const parsed = Date.parse(`${normalized}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

function sortEntriesNewestFirst(entries: CacheManifestEntry[]): CacheManifestEntry[] {
  return [...entries].sort((left, right) => right.exportedAt.localeCompare(left.exportedAt));
}

export function buildCacheCoverage(payload: CachePayload): CacheCoverage {
  if (payload.entity === 'expenses') {
    const expenseDates = payload.items.map((item) => item.date).filter(Boolean).sort();
    const createdDates = payload.items.map((item) => item.createdAt).filter(Boolean).sort();
    const updatedDates = payload.items.map((item) => item.updatedAt).filter(Boolean).sort();
    return {
      expenseDateMin: expenseDates[0],
      expenseDateMax: expenseDates[expenseDates.length - 1],
      createdAtMin: createdDates[0],
      createdAtMax: createdDates[createdDates.length - 1],
      updatedAtMin: updatedDates[0],
      updatedAtMax: updatedDates[updatedDates.length - 1],
    };
  }

  if (payload.entity === 'groups') {
    const createdDates = payload.items.map((item) => item.createdAt).filter(Boolean).sort();
    const updatedDates = payload.items.map((item) => item.updatedAt).filter(Boolean).sort();
    return {
      createdAtMin: createdDates[0],
      createdAtMax: createdDates[createdDates.length - 1],
      updatedAtMin: updatedDates[0],
      updatedAtMax: updatedDates[updatedDates.length - 1],
    };
  }

  if (payload.entity === 'friends') {
    const updatedDates = payload.items.map((item) => item.updatedAt).filter(Boolean).sort();
    return {
      updatedAtMin: updatedDates[0],
      updatedAtMax: updatedDates[updatedDates.length - 1],
    };
  }

  return {};
}

export function cacheRowCount(payload: CachePayload): number {
  if (payload.entity === 'comments') {
    return Object.values(payload.items).reduce((sum, comments) => sum + comments.length, 0);
  }
  return payload.items.length;
}

export function writeCachePayload(target: CacheTarget, batchId: string, payload: CachePayload): string {
  const batchDir = getBatchDir(target, batchId);
  const fileName = `${payload.entity}.json`;
  const absolutePath = join(batchDir, fileName);
  writeFileSync(absolutePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return join('batches', batchId, fileName).replace(/\\/g, '/');
}

export function appendCacheEntry(target: CacheTarget, entry: CacheManifestEntry): void {
  const manifest = ensureCacheManifest(target);
  manifest.entries.push(entry);
  saveCacheManifest(target, manifest);
}

export function createCacheEntry(input: {
  batchId: string;
  entity: Exclude<CacheEntity, 'all'>;
  target: CacheTarget;
  profileName: string;
  credentialName?: string;
  accountUserId?: number;
  accountUserName?: string;
  exportedAt: string;
  scope?: CacheScope;
  request?: {
    method?: string;
    url?: string;
  };
  payloadPath: string;
  payload: CachePayload;
}): CacheManifestEntry {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    batchId: input.batchId,
    entity: input.entity,
    target: input.target,
    profileName: input.profileName,
    credentialName: input.credentialName,
    accountUserId: input.accountUserId,
    accountUserName: input.accountUserName,
    exportedAt: input.exportedAt,
    machine: {
      host: hostname(),
      platform: process.platform,
    },
    rowCount: cacheRowCount(input.payload),
    scope: input.scope,
    coverage: buildCacheCoverage(input.payload),
    request: input.request,
    payloadPath: input.payloadPath,
  };
}

export function loadCachePayload<T extends CachePayload>(target: CacheTarget, entry: CacheManifestEntry): T {
  const absolutePath = join(getCacheRootPath(target), entry.payloadPath);
  return JSON.parse(readFileSync(absolutePath, 'utf-8')) as T;
}

export function findEquivalentCacheEntry(target: CacheTarget, probe: {
  entity: Exclude<CacheEntity, 'all'>;
  accountUserId?: number;
  profileName: string;
  scope?: CacheScope;
}): CacheManifestEntry | undefined {
  const manifest = loadCacheManifest(target);
  const targetScope = stableStringifyScope(probe.scope);
  return sortEntriesNewestFirst(manifest.entries).find((entry) =>
    entry.entity === probe.entity
    && entry.accountUserId === probe.accountUserId
    && entry.profileName === probe.profileName
    && stableStringifyScope(entry.scope) === targetScope,
  );
}

export function listCacheEntries(target: CacheTarget, entity?: Exclude<CacheEntity, 'all'>): CacheManifestEntry[] {
  const manifest = loadCacheManifest(target);
  const entries = entity ? manifest.entries.filter((entry) => entry.entity === entity) : manifest.entries;
  return sortEntriesNewestFirst(entries);
}

function expenseScopeCompatible(entry: CacheManifestEntry, request: OfflineExpenseRequest): boolean {
  const scope = entry.scope;
  const entryGroupId = scope?.groupId;
  const entryFriendId = scope?.friendId;

  if (request.groupId !== undefined) {
    if (entryGroupId !== undefined && entryGroupId !== request.groupId) return false;
  } else if (entryGroupId !== undefined) {
    return false;
  }

  if (request.friendId !== undefined) {
    if (entryFriendId !== undefined && entryFriendId !== request.friendId) return false;
  } else if (entryFriendId !== undefined) {
    return false;
  }

  return true;
}

function expenseMatchesRequest(expense: Expense, request: OfflineExpenseRequest): boolean {
  const expenseDate = normalizeIsoDateOnly(expense.date);
  const from = normalizeIsoDateOnly(request.from);
  const to = normalizeIsoDateOnly(request.to);
  if (from && expenseDate && expenseDate < from) return false;
  if (to && expenseDate && expenseDate > to) return false;
  if (request.groupId !== undefined && expense.groupId !== request.groupId) return false;
  if (request.friendId !== undefined) {
    const participants = expense.users?.map((user) => user.userId) ?? [];
    if (!participants.includes(request.friendId)) return false;
  }
  return true;
}

function requestMatchesEntryScope(entry: CacheManifestEntry, request: OfflineExpenseRequest): boolean {
  return entry.scope?.from === request.from
    && entry.scope?.to === request.to
    && entry.scope?.groupId === request.groupId
    && entry.scope?.friendId === request.friendId;
}

function describeGap(fromOrdinal: number, toOrdinal: number): string {
  const from = new Date(fromOrdinal).toISOString().slice(0, 10);
  const to = new Date(toOrdinal).toISOString().slice(0, 10);
  return `${from} to ${to}`;
}

export function uncoveredExpenseRanges(entries: CacheManifestEntry[], request: OfflineExpenseRequest): string[] {
  const requestedFrom = dateToOrdinal(request.from);
  const requestedTo = dateToOrdinal(request.to);
  if (requestedFrom === null || requestedTo === null || requestedFrom > requestedTo) return [];

  const ranges = entries
    .map((entry) => ({
      start: dateToOrdinal(entry.coverage?.expenseDateMin),
      end: dateToOrdinal(entry.coverage?.expenseDateMax),
    }))
    .filter((range): range is { start: number; end: number } => range.start !== null && range.end !== null)
    .map((range) => ({
      start: Math.max(range.start, requestedFrom),
      end: Math.min(range.end, requestedTo),
    }))
    .filter((range) => range.start <= range.end)
    .sort((left, right) => left.start - right.start);

  if (ranges.length === 0) return [describeGap(requestedFrom, requestedTo)];

  const gaps: string[] = [];
  let cursor = requestedFrom;
  for (const range of ranges) {
    if (range.start > cursor) {
      gaps.push(describeGap(cursor, range.start - 86400000));
    }
    cursor = Math.max(cursor, range.end + 86400000);
    if (cursor > requestedTo) return gaps;
  }

  if (cursor <= requestedTo) {
    gaps.push(describeGap(cursor, requestedTo));
  }

  return gaps;
}

export function resolveOfflineExpenses(
  target: CacheTarget,
  accountUserId: number | undefined,
  request: OfflineExpenseRequest,
  profileName?: string,
): OfflineExpenseResult {
  const groupNamesById = loadLatestGroups(target, accountUserId, profileName)
    .reduce<Record<string, string>>((acc, group) => {
      acc[String(group.id)] = group.name;
      return acc;
    }, {});

  const commentsByExpense = loadLatestComments(target, accountUserId, profileName);
  const compatibleEntries = listCacheEntries(target, 'expenses')
    .filter((entry) => entry.accountUserId === accountUserId)
    .filter((entry) => expenseScopeCompatible(entry, request));

  const expensesById = new Map<number, Expense>();
  const sourceEntries: CacheManifestEntry[] = [];

  for (const entry of compatibleEntries) {
    const payload = loadCachePayload<ExpensesCachePayload>(target, entry);
    const filtered = requestMatchesEntryScope(entry, request)
      ? payload.items
      : payload.items.filter((expense) => expenseMatchesRequest(expense, request));
    if (filtered.length === 0) continue;
    sourceEntries.push(entry);
    for (const expense of filtered) {
      if (!expensesById.has(expense.id)) {
        expensesById.set(expense.id, expense);
      }
    }
  }

  const expenses = [...expensesById.values()].sort((left, right) => right.date.localeCompare(left.date));
  const warnings = uncoveredExpenseRanges(sourceEntries, request)
    .map((range) => `Offline cache does not fully cover ${range}. Returning partial results.`);

  const unresolvedGroupCount = expenses
    .filter((expense) => expense.groupId !== null)
    .filter((expense) => expense.groupId !== null && !(String(expense.groupId) in groupNamesById))
    .length;

  if (unresolvedGroupCount > 0) {
    warnings.push(`Offline cache could not resolve ${unresolvedGroupCount} group names. Cache may be stale; export groups to refresh names.`);
  }

  return { expenses, commentsByExpense, groupNamesById, warnings, sourceEntries };
}

export function findLatestCacheEntry(target: CacheTarget, probe: {
  entity: Exclude<CacheEntity, 'all'>;
  accountUserId?: number;
  profileName?: string;
}): CacheManifestEntry | undefined {
  return listCacheEntries(target, probe.entity).find((entry) => {
    if (probe.accountUserId !== undefined && entry.accountUserId !== probe.accountUserId) return false;
    if (probe.profileName !== undefined && entry.profileName !== probe.profileName) return false;
    return true;
  });
}

export function loadLatestGroups(target: CacheTarget, accountUserId: number | undefined, profileName?: string): Group[] {
  const entry = findLatestCacheEntry(target, { entity: 'groups', accountUserId, profileName });
  if (!entry) return [];
  return loadCachePayload<GroupsCachePayload>(target, entry).items;
}

export function loadLatestFriends(target: CacheTarget, accountUserId: number | undefined, profileName?: string): Friend[] {
  const entry = findLatestCacheEntry(target, { entity: 'friends', accountUserId, profileName });
  if (!entry) return [];
  return loadCachePayload<FriendsCachePayload>(target, entry).items;
}

export function loadLatestLookup(
  target: CacheTarget,
  accountUserId: number | undefined,
  profileName?: string,
): { categories: Category[]; currencies: Currency[] } | null {
  const categories = loadLatestCategories(target, accountUserId, profileName);
  const currencies = loadLatestCurrencies(target, accountUserId, profileName);
  if (categories.length === 0 && currencies.length === 0) return null;
  return { categories, currencies };
}

export function loadLatestCategories(target: CacheTarget, accountUserId: number | undefined, profileName?: string): Category[] {
  const exact = findLatestCacheEntry(target, { entity: 'categories', accountUserId, profileName });
  if (exact) return loadCachePayload<CategoriesCachePayload>(target, exact).items;
  const fallback = listCacheEntries(target, 'categories')[0];
  if (!fallback) return [];
  return loadCachePayload<CategoriesCachePayload>(target, fallback).items;
}

export function loadLatestCurrencies(target: CacheTarget, accountUserId: number | undefined, profileName?: string): Currency[] {
  const exact = findLatestCacheEntry(target, { entity: 'currencies', accountUserId, profileName });
  if (exact) return loadCachePayload<CurrenciesCachePayload>(target, exact).items;
  const fallback = listCacheEntries(target, 'currencies')[0];
  if (!fallback) return [];
  return loadCachePayload<CurrenciesCachePayload>(target, fallback).items;
}

export function loadLatestComments(target: CacheTarget, accountUserId: number | undefined, profileName?: string): Record<string, Comment[]> {
  const entry = findLatestCacheEntry(target, { entity: 'comments', accountUserId, profileName });
  if (!entry) return {};
  return loadCachePayload<CommentsCachePayload>(target, entry).items;
}

export function findOfflineExpenseById(target: CacheTarget, accountUserId: number | undefined, expenseId: number): {
  expense: Expense;
  comments: Comment[];
  entry: CacheManifestEntry;
} | null {
  const commentsByExpense = loadLatestComments(target, accountUserId);
  const entries = listCacheEntries(target, 'expenses').filter((entry) => entry.accountUserId === accountUserId);
  for (const entry of entries) {
    const payload = loadCachePayload<ExpensesCachePayload>(target, entry);
    const expense = payload.items.find((item) => item.id === expenseId);
    if (expense) {
      return {
        expense,
        comments: commentsByExpense[String(expenseId)] ?? [],
        entry,
      };
    }
  }
  return null;
}