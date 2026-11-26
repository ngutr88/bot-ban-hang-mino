import type { FastifyInstance } from "fastify";
import {
  Prisma,
  type ChannelIntegration,
  type OutboundMessageStatus,
  type PrismaClient
} from "@prisma/client";
import type { AppConfig } from "../../config/env.js";
import {
  conflictError,
  notFoundError,
  validationError
} from "../../shared/errors.js";
import { clampLimit } from "../../shared/pagination.js";
import type { createAuthGuards } from "../auth/auth.guard.js";
import type { MessengerAdapter } from "./messenger-adapter.js";
import { dispatchOutboundMessage } from "./outbox.service.js";
import { recordAuditLog } from "../audit/audit.service.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

function serializeIntegration(i: ChannelIntegration) {
  return {
    id: i.id,
    provider: i.provider,
    externalAccountId: i.externalAccountId,
    displayName: i.displayName,
    status: i.status,
    secretRef: i.secretRef,
    lastWebhookAt: i.lastWebhookAt ? i.lastWebhookAt.toISOString() : null,
    lastErrorCode: i.lastErrorCode,
    disconnectedAt: i.disconnectedAt ? i.disconnectedAt.toISOString() : null,
    updatedAt: i.updatedAt.toISOString()
  };
}

export async function registerAdminIntegrationRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    config: AppConfig;
    guards: ReturnType<typeof createAuthGuards>;
    messengerAdapter: MessengerAdapter;
  }
): Promise<void> {
  const { prisma, config, guards, messengerAdapter } = deps;

  app.get(
    "/api/v1/admin/integrations",
    { preValidation: [guards.requireAdmin] },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);

      const [messengerIntegration, pendingCount, failedCount, deadLetterCount] =
        await Promise.all([
          prisma.channelIntegration.findUnique({
            where: {
              shopId_provider: {
                shopId: auth.shopId,
                provider: "messenger"
              }
            }
          }),
          prisma.outboundMessage.count({
            where: { shopId: auth.shopId, status: "pending" }
          }),
          prisma.outboundMessage.count({
            where: { shopId: auth.shopId, status: "failed" }
          }),
          prisma.outboundMessage.count({
            where: { shopId: auth.shopId, status: "dead_letter" }
          })
        ]);

      return reply.status(200).send({
        data: {
          messenger: messengerIntegration
            ? serializeIntegration(messengerIntegration)
            : null,
          secretConfigured: {
            verifyToken: Boolean(config.messengerVerifyToken),
            appSecret: Boolean(config.messengerAppSecret),
            pageAccessToken: Boolean(config.messengerPageAccessToken)
          },
          webhookPath: "/api/v1/webhooks/messenger",
          outboxSummary: {
            pendingCount,
            failedCount,
            deadLetterCount
          }
        },
        requestId: request.id
      });
    }
  );

  app.put<{
    Body: {
      externalAccountId: string;
      displayName: string;
    };
  }>(
    "/api/v1/admin/integrations/messenger",
    {
      preValidation: [guards.requireOwnerMutation],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["externalAccountId", "displayName"],
          properties: {
            externalAccountId: { type: "string", minLength: 3, maxLength: 128 },
            displayName: { type: "string", minLength: 1, maxLength: 120 }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const externalAccountId = request.body.externalAccountId.trim();
      const displayName = request.body.displayName.trim();

      if (!/^[A-Za-z0-9._-]+$/.test(externalAccountId)) {
        throw validationError("Facebook Page ID không hợp lệ.", [
          { field: "externalAccountId", reason: "invalid external account ID format" }
        ]);
      }
      if (!displayName) {
        throw validationError("Tên hiển thị Fanpage không được để trống.", [
          { field: "displayName", reason: "must not be blank" }
        ]);
      }

      try {
        const saved = await prisma.$transaction(async (tx) => {
          const s = await tx.channelIntegration.upsert({
            where: {
              shopId_provider: {
                shopId: auth.shopId,
                provider: "messenger"
              }
            },
            update: {
              externalAccountId,
              displayName,
              status: "active",
              lastErrorCode: null,
              disconnectedAt: null
            },
            create: {
              shopId: auth.shopId,
              provider: "messenger",
              externalAccountId,
              displayName,
              status: "active",
              secretRef: "ENV_MESSENGER_DEFAULT"
            }
          });
          await recordAuditLog(tx, {
            shopId: auth.shopId,
            actorAdminUserId: auth.adminUserId,
            action: "integration.messenger_connected",
            targetType: "channel_integration",
            targetId: s.id,
            summary: `Kết nối Fanpage "${displayName}" (${externalAccountId})`
          });
          return s;
        });

        request.log.info(
          {
            event: "messenger_integration_configured",
            integrationId: saved.id,
            adminUserId: auth.adminUserId,
            shopId: auth.shopId
          },
          "Messenger integration enabled"
        );

        return reply.status(200).send({
          data: serializeIntegration(saved),
          requestId: request.id
        });
      } catch (err: unknown) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          throw conflictError("Facebook Page ID này đã được gắn với một cửa hàng khác.");
        }
        throw err;
      }
    }
  );

  app.post(
    "/api/v1/admin/integrations/messenger/disconnect",
    { preValidation: [guards.requireOwnerMutation] },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const existing = await prisma.channelIntegration.findUnique({
        where: {
          shopId_provider: {
            shopId: auth.shopId,
            provider: "messenger"
          }
        }
      });

      if (!existing) {
        throw notFoundError("Chưa có tích hợp Messenger nào để ngắt kết nối.");
      }

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.channelIntegration.update({
          where: { id: existing.id },
          data: {
            status: "disconnected",
            disconnectedAt: new Date()
          }
        });
        await recordAuditLog(tx, {
          shopId: auth.shopId,
          actorAdminUserId: auth.adminUserId,
          action: "integration.messenger_disconnected",
          targetType: "channel_integration",
          targetId: u.id,
          summary: `Ngắt kết nối Fanpage "${u.displayName}"`
        });
        return u;
      });

      request.log.info(
        {
          event: "messenger_integration_disconnected",
          integrationId: updated.id,
          adminUserId: auth.adminUserId,
          shopId: auth.shopId
        },
        "Messenger integration disconnected by admin"
      );

      return reply.status(200).send({
        data: serializeIntegration(updated),
        requestId: request.id
      });
    }
  );

  app.get<{
    Querystring: {
      status?: OutboundMessageStatus;
      limit?: string;
    };
  }>(
    "/api/v1/admin/outbound-messages",
    {
      preValidation: [guards.requireAdmin],
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["pending", "sent", "failed", "dead_letter"]
            },
            limit: { type: "string", pattern: "^[0-9]{1,4}$" }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const limit = clampLimit(
        request.query.limit !== undefined ? Number(request.query.limit) : undefined
      );

      const rows = await prisma.outboundMessage.findMany({
        where: {
          shopId: auth.shopId,
          ...(request.query.status
            ? { status: request.query.status }
            : { status: { in: ["pending", "failed", "dead_letter"] } })
        },
        include: {
          chatMessage: {
            select: {
              id: true,
              senderType: true,
              body: true,
              createdAt: true
            }
          }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit
      });

      return reply.status(200).send({
        data: rows.map((r) => ({
          id: r.id,
          chatSessionId: r.chatSessionId,
          chatMessageId: r.chatMessageId,
          status: r.status,
          attemptCount: r.attemptCount,
          maxAttempts: r.maxAttempts,
          lastErrorCode: r.lastErrorCode,
          nextAttemptAt: r.nextAttemptAt.toISOString(),
          sentAt: r.sentAt ? r.sentAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
          messagePreview:
            r.chatMessage.body.length <= 120
              ? r.chatMessage.body
              : r.chatMessage.body.slice(0, 117) + "..."
        })),
        requestId: request.id
      });
    }
  );

  app.post<{
    Body: { outboundMessageId?: string };
  }>(
    "/api/v1/admin/outbound-messages/retry",
    {
      preValidation: [guards.requireAdminMutation],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            outboundMessageId: { type: "string", pattern: UUID_PATTERN }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);

      const integration = await prisma.channelIntegration.findUnique({
        where: {
          shopId_provider: {
            shopId: auth.shopId,
            provider: "messenger"
          }
        }
      });

      if (!integration || integration.status === "disconnected") {
        throw conflictError(
          "Tích hợp Messenger đang ngắt kết nối. Hãy bật lại kết nối trước khi gửi lại tin."
        );
      }

      if (integration.status === "error") {
        await prisma.channelIntegration.update({
          where: { id: integration.id },
          data: { status: "active", lastErrorCode: null }
        });
      }

      const targets = await prisma.outboundMessage.findMany({
        where: {
          shopId: auth.shopId,
          ...(request.body.outboundMessageId
            ? { id: request.body.outboundMessageId }
            : {}),
          status: { in: ["pending", "failed", "dead_letter"] }
        },
        orderBy: [{ createdAt: "asc" }],
        take: 25
      });

      if (request.body.outboundMessageId && targets.length === 0) {
        throw notFoundError("Không tìm thấy bản ghi tin nhắn cần gửi lại.");
      }

      let sentCount = 0;
      let failedCount = 0;

      for (const item of targets) {
        if (item.status === "dead_letter") {
          await prisma.outboundMessage.update({
            where: { id: item.id },
            data: {
              status: "pending",
              attemptCount: 0,
              nextAttemptAt: new Date()
            }
          });
        }
        const res = await dispatchOutboundMessage(prisma, messengerAdapter, item.id);
        if (res.status === "sent") sentCount++;
        else failedCount++;
      }

      return reply.status(200).send({
        data: {
          retriedCount: targets.length,
          sentCount,
          failedCount
        },
        requestId: request.id
      });
    }
  );
}
