import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
  refreshOfBatchId?: string;
  refreshStrategy?: 'full' | 'dual-cursor' | 'updated-only' | 'created-only' | 'bounded-fallback';
  refreshFallbackDays?: number;
};

export type ExpenseRefreshPlan = {
  scope: CacheScope;
  strategy: NonNullable<CacheScope['refreshStrategy']>;
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
  compatibleEntryCount: number;
}

const CACHE_SCHEMA_VERSION = 1;
const CROCKFORD32 = '0123456789abcdefghjkmnpqrstvwxyz';
const STAGED_BATCH_MARKER = '.tmp.';

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

export function createStagedBatchId(batchId: string): string {
  return `${batchId}${STAGED_BATCH_MARKER}${generateBatchId().slice(-6)}`;
}

export function isStagedBatchId(batchId: string): boolean {
  return batchId.includes(STAGED_BATCH_MARKER);
}

function writeFileAtomic(path: string, content: string): void {
  const tempPath = `${path}.tmp.${generateBatchId()}`;
  writeFileSync(tempPath, content, { mode: 0o600 });
  try {
    renameSync(tempPath, path);
  } catch {
    if (existsSync(path)) {
      unlinkSync(path);
    }
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
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
  writeFileAtomic(path, JSON.stringify(manifest, null, 2));
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
  const path = join(root, 'cache');
  mkdirSync(path, { recursive: true });
  return path;
}

function getBatchDir(target: CacheTarget, batchId: string): string {
  const path = join(getCacheBatchesDir(target), batchId);
  mkdirSync(path, { recursive: true });
  return path;
}

export function cleanupStagedBatches(target: CacheTarget): string[] {
  const batchesDir = getCacheBatchesDir(target);
  const removed: string[] = [];
  for (const entry of readdirSync(batchesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isStagedBatchId(entry.name)) continue;
    const stagedPath = join(batchesDir, entry.name);
    rmSync(stagedPath, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

export function finalizeStagedBatch(target: CacheTarget, stagedBatchId: string, finalBatchId: string): void {
  if (!isStagedBatchId(stagedBatchId)) {
    throw new Error(`Batch ${stagedBatchId} is not a staged batch id.`);
  }
  if (isStagedBatchId(finalBatchId)) {
    throw new Error(`Final batch id ${finalBatchId} must not be staged.`);
  }

  const batchesDir = getCacheBatchesDir(target);
  const stagedPath = join(batchesDir, stagedBatchId);
  const finalPath = join(batchesDir, finalBatchId);

  if (!existsSync(stagedPath)) {
    throw new Error(`Staged cache batch ${stagedBatchId} does not exist.`);
  }
  if (existsSync(finalPath)) {
    throw new Error(`Final cache batch ${finalBatchId} already exists.`);
  }

  renameSync(stagedPath, finalPath);
}

export function removeBatch(target: CacheTarget, batchId: string): void {
  const path = join(getCacheBatchesDir(target), batchId);
  rmSync(path, { recursive: true, force: true });
}

export function removeCacheRoot(target: CacheTarget): void {
  rmSync(getCacheRootPath(target), { recursive: true, force: true });
}

export function cachePayloadPath(batchId: string, payload: CachePayload): string {
  const fileName = `${payload.entity}.json`;
  return join('cache', batchId, fileName).replace(/\\/g, '/');
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
  return cachePayloadPath(batchId, payload);
}

export function appendCacheEntry(target: CacheTarget, entry: CacheManifestEntry): void {
  appendCacheEntries(target, [entry]);
}

export function appendCacheEntries(target: CacheTarget, entries: CacheManifestEntry[]): void {
  if (entries.length === 0) return;
  const manifest = ensureCacheManifest(target);
  manifest.entries.push(...entries);
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

export function saveLookupEntitySnapshot(input: {
  target: CacheTarget;
  entity: 'friends' | 'groups';
  profileName: string;
  credentialName?: string;
  accountUserId?: number;
  accountUserName?: string;
  items: Friend[] | Group[];
}): CacheManifestEntry {
  const batchId = generateBatchId();
  const payload = input.entity === 'friends'
    ? { entity: 'friends' as const, items: input.items as Friend[] }
    : { entity: 'groups' as const, items: input.items as Group[] };
  const payloadPath = writeCachePayload(input.target, batchId, payload);
  const entry = createCacheEntry({
    batchId,
    entity: input.entity,
    target: input.target,
    profileName: input.profileName,
    credentialName: input.credentialName,
    accountUserId: input.accountUserId,
    accountUserName: input.accountUserName,
    exportedAt: new Date().toISOString(),
    request: {
      method: 'GET',
      url: input.entity === 'friends' ? '/get_friends' : '/get_groups',
    },
    payloadPath,
    payload,
  });
  appendCacheEntries(input.target, [entry]);
  return entry;
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

type ExpenseCandidate = {
  expense: Expense;
  entry: CacheManifestEntry;
};

function compareExpenseCandidates(left: ExpenseCandidate, right: ExpenseCandidate): number {
  const leftMutationTime = left.expense.updatedAt ?? left.expense.createdAt ?? '';
  const rightMutationTime = right.expense.updatedAt ?? right.expense.createdAt ?? '';
  const mutationCompare = rightMutationTime.localeCompare(leftMutationTime);
  if (mutationCompare !== 0) return mutationCompare;

  const leftCreatedTime = left.expense.createdAt ?? '';
  const rightCreatedTime = right.expense.createdAt ?? '';
  const createdCompare = rightCreatedTime.localeCompare(leftCreatedTime);
  if (createdCompare !== 0) return createdCompare;

  const exportCompare = right.entry.exportedAt.localeCompare(left.entry.exportedAt);
  if (exportCompare !== 0) return exportCompare;

  return left.entry.batchId.localeCompare(right.entry.batchId);
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

  const expensesById = new Map<number, ExpenseCandidate>();
  const sourceEntries: CacheManifestEntry[] = [];

  for (const entry of compatibleEntries) {
    const payload = loadCachePayload<ExpensesCachePayload>(target, entry);
    const filtered = requestMatchesEntryScope(entry, request)
      ? payload.items
      : payload.items.filter((expense) => expenseMatchesRequest(expense, request));
    if (filtered.length === 0) continue;
    sourceEntries.push(entry);
    for (const expense of filtered) {
      const nextCandidate: ExpenseCandidate = { expense, entry };
      const currentCandidate = expensesById.get(expense.id);
      if (!currentCandidate || compareExpenseCandidates(nextCandidate, currentCandidate) < 0) {
        expensesById.set(expense.id, nextCandidate);
      }
    }
  }

  const expenses = [...expensesById.values()]
    .map((candidate) => candidate.expense)
    .sort((left, right) => right.date.localeCompare(left.date));
  const warnings = uncoveredExpenseRanges(compatibleEntries, request)
    .map((range) => `Offline cache does not fully cover ${range}. Returning partial results.`);

  const unresolvedGroupCount = expenses
    .filter((expense) => expense.groupId !== null)
    .filter((expense) => expense.groupId !== null && !(String(expense.groupId) in groupNamesById))
    .length;

  if (unresolvedGroupCount > 0) {
    warnings.push(`Offline cache could not resolve ${unresolvedGroupCount} group names. Cache may be stale; export groups to refresh names.`);
  }

  return { expenses, commentsByExpense, groupNamesById, warnings, sourceEntries, compatibleEntryCount: compatibleEntries.length };
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

function shiftIsoDate(input: string, deltaDays: number): string {
  const parsed = Date.parse(`${input}T00:00:00Z`);
  return new Date(parsed + deltaDays * 86400000).toISOString().slice(0, 10);
}

export function classifyEntryCoverage(entry: CacheManifestEntry): 'full' | 'partial' | 'unknown' {
  if (entry.entity !== 'expenses') return 'unknown';
  const scopeFrom = entry.scope?.from;
  const scopeTo = entry.scope?.to;
  if (scopeFrom && scopeTo) return 'full';
  const coverageFrom = entry.coverage?.expenseDateMin?.slice(0, 10);
  const coverageTo = entry.coverage?.expenseDateMax?.slice(0, 10);
  if (!coverageFrom || !coverageTo) return 'unknown';
  return 'partial';
}

export function deriveExpenseRefreshPlan(input: {
  latestEntry?: CacheManifestEntry;
  baseScope: CacheScope;
  fallbackWindowDays?: number;
}): ExpenseRefreshPlan {
  const fallbackWindowDays = input.fallbackWindowDays ?? 14;
  const latestEntry = input.latestEntry;
  if (!latestEntry) {
    return {
      strategy: 'full',
      scope: { ...input.baseScope, refreshStrategy: 'full' },
    };
  }

  const createdAfter = latestEntry.coverage?.createdAtMax;
  const updatedAfter = latestEntry.coverage?.updatedAtMax;

  if (createdAfter && updatedAfter) {
    return {
      strategy: 'dual-cursor',
      scope: {
        ...input.baseScope,
        refreshOfBatchId: latestEntry.batchId,
        createdAfter,
        updatedAfter,
        refreshStrategy: 'dual-cursor',
      },
    };
  }

  if (updatedAfter) {
    return {
      strategy: 'updated-only',
      scope: {
        ...input.baseScope,
        refreshOfBatchId: latestEntry.batchId,
        updatedAfter,
        refreshStrategy: 'updated-only',
      },
    };
  }

  if (createdAfter) {
    return {
      strategy: 'created-only',
      scope: {
        ...input.baseScope,
        refreshOfBatchId: latestEntry.batchId,
        createdAfter,
        refreshStrategy: 'created-only',
      },
    };
  }

  const fallbackAnchor = latestEntry.coverage?.expenseDateMax?.slice(0, 10)
    ?? latestEntry.scope?.to
    ?? latestEntry.exportedAt.slice(0, 10);
  const boundedFrom = input.baseScope.from
    ? (shiftIsoDate(fallbackAnchor, -fallbackWindowDays) > input.baseScope.from
      ? shiftIsoDate(fallbackAnchor, -fallbackWindowDays)
      : input.baseScope.from)
    : shiftIsoDate(fallbackAnchor, -fallbackWindowDays);

  return {
    strategy: 'bounded-fallback',
    scope: {
      ...input.baseScope,
      from: boundedFrom,
      refreshOfBatchId: latestEntry.batchId,
      refreshStrategy: 'bounded-fallback',
      refreshFallbackDays: fallbackWindowDays,
    },
  };
}