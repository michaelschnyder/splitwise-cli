import type { CacheTarget, Credential, Profile } from './config.js';
import {
  findOfflineExpenseById,
  loadLatestFriends,
  loadLatestGroups,
  loadLatestLookup,
  resolveOfflineExpenses,
  type OfflineExpenseRequest,
} from './cache.js';

type OfflinePagedResult<T> = {
  then: <TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => PromiseLike<TResult1 | TResult2>;
  byPage: () => { [Symbol.asyncIterator]: () => AsyncIterator<T[]> };
  [Symbol.asyncIterator]: () => AsyncIterator<T>;
};

function makePagedResult<T>(items: T[], userLimit?: number, offset = 0): OfflinePagedResult<T> {
  const requestedLimit = userLimit ?? items.length;
  const firstPage = items.slice(offset, offset + requestedLimit);

  async function* pageIterator(): AsyncGenerator<T[], void, void> {
    const pageSize = userLimit ?? 100;
    let cursor = offset;
    while (cursor < items.length) {
      const page = items.slice(cursor, cursor + pageSize);
      if (page.length === 0) return;
      yield page;
      if (page.length < pageSize) return;
      cursor += pageSize;
    }
  }

  async function* itemIterator(): AsyncGenerator<T, void, void> {
    for await (const page of pageIterator()) {
      for (const item of page) yield item;
    }
  }

  return {
    then(onfulfilled, onrejected) {
      return Promise.resolve(firstPage).then(onfulfilled, onrejected);
    },
    byPage() {
      return { [Symbol.asyncIterator]: pageIterator };
    },
    [Symbol.asyncIterator]: itemIterator,
  };
}

function makeCurrentUserFromCredential(credential: Credential): any {
  return {
    id: credential.userId ?? 0,
    firstName: credential.userName ?? 'Offline',
    lastName: null,
    email: '',
    defaultCurrency: 'USD',
    locale: 'en',
  };
}

export function createOfflineSplitwiseClient(input: {
  target: CacheTarget;
  sourceLabel: string;
  profileName: string;
  profile: Profile;
  credentialName: string;
  credential: Credential;
}): unknown {
  const accountUserId = input.credential.userId;
  let pendingWarnings: string[] = [];

  const requestScopeHint = (params?: OfflineExpenseRequest): string => {
    const parts = [
      params?.from ? `--from ${params.from}` : '',
      params?.to ? `--to ${params.to}` : '',
      params?.groupId !== undefined ? `--group ${params.groupId}` : '',
      params?.friendId !== undefined ? `--friend ${params.friendId}` : '',
    ].filter(Boolean);
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
  };

  const throwOfflineMiss = (entity: 'expenses' | 'friends' | 'groups', scopeHint = ''): never => {
    throw new Error(
      `Offline cache miss for ${entity}. No compatible cached snapshot is available for profile "${input.profileName}" in ${input.sourceLabel}. `
      + `Populate cache with: splitwise-cli cache add ${entity} --target ${input.target}${scopeHint}`,
    );
  };

  const friends = () => loadLatestFriends(input.target, accountUserId, input.profileName);
  const groups = () => loadLatestGroups(input.target, accountUserId, input.profileName);
  const lookup = () => loadLatestLookup(input.target, accountUserId, input.profileName);

  const client = {
    expenses: {
      list(params?: OfflineExpenseRequest & { limit?: number; offset?: number }) {
        const result = resolveOfflineExpenses(input.target, accountUserId, {
          from: params?.from,
          to: params?.to,
          groupId: params?.groupId,
          friendId: params?.friendId,
        }, input.profileName);
        if (result.compatibleEntryCount === 0) {
          throwOfflineMiss('expenses', requestScopeHint(params));
        }
        pendingWarnings = result.warnings;
        return makePagedResult(result.expenses, params?.limit, params?.offset);
      },
      async get(params: { id: number }) {
        const found = findOfflineExpenseById(input.target, accountUserId, params.id);
        if (!found) throw new Error(`Expense ${params.id} was not found in offline cache.`);
        return found.expense;
      },
      async create() {
        throw new Error('Cannot create expenses in offline mode. Populate cache or use online mode.');
      },
      async update() {
        throw new Error('Cannot update expenses in offline mode. Populate cache or use online mode.');
      },
      async delete() {
        throw new Error('Cannot delete expenses in offline mode. Populate cache or use online mode.');
      },
    },
    groups: {
      async list() {
        return groups();
      },
      async get(params: { id: number }) {
        const group = groups().find((item) => item.id === params.id);
        if (!group) throw new Error(`Group ${params.id} was not found in offline cache.`);
        return group;
      },
    },
    users: {
      async getCurrent() {
        return makeCurrentUserFromCredential(input.credential);
      },
    },
    friends: {
      async list() {
        return friends();
      },
      async get(params: { id: number }) {
        const friend = friends().find((item) => item.id === params.id);
        if (!friend) throw new Error(`Friend ${params.id} was not found in offline cache.`);
        return friend;
      },
    },
    comments: {
      async list(params: { expenseId: number }) {
        const found = findOfflineExpenseById(input.target, accountUserId, params.expenseId);
        return found?.comments ?? [];
      },
    },
    notifications: {},
    currencies: {
      async list() {
        return lookup()?.currencies ?? [];
      },
    },
    categories: {
      async list() {
        return lookup()?.categories ?? [];
      },
    },
    getMainData() {
      return Promise.resolve({
        user: makeCurrentUserFromCredential(input.credential),
        groups: groups(),
        friends: friends(),
        currencies: lookup()?.currencies ?? [],
        categories: lookup()?.categories ?? [],
      });
    },
    consumeOfflineWarnings() {
      const warnings = [...pendingWarnings];
      pendingWarnings = [];
      return warnings;
    },
  };

  return client;
}