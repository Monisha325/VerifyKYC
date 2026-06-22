import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

export async function getEntityHistory(entity: string, entityId: string) {
  return prisma.auditEvent.findMany({
    where:   { entity, entityId },
    orderBy: { createdAt: 'asc' },
    include: {
      actor: { select: { id: true, fullName: true, email: true, role: true } },
    },
  });
}

// System-wide recent activity — unscoped, ADMIN-only (enforced by the agent
// dispatch layer). Distinct from getEntityHistory, which is scoped to one
// entity instance.
export async function getRecentAuditEvents(limit = 100) {
  return prisma.auditEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take:    Math.min(limit, 500),
    include: {
      actor: { select: { id: true, fullName: true, email: true, role: true } },
    },
  });
}

interface AuditParams {
  action: string;
  entity: string;
  entityId?: string;
  actorId?: string;
  applicationId?: string;
  meta?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

// Append-only — never called with update or delete (CLAUDE.md rule 10)
export async function audit(params: AuditParams): Promise<void> {
  await prisma.auditEvent.create({ data: _build(params) });
}

/**
 * Returns a Prisma operation that can be included inside a prisma.$transaction([...])
 * so the audit event is written atomically with the status change it describes.
 * Still append-only — no update or delete path exists.
 */
export function auditOperation(params: AuditParams): Prisma.PrismaPromise<Prisma.AuditEventGetPayload<object>> {
  return prisma.auditEvent.create({ data: _build(params) });
}

function _build(params: AuditParams) {
  return {
    action:        params.action,
    entity:        params.entity,
    entityId:      params.entityId,
    actorId:       params.actorId,
    applicationId: params.applicationId,
    meta:          params.meta as Prisma.InputJsonValue | undefined,
    ipAddress:     params.ipAddress,
    userAgent:     params.userAgent,
  };
}
