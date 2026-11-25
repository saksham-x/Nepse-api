import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';

export interface AuditEntry {
  portfolioId?: number | null;
  action: string;
  entityType?: string;
  entityId?: string | number;
  summary: string;
  data?: Prisma.InputJsonValue;
}

/**
 * Appends to the audit log. Pass the transaction client when the action is part
 * of a transaction, so the entry commits (or rolls back) with it.
 */
export async function audit(req: Request, entry: AuditEntry, db: Prisma.TransactionClient = prisma): Promise<void> {
  await db.auditLog.create({
    data: {
      portfolioId: entry.portfolioId ?? null,
      actorId: req.auth?.user.id ?? null,
      actorName: req.auth?.user.name ?? null,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId === undefined ? null : String(entry.entityId),
      summary: entry.summary.slice(0, 500),
      ...(entry.data !== undefined ? { data: entry.data } : {}),
      ip: req.ip?.slice(0, 64) ?? null,
    },
  });
}

export function serializeAudit(row: Prisma.AuditLogGetPayload<object>) {
  return {
    id: row.id.toString(),
    portfolioId: row.portfolioId,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    summary: row.summary,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}
