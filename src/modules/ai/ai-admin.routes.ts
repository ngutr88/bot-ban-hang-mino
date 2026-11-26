import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../../config/env.js";
import { notFoundError } from "../../shared/errors.js";
import type { createAuthGuards } from "../auth/auth.guard.js";
import { recordAuditLog } from "../audit/audit.service.js";

export async function registerAiAdminRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    config: AppConfig;
    guards: ReturnType<typeof createAuthGuards>;
  }
): Promise<void> {
  const { prisma, config, guards } = deps;

  app.get(
    "/api/v1/admin/ai/settings",
    { preValidation: [guards.requireAdmin] },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const shop = await prisma.shop.findUnique({ where: { id: auth.shopId } });
      if (!shop) throw notFoundError();

      return reply.status(200).send({
        data: {
          aiEnabled: shop.aiEnabled,
          aiChannels: shop.aiChannels,
          aiDailyTokenBudget: shop.aiDailyTokenBudget,
          providerKeyConfigured: Boolean(config.aiApiKey),
          model: config.aiModel
        },
        requestId: request.id
      });
    }
  );

  app.patch<{
    Body: {
      aiEnabled?: boolean;
      aiChannels?: Array<"web" | "messenger">;
      aiDailyTokenBudget?: number;
    };
  }>(
    "/api/v1/admin/ai/settings",
    {
      preValidation: [guards.requireOwnerMutation],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            aiEnabled: { type: "boolean" },
            aiChannels: {
              type: "array",
              maxItems: 2,
              items: { type: "string", enum: ["web", "messenger"] }
            },
            aiDailyTokenBudget: {
              type: "integer",
              minimum: 0,
              maximum: 100000000
            }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const uniqueChannels = request.body.aiChannels
        ? [...new Set(request.body.aiChannels)]
        : undefined;

      const updated = await prisma.$transaction(async (tx) => {
        const s = await tx.shop.update({
          where: { id: auth.shopId },
          data: {
            ...(request.body.aiEnabled !== undefined
              ? { aiEnabled: request.body.aiEnabled }
              : {}),
            ...(uniqueChannels !== undefined ? { aiChannels: uniqueChannels } : {}),
            ...(request.body.aiDailyTokenBudget !== undefined
              ? { aiDailyTokenBudget: request.body.aiDailyTokenBudget }
              : {})
          }
        });

        await recordAuditLog(tx, {
          shopId: auth.shopId,
          actorAdminUserId: auth.adminUserId,
          action: "ai_settings.updated",
          targetType: "shop",
          targetId: auth.shopId,
          summary: `aiEnabled=${s.aiEnabled}, channels=${s.aiChannels.join(",")}, budget=${s.aiDailyTokenBudget}`
        });

        return s;
      });

      return reply.status(200).send({
        data: {
          aiEnabled: updated.aiEnabled,
          aiChannels: updated.aiChannels,
          aiDailyTokenBudget: updated.aiDailyTokenBudget,
          providerKeyConfigured: Boolean(config.aiApiKey),
          model: config.aiModel
        },
        requestId: request.id
      });
    }
  );

  app.get(
    "/api/v1/admin/ai/metrics",
    { preValidation: [guards.requireOwner] },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const shop = await prisma.shop.findUnique({ where: { id: auth.shopId } });
      if (!shop) throw notFoundError();

      const startOfUtcDay = new Date();
      startOfUtcDay.setUTCHours(0, 0, 0, 0);

      const [groupedOutcomes, todayAgg, totalAgg, recentLogs] = await Promise.all([
        prisma.aiInteractionLog.groupBy({
          by: ["outcome"],
          where: { shopId: auth.shopId },
          _count: { _all: true }
        }),
        prisma.aiInteractionLog.aggregate({
          where: { shopId: auth.shopId, createdAt: { gte: startOfUtcDay } },
          _sum: { promptTokens: true, completionTokens: true }
        }),
        prisma.aiInteractionLog.aggregate({
          where: { shopId: auth.shopId },
          _sum: {
            promptTokens: true,
            completionTokens: true,
            estimatedCostMicroUsd: true
          }
        }),
        prisma.aiInteractionLog.findMany({
          where: { shopId: auth.shopId },
          orderBy: [{ createdAt: "desc" }],
          take: 30
        })
      ]);

      const countByOutcome: Record<string, number> = {};
      let totalInteractions = 0;
      for (const row of groupedOutcomes) {
        countByOutcome[row.outcome] = row._count._all;
        totalInteractions += row._count._all;
      }

      const answeredGroundedCount = countByOutcome["answered_grounded"] ?? 0;
      const blockedHallucinationCount =
        (countByOutcome["blocked_unverified_price"] ?? 0) +
        (countByOutcome["blocked_forbidden_claim"] ?? 0);
      const handoffCount = totalInteractions - answeredGroundedCount;
      const resolutionRatePct =
        totalInteractions > 0
          ? Math.round((answeredGroundedCount / totalInteractions) * 1000) / 10
          : 0;

      const tokensUsedToday =
        (todayAgg._sum.promptTokens ?? 0) + (todayAgg._sum.completionTokens ?? 0);
      const totalCostMicroUsd = totalAgg._sum.estimatedCostMicroUsd ?? 0n;

      return reply.status(200).send({
        data: {
          totalFallbackInteractions: totalInteractions,
          answeredGroundedCount,
          handoffCount,
          blockedHallucinationCount,
          resolutionRatePct,
          tokensUsedToday,
          dailyTokenBudget: shop.aiDailyTokenBudget,
          totalEstimatedCostMicroUsd: totalCostMicroUsd.toString(10),
          recentLogs: recentLogs.map((l) => ({
            id: l.id,
            chatSessionId: l.chatSessionId,
            channel: l.channel,
            customerQueryPreview: l.customerQueryPreview,
            replyPreview: l.replyPreview,
            outcome: l.outcome,
            confidence: l.confidence,
            promptTokens: l.promptTokens,
            completionTokens: l.completionTokens,
            estimatedCostMicroUsd: l.estimatedCostMicroUsd.toString(10),
            model: l.model,
            createdAt: l.createdAt.toISOString()
          }))
        },
        requestId: request.id
      });
    }
  );
}
