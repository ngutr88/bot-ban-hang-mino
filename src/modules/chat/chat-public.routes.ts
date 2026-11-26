import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  Prisma,
  type ChatMessage,
  type ChatSession,
  type PrismaClient
} from "@prisma/client";
import type { AppConfig } from "../../config/env.js";
import {
  conflictError,
  unauthenticatedError,
  validationError
} from "../../shared/errors.js";
import { formatVndBigInt } from "../../shared/money.js";
import { matchBotReplyDetailed } from "../../shared/bot-matcher.js";
import {
  clampLimit,
  decodeTimestampIdCursor,
  encodeTimestampIdCursor
} from "../../shared/pagination.js";
import {
  constantTimeBytesEqual,
  generateOpaqueToken,
  sha256Bytes
} from "../auth/crypto.js";
import { getPrimaryPublicShop } from "../shop/shop.routes.js";

export const VISITOR_CHAT_COOKIE_NAME = "mino_visitor_chat";
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{8,128}$/;

function truncatePreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= 160 ? oneLine : oneLine.slice(0, 157) + "...";
}

function serializePublicMessage(msg: ChatMessage) {
  return {
    id: msg.id,
    senderType: msg.senderType,
    body: msg.body,
    createdAt: msg.createdAt.toISOString()
  };
}

function serializeVisitorSession(session: ChatSession) {
  return {
    id: session.id,
    status: session.status,
    handlingMode: session.handlingMode,
    createdAt: session.createdAt.toISOString()
  };
}

function setVisitorCookie(
  reply: FastifyReply,
  rawToken: string,
  expiresAt: Date,
  config: AppConfig
): void {
  reply.setCookie(VISITOR_CHAT_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    sameSite: "lax",
    path: "/api/v1/public/chat",
    expires: expiresAt
  });
}

async function requireVisitorSession(
  prisma: PrismaClient,
  request: FastifyRequest,
  shopId: string
): Promise<ChatSession> {
  const rawToken = request.cookies[VISITOR_CHAT_COOKIE_NAME];
  if (!rawToken || rawToken.length < 20 || rawToken.length > 256) {
    throw unauthenticatedError("Phiên trò chuyện chưa được khởi tạo hoặc đã hết hạn.");
  }

  const tokenHash = sha256Bytes(rawToken);
  const session = await prisma.chatSession.findUnique({
    where: { visitorTokenHash: tokenHash }
  });

  if (!session || session.shopId !== shopId || session.expiresAt <= new Date()) {
    throw unauthenticatedError("Phiên trò chuyện đã hết hạn, vui lòng tải lại hộp chat.");
  }

  return session;
}

