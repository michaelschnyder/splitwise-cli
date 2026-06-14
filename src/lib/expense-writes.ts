import type { ExpenseCreateParams } from 'splitwise';

export type ExpenseShareInput = {
  userId: number;
  paidShare?: string;
  owedShare?: string;
};

export type ExpenseCreateInput = {
  description: string;
  cost: string;
  date?: string;
  currencyCode?: string;
  groupId?: number;
  friendId?: number;
  details?: string;
  categoryId?: number;
  payment?: boolean;
  splitEqually?: boolean;
  shares?: ExpenseShareInput[];
};

export function parseExpenseShareInput(input: string): ExpenseShareInput {
  const parts = input.split(':').map((part) => part.trim());
  if (parts.length !== 3) {
    throw new Error(`Invalid --user-share value "${input}". Expected id:paid:owed.`);
  }

  const userId = Number(parts[0]);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`Invalid --user-share user id in "${input}".`);
  }

  const share: ExpenseShareInput = { userId };
  if (parts[1].length > 0) share.paidShare = parts[1];
  if (parts[2].length > 0) share.owedShare = parts[2];
  return share;
}

export function buildExpenseCreateParams(input: ExpenseCreateInput): ExpenseCreateParams {
  const params: ExpenseCreateParams = {
    description: input.description,
    cost: input.cost,
    ...(input.date !== undefined && { date: input.date }),
    ...(input.currencyCode !== undefined && { currencyCode: input.currencyCode }),
    ...(input.groupId !== undefined && { groupId: input.groupId }),
    ...(input.friendId !== undefined && { friendId: input.friendId }),
    ...(input.details !== undefined && { details: input.details }),
    ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
    ...(input.payment !== undefined && { payment: input.payment }),
  };

  if (input.shares !== undefined && input.shares.length > 0) {
    params.users = input.shares.map((share) => ({
      userId: share.userId,
      ...(share.paidShare !== undefined && { paidShare: share.paidShare }),
      ...(share.owedShare !== undefined && { owedShare: share.owedShare }),
    }));
  }

  if (input.shares === undefined || input.shares.length === 0) {
    params.splitEqually = input.splitEqually ?? true;
  }

  return params;
}