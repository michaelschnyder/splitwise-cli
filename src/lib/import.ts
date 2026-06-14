import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { Expense, ExpenseCreateParams } from 'splitwise';

export type ImportExpenseRecord = Record<string, unknown>;

export type ImportContext = {
  groups: Array<{ id: number; name: string }>;
  friends: Array<{ id: number; firstName?: string; lastName?: string }>;
  meId: number;
  lookupMap: Map<string, number | undefined>;
};

// ─────────────────────────────────────────────────────────────────────────────
// File parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseYamlFile(path: string): unknown[] {
  const content = readFileSync(path, 'utf-8');
  const parsed = parseYaml(content);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseJsonFile(path: string): unknown[] {
  const content = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function parseImportFile(filePath: string): ImportExpenseRecord[] {
  const ext = extname(filePath).toLowerCase();
  try {
    if (ext === '.yaml' || ext === '.yml') {
      const rows = parseYamlFile(filePath);
      return rows.map((row) => (typeof row === 'object' && row !== null ? (row as ImportExpenseRecord) : {}));
    }
    if (ext === '.json') {
      const rows = parseJsonFile(filePath);
      return rows.map((row) => (typeof row === 'object' && row !== null ? (row as ImportExpenseRecord) : {}));
    }
    // Try JSON first, then YAML as fallback
    try {
      return parseJsonFile(filePath).map((row) => (typeof row === 'object' && row !== null ? (row as ImportExpenseRecord) : {}));
    } catch {
      return parseYamlFile(filePath).map((row) => (typeof row === 'object' && row !== null ? (row as ImportExpenseRecord) : {}));
    }
  } catch (error) {
    throw new Error(`Failed to parse import file "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema detection
// ─────────────────────────────────────────────────────────────────────────────

export function detectShape(record: ImportExpenseRecord): 'full' | 'simplified' {
  const splits = record.splits;
  if (Array.isArray(splits)) {
    for (const item of splits) {
      if (typeof item === 'object' && item !== null && 'userId' in item) {
        return 'full';
      }
    }
  }
  return 'simplified';
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalization: record → ExpenseCreateParams
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeToCreateParams(
  record: ImportExpenseRecord,
  context: ImportContext,
): ExpenseCreateParams | null {
  const description = String(record.description ?? '').trim();
  const cost = String(record.cost ?? '').trim();

  if (!description || !cost) {
    return null;
  }

  // Build lookup map on each call (or reuse if already built)
  if (context.lookupMap.size === 0) {
    buildLookupMap(context);
  }

  const shape = detectShape(record);
  const params: ExpenseCreateParams = {
    description,
    cost,
  };

  // Resolve optional fields
  if (record.date !== undefined) params.date = String(record.date);
  if (record.currency !== undefined) params.currencyCode = String(record.currency);
  if (record.currencyCode !== undefined) params.currencyCode = String(record.currencyCode);
  if (record.notes !== undefined) params.details = String(record.notes);
  if (record.details !== undefined) params.details = String(record.details);
  if (record.category !== undefined) params.categoryId = Number(record.category);
  if (record.categoryId !== undefined) params.categoryId = Number(record.categoryId);
  if (record.payment !== undefined) params.payment = Boolean(record.payment);

  // Resolve group/friend
  if (shape === 'simplified') {
    if (record.group !== undefined) {
      const groupKey = `group:${String(record.group).toLowerCase()}`;
      const groupId = context.lookupMap.get(groupKey);
      if (groupId !== undefined) params.groupId = groupId;
    }
    if (record.friend !== undefined) {
      const friendKey = `friend:${String(record.friend).toLowerCase()}`;
      const friendId = context.lookupMap.get(friendKey);
      if (friendId !== undefined) params.friendId = friendId;
    }
  }

  // Resolve users/splits from full shape
  if (shape === 'full' && Array.isArray(record.splits)) {
    params.users = (record.splits as Array<Record<string, unknown>>)
      .filter((item) => typeof item === 'object' && item !== null)
      .map((item) => ({
        userId: Number(item.userId ?? item.user_id ?? 0),
        ...(item.paidShare !== undefined && { paidShare: String(item.paidShare ?? item.paid_share ?? '') }),
        ...(item.paid_share !== undefined && !('paidShare' in item) && { paidShare: String(item.paid_share ?? '') }),
        ...(item.owedShare !== undefined && { owedShare: String(item.owedShare ?? item.owed_share ?? '') }),
        ...(item.owed_share !== undefined && !('owedShare' in item) && { owedShare: String(item.owed_share ?? '') }),
      }));
  }

  return params;
}

function buildLookupMap(context: ImportContext): void {
  for (const group of context.groups) {
    context.lookupMap.set(`group:${group.name.toLowerCase()}`, group.id);
  }

  for (const friend of context.friends) {
    const fullName = [friend.firstName, friend.lastName].filter(Boolean).join(' ').toLowerCase();
    if (fullName) {
      context.lookupMap.set(`friend:${fullName}`, friend.id);
    }
    if (friend.firstName) {
      context.lookupMap.set(`friend:${friend.firstName.toLowerCase()}`, friend.id);
    }
  }

  context.lookupMap.set('user:@me', context.meId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exact duplicate matcher
// ─────────────────────────────────────────────────────────────────────────────

export function exactMatch(
  candidate: ExpenseCreateParams,
  existing: Expense,
  meId: number,
): boolean {
  // Must have been created or updated by the current user
  if (!existing.createdBy && !existing.updatedBy) return false;
  const createdByMe = existing.createdBy?.id === meId;
  const updatedByMe = existing.updatedBy?.id === meId;
  if (!createdByMe && !updatedByMe) return false;

  // Exact match on core fields
  if (candidate.description !== existing.description) return false;
  if (candidate.cost !== existing.cost) return false;
  if ((candidate.currencyCode ?? 'USD') !== (existing.currencyCode ?? 'USD')) return false;

  // Exact match on date
  if (candidate.date && existing.date && candidate.date !== existing.date) return false;

  // Exact match on distribution (if both specify users and existing has actual users)
  if (candidate.users && existing.users && existing.users.length > 0) {
    const candidateSorted = [...candidate.users]
      .sort((a, b) => a.userId - b.userId)
      .map((u) => `${u.userId}:${u.paidShare ?? '0'}:${u.owedShare ?? '0'}`)
      .join('|');
    const existingSorted = [...(existing.users ?? [])]
      .sort((a, b) => a.userId - b.userId)
      .map((u) => `${u.userId}:${u.paidShare ?? '0'}:${u.owedShare ?? '0'}`)
      .join('|');
    if (candidateSorted !== existingSorted) return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intelligent duplicate matcher with fuzzy matching
// ─────────────────────────────────────────────────────────────────────────────

// Top-row digit key adjacency on a standard QWERTY keyboard.
// Each digit is adjacent to its immediate left and right neighbours.
// Numpad layout (7-8-9 / 4-5-6 / 1-2-3 / 0) adds vertical neighbours.
export const KEYBOARD_ADJACENT: Record<string, string[]> = {
  '0': ['1', '9'],        // top-row wrap; numpad 0 is wide key, closest numpad: 1,2,3
  '1': ['0', '2', '4'],   // top-row; numpad 1 below 4
  '2': ['1', '3', '5'],   // top-row; numpad 2 below 5
  '3': ['2', '4', '6'],   // top-row; numpad 3 below 6
  '4': ['3', '5', '1', '7'], // numpad 4: left of 5, above 1, below 7
  '5': ['4', '6', '2', '8'], // numpad 5: centre
  '6': ['5', '7', '3', '9'], // numpad 6: right of 5, above 3, below 9
  '7': ['6', '8', '4'],   // top-row; numpad 7 above 4
  '8': ['7', '9', '5'],   // top-row; numpad 8 above 5
  '9': ['8', '0', '6'],   // top-row wrap; numpad 9 above 6
};

function isDigitAdjacentTypo(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let differenceCount = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const e = expected[i];
    if (a === e) continue;
    differenceCount++;
    if (differenceCount > 1) return false; // Only allow 1 digit difference
    const adjacent = KEYBOARD_ADJACENT[e];
    if (!adjacent || !adjacent.includes(a)) return false;
  }
  return differenceCount === 1;
}

function dateFuzzyMatch(candidateDate: string | undefined, existingDate: string | undefined): boolean {
  if (!candidateDate || !existingDate) return true;

  // Exact match
  if (candidateDate === existingDate) return true;

  const candDate = new Date(`${candidateDate}T00:00:00Z`);
  const exDate = new Date(`${existingDate}T00:00:00Z`);
  if (Number.isNaN(candDate.getTime()) || Number.isNaN(exDate.getTime())) return false;

  // Within ±5 days
  const dayDiff = Math.abs((candDate.getTime() - exDate.getTime()) / (1000 * 60 * 60 * 24));
  if (dayDiff <= 5) return true;

  // Check for digit-adjacent typos on date components
  const candParts = candidateDate.split('-'); // YYYY-MM-DD
  const exParts = existingDate.split('-');
  if (candParts.length !== 3 || exParts.length !== 3) return false;

  for (let i = 0; i < 3; i++) {
    if (candParts[i] === exParts[i]) continue;
    if (!isDigitAdjacentTypo(candParts[i], exParts[i])) return false;
  }
  return true;
}

function costFuzzyMatch(candidateCost: string, existingCost: string): boolean {
  if (candidateCost === existingCost) return true;

  // Extract digits only for comparison
  const candDigits = candidateCost.replace(/[^0-9]/g, '');
  const exDigits = existingCost.replace(/[^0-9]/g, '');

  return isDigitAdjacentTypo(candDigits, exDigits);
}

function currencyFuzzyMatch(candidateCurrency: string, existingCurrency: string): boolean {
  if (candidateCurrency === existingCurrency) return true;
  // Only exact match for currency; no fuzzy
  return false;
}

export function intelligentMatch(
  candidate: ExpenseCreateParams,
  existing: Expense,
  meId: number,
): boolean {
  // Must have been created or updated by the current user
  if (!existing.createdBy && !existing.updatedBy) return false;
  const createdByMe = existing.createdBy?.id === meId;
  const updatedByMe = existing.updatedBy?.id === meId;
  if (!createdByMe && !updatedByMe) return false;

  // Description must match exactly
  if (candidate.description !== existing.description) return false;

  // Cost with fuzzy digit tolerance
  if (!costFuzzyMatch(candidate.cost, existing.cost)) return false;

  // Currency must match exactly
  if ((candidate.currencyCode ?? 'USD') !== (existing.currencyCode ?? 'USD')) return false;

  // Date with fuzzy tolerance (±5 days or digit typo)
  if (!dateFuzzyMatch(candidate.date, existing.date)) return false;

  // Distribution must match exactly (if both specify users and existing has actual users)
  if (candidate.users && existing.users && existing.users.length > 0) {
    const candidateSorted = [...candidate.users]
      .sort((a, b) => a.userId - b.userId)
      .map((u) => `${u.userId}:${u.paidShare ?? '0'}:${u.owedShare ?? '0'}`)
      .join('|');
    const existingSorted = [...(existing.users ?? [])]
      .sort((a, b) => a.userId - b.userId)
      .map((u) => `${u.userId}:${u.paidShare ?? '0'}:${u.owedShare ?? '0'}`)
      .join('|');
    if (candidateSorted !== existingSorted) return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update param builder: only include changed fields
// ─────────────────────────────────────────────────────────────────────────────

import type { ExpenseUpdateParams } from 'splitwise';

export function buildExpenseUpdateParams(
  id: number,
  candidate: ExpenseCreateParams,
  existing: Expense,
): ExpenseUpdateParams | null {
  const updates: ExpenseUpdateParams = { id };
  let hasChanges = false;

  if (candidate.description !== undefined && candidate.description !== existing.description) {
    updates.description = candidate.description;
    hasChanges = true;
  }
  if (candidate.cost !== undefined && candidate.cost !== existing.cost) {
    updates.cost = candidate.cost;
    hasChanges = true;
  }
  if (candidate.currencyCode !== undefined && candidate.currencyCode !== existing.currencyCode) {
    updates.currencyCode = candidate.currencyCode;
    hasChanges = true;
  }
  if (candidate.date !== undefined && candidate.date !== existing.date) {
    updates.date = candidate.date;
    hasChanges = true;
  }
  if (candidate.details !== undefined && candidate.details !== existing.details) {
    updates.details = candidate.details;
    hasChanges = true;
  }
  if (candidate.groupId !== undefined && candidate.groupId !== existing.groupId) {
    updates.groupId = candidate.groupId;
    hasChanges = true;
  }
  if (candidate.categoryId !== undefined && candidate.categoryId !== existing.category?.id) {
    updates.categoryId = candidate.categoryId;
    hasChanges = true;
  }
  if (candidate.users !== undefined) {
    const candidateSorted = [...candidate.users]
      .sort((a, b) => a.userId - b.userId)
      .map((u) => `${u.userId}:${u.paidShare ?? '0'}:${u.owedShare ?? '0'}`)
      .join('|');
    const existingSorted = [...(existing.users ?? [])]
      .sort((a, b) => a.userId - b.userId)
      .map((u) => `${u.userId}:${u.paidShare ?? '0'}:${u.owedShare ?? '0'}`)
      .join('|');
    if (candidateSorted !== existingSorted) {
      updates.users = candidate.users;
      hasChanges = true;
    }
  }

  return hasChanges ? updates : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import result types
// ─────────────────────────────────────────────────────────────────────────────

export type ImportResult = {
  created: Array<{ record: ImportExpenseRecord; expense: Expense }>;
  skipped: Array<{ record: ImportExpenseRecord; matched: Expense }>;
  updated: Array<{ record: ImportExpenseRecord; expense: Expense }>;
  errors: Array<{ record: ImportExpenseRecord; reason: string }>;
};
