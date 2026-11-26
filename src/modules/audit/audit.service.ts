import type { Prisma, PrismaClient } from "@prisma/client";

type AuditDbClient = PrismaClient | Prisma.TransactionClient;

export async function recordAuditLog(
  db: AuditDbClient,
  params: {
    shopId: string;
    actorAdminUserId?: string | null;
    action: string;
    targetType: string;
    targetId?: string | null;
    summary?: string | null;
  }
): Promise<void> {
  await db.auditLog.create({
    data: {
      shopId: params.shopId,
      actorAdminUserId: params.actorAdminUserId ?? null,
      action: params.action.slice(0, 80),
      targetType: params.targetType.slice(0, 64),
      targetId: params.targetId ? params.targetId.slice(0, 128) : null,
      summary: params.summary ? params.summary.slice(0, 500) : null
    }
  });
}