export async function registerPublicChatRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    config: AppConfig;
  }
): Promise<void> {
  const { prisma, config } = deps;

  app.post(
    "/api/v1/public/chat/sessions",
    {
      config: {
        rateLimit: {
          max: config.publicChatSessionRateLimitMax,
          timeWindow: config.publicChatSessionRateLimitWindowMs
        }
      }
    },
    async (request, reply) => {
      const shop = await getPrimaryPublicShop(prisma);
      const now = new Date();
      const nextExpiry = new Date(
        now.getTime() + config.visitorChatTtlDays * 24 * 3600 * 1000
      );

      const rawExistingToken = request.cookies[VISITOR_CHAT_COOKIE_NAME];
      if (
        rawExistingToken &&
        rawExistingToken.length >= 20 &&
        rawExistingToken.length <= 256
      ) {
        const existingHash = sha256Bytes(rawExistingToken);
        const existingSession = await prisma.chatSession.findUnique({
          where: { visitorTokenHash: existingHash }
        });

        if (
          existingSession &&
          existingSession.shopId === shop.id &&
          existingSession.expiresAt > now
        ) {
          const updatedSession = await prisma.chatSession.update({
            where: { id: existingSession.id },
            data: { expiresAt: nextExpiry }
          });

          const recentDesc = await prisma.chatMessage.findMany({
            where: { chatSessionId: updatedSession.id, shopId: shop.id },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 50
          });
          const chronological = recentDesc.reverse();
          const lastMsg = chronological[chronological.length - 1];

          setVisitorCookie(reply, rawExistingToken, nextExpiry, config);

          return reply.status(200).send({
            data: {
              session: serializeVisitorSession(updatedSession),
              messages: chronological.map(serializePublicMessage),
              latestCursor: lastMsg
                ? encodeTimestampIdCursor(lastMsg.createdAt, lastMsg.id)
                : null
            },
            requestId: request.id
          });
        }
      }

      const rawVisitorToken = generateOpaqueToken(32);
      const visitorTokenHash = sha256Bytes(rawVisitorToken);
      const welcomeText = `Dạ em chào anh/chị! 🤖 Em là ${shop.botName}, trợ lý của ${shop.name}. Anh/chị nhắn tên món để xem giá niêm yết, hoặc hỏi về cách đặt hàng, vận chuyển nha!`;

      const { createdSession, welcomeMessage } = await prisma.$transaction(
        async (tx) => {
          const s = await tx.chatSession.create({
            data: {
              shopId: shop.id,
              channel: "web",
              visitorTokenHash,
              status: "open",
              handlingMode: "bot",
              unreadForShop: 0,
              lastMessageAt: now,
              lastMessagePreview: truncatePreview(welcomeText),
              expiresAt: nextExpiry
            }
          });

          const m = await tx.chatMessage.create({
            data: {
              shopId: shop.id,
              chatSessionId: s.id,
              senderType: "bot",
              body: welcomeText,
              createdAt: now
            }
          });

          return { createdSession: s, welcomeMessage: m };
        }
      );

      setVisitorCookie(reply, rawVisitorToken, nextExpiry, config);

      return reply.status(201).send({
        data: {
          session: serializeVisitorSession(createdSession),
          messages: [serializePublicMessage(welcomeMessage)],
          latestCursor: encodeTimestampIdCursor(
            welcomeMessage.createdAt,
            welcomeMessage.id
          )
        },
        requestId: request.id
      });
    }
  );

  app.get<{
    Querystring: { afterCursor?: string; limit?: string };
  }>(
    "/api/v1/public/chat/sessions/current/messages",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            afterCursor: { type: "string", maxLength: 512 },
            limit: { type: "string", pattern: "^[0-9]{1,4}$" }
          }
        }
      }
    },
    async (request, reply) => {
      const shop = await getPrimaryPublicShop(prisma);
      const session = await requireVisitorSession(prisma, request, shop.id);
      const limit = clampLimit(
        request.query.limit !== undefined ? Number(request.query.limit) : undefined
      );

      const cursorFilter: Prisma.ChatMessageWhereInput =
        request.query.afterCursor && request.query.afterCursor.length > 0
          ? (() => {
              const c = decodeTimestampIdCursor(request.query.afterCursor);
              return {
                OR: [
                  { createdAt: { gt: c.createdAt } },
                  { createdAt: c.createdAt, id: { gt: c.id } }
                ]
              };
            })()
          : {};

      const rows = await prisma.chatMessage.findMany({
        where: {
          chatSessionId: session.id,
          shopId: shop.id,
          ...cursorFilter
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit + 1
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = items[items.length - 1];

      return reply.status(200).send({
        data: items.map(serializePublicMessage),
        session: serializeVisitorSession(session),
        latestCursor: lastItem
          ? encodeTimestampIdCursor(lastItem.createdAt, lastItem.id)
          : request.query.afterCursor ?? null,
        hasMore,
        requestId: request.id
      });
    }
  );

  app.post<{
    Body: { body: string };
  }>(
    "/api/v1/public/chat/sessions/current/messages",
    {
      config: {
        rateLimit: {
          max: config.publicChatMessageRateLimitMax,
          timeWindow: config.publicChatMessageRateLimitWindowMs
        }
      },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["body"],
          properties: {
            body: { type: "string", minLength: 1, maxLength: 1000 }
          }
        }
      }
    },
    async (request, reply) => {
      const rawIdemKey = request.headers["idempotency-key"];
      if (
        typeof rawIdemKey !== "string" ||
        !IDEMPOTENCY_KEY_REGEX.test(rawIdemKey.trim())
      ) {
        throw validationError("Thiếu hoặc sai định dạng Idempotency-Key.", [
          { field: "Idempotency-Key", reason: "must be an 8-128 char idempotency key header" }
        ]);
      }
      const idempotencyKey = rawIdemKey.trim();

      const trimmedBody = request.body.body.trim();
      if (!trimmedBody) {
        throw validationError("Nội dung tin nhắn không được để trống.", [
          { field: "body", reason: "must not be blank" }
        ]);
      }

      const shop = await getPrimaryPublicShop(prisma);
      const session = await requireVisitorSession(prisma, request, shop.id);
      const fingerprint = sha256Bytes(
        JSON.stringify({ role: "customer", body: trimmedBody })
      );

      const existingMsg = await prisma.chatMessage.findUnique({
        where: {
          chatSessionId_idempotencyKey: {
            chatSessionId: session.id,
            idempotencyKey
          }
        }
      });

      if (existingMsg) {
        if (
          !existingMsg.requestFingerprint ||
          !constantTimeBytesEqual(existingMsg.requestFingerprint, fingerprint)
        ) {
          throw conflictError("Idempotency-Key đã được dùng cho một tin nhắn khác.");
        }

        const replayMessages = await prisma.chatMessage.findMany({
          where: {
            chatSessionId: session.id,
            shopId: shop.id,
            createdAt: { gte: existingMsg.createdAt }
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 2
        });
        const lastReplay = replayMessages[replayMessages.length - 1] ?? existingMsg;

        return reply.status(200).send({
          data: {
            messages: replayMessages.map(serializePublicMessage),
            session: serializeVisitorSession(session),
            latestCursor: encodeTimestampIdCursor(lastReplay.createdAt, lastReplay.id)
          },
          requestId: request.id
        });
      }

      try {
        const txResult = await prisma.$transaction(async (tx) => {
          const freshSession = await tx.chatSession.findUnique({
            where: { id: session.id }
          });
          if (!freshSession || freshSession.shopId !== shop.id) {
            throw unauthenticatedError();
          }

          const now = new Date();
          const customerMsg = await tx.chatMessage.create({
            data: {
              shopId: shop.id,
              chatSessionId: freshSession.id,
              senderType: "customer",
              body: trimmedBody,
              idempotencyKey,
              requestFingerprint: fingerprint,
              createdAt: now
            }
          });

          if (freshSession.handlingMode === "bot") {
            const [activeProducts, enabledRules] = await Promise.all([
              tx.product.findMany({
                where: { shopId: shop.id, status: "active" },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }]
              }),
              tx.botRule.findMany({
                where: { shopId: shop.id, enabled: true },
                orderBy: [{ priority: "asc" }, { id: "asc" }]
              })
            ]);

            const match = matchBotReplyDetailed({
              message: trimmedBody,
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
              fallbackReply: shop.fallbackReply
            });

            const botTime = new Date(now.getTime() + 1);
            const botMsg = await tx.chatMessage.create({
              data: {
                shopId: shop.id,
                chatSessionId: freshSession.id,
                senderType: "bot",
                body: match.reply,
                createdAt: botTime
              }
            });

            const nextStatus =
              match.matchedBy === "fallback" ? "waiting_shop" : "open";
            const updatedSession = await tx.chatSession.update({
              where: { id: freshSession.id },
              data: {
                status: nextStatus,
                closedAt: null,
                unreadForShop: { increment: 1 },
                lastMessageAt: botTime,
                lastMessagePreview: truncatePreview(match.reply)
              }
            });

            return {
              messages: [customerMsg, botMsg],
              updatedSession
            };
          }

          const updatedSession = await tx.chatSession.update({
            where: { id: freshSession.id },
            data: {
              status: "waiting_shop",
              closedAt: null,
              unreadForShop: { increment: 1 },
              lastMessageAt: now,
              lastMessagePreview: truncatePreview(trimmedBody)
            }
          });

          return {
            messages: [customerMsg],
            updatedSession
          };
        });

        request.log.info(
          {
            event: "visitor_chat_message_created",
            chatSessionId: txResult.updatedSession.id,
            handlingMode: txResult.updatedSession.handlingMode,
            status: txResult.updatedSession.status,
            shopId: shop.id
          },
          "Visitor sent chat message"
        );

        const lastCreated =
          txResult.messages[txResult.messages.length - 1]!;

        return reply.status(201).send({
          data: {
            messages: txResult.messages.map(serializePublicMessage),
            session: serializeVisitorSession(txResult.updatedSession),
            latestCursor: encodeTimestampIdCursor(
              lastCreated.createdAt,
              lastCreated.id
            )
          },
          requestId: request.id
        });
      } catch (err: unknown) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          const raced = await prisma.chatMessage.findUnique({
            where: {
              chatSessionId_idempotencyKey: {
                chatSessionId: session.id,
                idempotencyKey
              }
            }
          });
          if (raced) {
            if (
              !raced.requestFingerprint ||
              !constantTimeBytesEqual(raced.requestFingerprint, fingerprint)
            ) {
              throw conflictError("Idempotency-Key đã được dùng cho một tin nhắn khác.");
            }
            return reply.status(200).send({
              data: {
                messages: [serializePublicMessage(raced)],
                session: serializeVisitorSession(session),
                latestCursor: encodeTimestampIdCursor(raced.createdAt, raced.id)
              },
              requestId: request.id
            });
          }
        }
        throw err;
      }
    }
  );
}
