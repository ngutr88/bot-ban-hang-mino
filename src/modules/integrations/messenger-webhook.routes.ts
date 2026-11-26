import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { AppConfig } from "../../config/env.js";
import { forbiddenError, validationError } from "../../shared/errors.js";
import { formatVndBigInt } from "../../shared/money.js";
import { matchBotReplyDetailed } from "../../shared/bot-matcher.js";
import {
  verifyMessengerChallenge,
  verifyMessengerSignature,
  type MessengerAdapter
} from "./messenger-adapter.js";
import { dispatchOutboundMessage } from "./outbox.service.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBodyBuffer?: Buffer;
  }
}

interface MessengerMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
  };
}

interface MessengerWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: MessengerMessagingEvent[];
  }>;
}

function truncatePreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= 160 ? oneLine : oneLine.slice(0, 157) + "...";
}

export async function registerMessengerWebhookRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    config: AppConfig;
    messengerAdapter: MessengerAdapter;
  }
): Promise<void> {
  const { prisma, config, messengerAdapter } = deps;

  await app.register(async (webhookScope) => {
    webhookScope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 64 * 1024 },
      (req, body, done) => {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        req.rawBodyBuffer = buf;
        try {
          const parsed: unknown = JSON.parse(buf.toString("utf8"));
          done(null, parsed);
        } catch {
          done(validationError("Payload JSON webhook không hợp lệ."), undefined);
        }
      }
    );

    webhookScope.get<{
      Querystring: {
        "hub.mode"?: string;
        "hub.verify_token"?: string;
        "hub.challenge"?: string;
      };
    }>("/api/v1/webhooks/messenger", async (request, reply) => {
      const challenge = verifyMessengerChallenge(
        request.query,
        config.messengerVerifyToken
      );
      if (challenge === null) {
        throw forbiddenError("Xác minh webhook Messenger thất bại.");
      }

      request.log.info(
        { event: "messenger_webhook_verified" },
        "Messenger webhook challenge verified"
      );

      return reply.status(200).type("text/plain; charset=utf-8").send(challenge);
    });

    webhookScope.post<{
      Body: MessengerWebhookPayload;
    }>("/api/v1/webhooks/messenger", async (request, reply) => {
      const rawBuf = request.rawBodyBuffer;
      const sigHeader = request.headers["x-hub-signature-256"];
      const signatureStr = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

      if (
        !rawBuf ||
        !verifyMessengerSignature(rawBuf, signatureStr, config.messengerAppSecret)
      ) {
        request.log.warn(
          { event: "messenger_webhook_invalid_signature" },
          "Rejected Messenger webhook with invalid or missing signature"
        );
        throw forbiddenError("Chữ ký X-Hub-Signature-256 không hợp lệ.");
      }

      if (request.body?.object !== "page" || !Array.isArray(request.body.entry)) {
        throw validationError("Loại sự kiện webhook không được hỗ trợ.");
      }

      const outboundIdsToDispatch: string[] = [];

      for (const entry of request.body.entry) {
        const pageId = typeof entry?.id === "string" ? entry.id.trim() : "";
        if (!pageId || !Array.isArray(entry.messaging)) continue;

        const integration = await prisma.channelIntegration.findUnique({
          where: {
            provider_externalAccountId: {
              provider: "messenger",
              externalAccountId: pageId
            }
          },
          include: { shop: true }
        });

        for (const ev of entry.messaging) {
          if (ev?.message?.is_echo === true) {
            continue;
          }

          const mid =
            typeof ev?.message?.mid === "string" ? ev.message.mid.trim() : "";
          const senderPsid =
            typeof ev?.sender?.id === "string" ? ev.sender.id.trim() : "";
          const rawText =
            typeof ev?.message?.text === "string" ? ev.message.text.trim() : "";

          if (!mid || !senderPsid || !rawText) {
            continue;
          }

          const safeText = rawText.slice(0, 2000);

          if (!integration || integration.status !== "active") {
            try {
              await prisma.webhookEvent.create({
                data: {
                  shopId: integration?.shopId ?? null,
                  provider: "messenger",
                  providerEventId: mid,
                  externalAccountId: pageId,
                  status: "ignored",
                  errorCode: integration ? "INTEGRATION_INACTIVE" : "UNKNOWN_PAGE_ID",
                  processedAt: new Date()
                }
              });
            } catch (err: unknown) {
              if (
                !(
                  err instanceof Prisma.PrismaClientKnownRequestError &&
                  err.code === "P2002"
                )
              ) {
                throw err;
              }
            }
            continue;
          }

          try {
            const createdOutboundId = await prisma.$transaction(async (tx) => {
              const now = new Date();

              await tx.webhookEvent.create({
                data: {
                  shopId: integration.shopId,
                  provider: "messenger",
                  providerEventId: mid,
                  externalAccountId: pageId,
                  status: "processed",
                  processedAt: now
                }
              });

              await tx.channelIntegration.update({
                where: { id: integration.id },
                data: { lastWebhookAt: now }
              });

              const farFutureExpiry = new Date(
                now.getTime() + 365 * 24 * 3600 * 1000
              );

              let chatSession = await tx.chatSession.findUnique({
                where: {
                  shopId_channel_externalUserId: {
                    shopId: integration.shopId,
                    channel: "messenger",
                    externalUserId: senderPsid
                  }
                }
              });

              if (!chatSession) {
                const suffix = senderPsid.slice(-4);
                chatSession = await tx.chatSession.create({
                  data: {
                    shopId: integration.shopId,
                    channel: "messenger",
                    integrationId: integration.id,
                    externalUserId: senderPsid,
                    visitorName: `Khách Messenger #${suffix}`,
                    status: "open",
                    handlingMode: "bot",
                    unreadForShop: 0,
                    lastMessageAt: now,
                    lastMessagePreview: truncatePreview(safeText),
                    expiresAt: farFutureExpiry
                  }
                });
              }

              await tx.chatMessage.create({
                data: {
                  shopId: integration.shopId,
                  chatSessionId: chatSession.id,
                  senderType: "customer",
                  body: safeText,
                  providerMessageId: mid,
                  deliveryStatus: "delivered",
                  createdAt: now
                }
              });

              if (chatSession.handlingMode === "bot") {
                const [activeProducts, enabledRules] = await Promise.all([
                  tx.product.findMany({
                    where: { shopId: integration.shopId, status: "active" },
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
                  }),
                  tx.botRule.findMany({
                    where: { shopId: integration.shopId, enabled: true },
                    orderBy: [{ priority: "asc" }, { id: "asc" }]
                  })
                ]);

                const match = matchBotReplyDetailed({
                  message: safeText,
                  products: activeProducts.map((p) => ({
                    id: p.id,
                    name: p.name,
                    priceVnd: formatVndBigInt(p.priceVnd),
                    emoji: p.emoji,
                    description: p.description
                  })),
                  rules: enabledRules.map((r) => ({
                    id: r.id,
                    keywords: r.keywords,
                    answer: r.answer,
                    priority: r.priority
                  })),
                  fallbackReply: integration.shop.fallbackReply
                });

                const botTime = new Date(now.getTime() + 1);
                const botMsg = await tx.chatMessage.create({
                  data: {
                    shopId: integration.shopId,
                    chatSessionId: chatSession.id,
                    senderType: "bot",
                    body: match.reply,
                    deliveryStatus: "pending",
                    createdAt: botTime
                  }
                });

                const outboxRow = await tx.outboundMessage.create({
                  data: {
                    shopId: integration.shopId,
                    integrationId: integration.id,
                    chatSessionId: chatSession.id,
                    chatMessageId: botMsg.id,
                    recipientExternalId: senderPsid,
                    status: "pending",
                    nextAttemptAt: botTime
                  }
                });

                await tx.chatSession.update({
                  where: { id: chatSession.id },
                  data: {
                    integrationId: integration.id,
                    status:
                      match.matchedBy === "fallback" ? "waiting_shop" : "open",
                    closedAt: null,
                    unreadForShop: { increment: 1 },
                    lastMessageAt: botTime,
                    lastMessagePreview: truncatePreview(match.reply)
                  }
                });

                return outboxRow.id;
              }

              await tx.chatSession.update({
                where: { id: chatSession.id },
                data: {
                  integrationId: integration.id,
                  status: "waiting_shop",
                  closedAt: null,
                  unreadForShop: { increment: 1 },
                  lastMessageAt: now,
                  lastMessagePreview: truncatePreview(safeText)
                }
              });

              return null;
            });

            if (createdOutboundId) {
              outboundIdsToDispatch.push(createdOutboundId);
            }
          } catch (err: unknown) {
            // Idempotent duplicate webhook delivery (same provider + provider_event_id)
            if (
              err instanceof Prisma.PrismaClientKnownRequestError &&
              err.code === "P2002"
            ) {
              request.log.info(
                { event: "messenger_webhook_duplicate_skipped" },
                "Duplicate Messenger webhook event skipped idempotently"
              );
              continue;
            }
            throw err;
          }
        }
      }

      for (const outboundId of outboundIdsToDispatch) {
        await dispatchOutboundMessage(prisma, messengerAdapter, outboundId);
      }

      return reply.status(200).send({
        data: { received: true },
        requestId: request.id
      });
    });
  });
}
