import type { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

export interface NotificationPrefs {
  paymentDue: boolean;
  depositUpdates: boolean;
  trades: boolean;
  exits: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = { paymentDue: true, depositUpdates: true, trades: true, exits: true };

export function readPrefs(value: Prisma.JsonValue | null): NotificationPrefs {
  const v = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Partial<Record<keyof NotificationPrefs, unknown>>;
  return {
    paymentDue: v.paymentDue !== false,
    depositUpdates: v.depositUpdates !== false,
    trades: v.trades !== false,
    exits: v.exits !== false,
  };
}

const PREF_FOR: Partial<Record<NotificationType, keyof NotificationPrefs>> = {
  PAYMENT_DUE: 'paymentDue',
  DEPOSIT_APPROVED: 'depositUpdates',
  DEPOSIT_REJECTED: 'depositUpdates',
  NEW_TRADE: 'trades',
  EXIT_UPDATE: 'exits',
};

export interface NotificationInput {
  type: NotificationType;
  portfolioId?: number;
  title: string;
  body?: string;
  link?: string;
}

/** Creates in-app notifications, skipping users who turned that kind off. */
export async function notify(userIds: number[], n: NotificationInput, db: Prisma.TransactionClient = prisma): Promise<void> {
  if (userIds.length === 0) return;
  const pref = PREF_FOR[n.type];
  let recipients = [...new Set(userIds)];
  if (pref) {
    const users = await db.user.findMany({ where: { id: { in: recipients } }, select: { id: true, notificationPrefs: true } });
    recipients = users.filter((u) => readPrefs(u.notificationPrefs)[pref]).map((u) => u.id);
  }
  if (recipients.length === 0) return;
  await db.notification.createMany({
    data: recipients.map((userId) => ({
      userId,
      type: n.type,
      portfolioId: n.portfolioId ?? null,
      title: n.title.slice(0, 200),
      body: n.body?.slice(0, 500) ?? null,
      link: n.link ?? null,
    })),
  });
}

/** User ids of a portfolio's active members. */
export async function activeMemberIds(portfolioId: number, db: Prisma.TransactionClient = prisma): Promise<number[]> {
  const rows = await db.membership.findMany({ where: { portfolioId, status: 'ACTIVE' }, select: { userId: true } });
  return rows.map((r) => r.userId);
}
