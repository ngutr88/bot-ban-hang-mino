import type { FastifyInstance } from "fastify";
import {
  Prisma,
  type ChatHandlingMode,
  type ChatMessage,
  type ChatNote,
  type ChatSession,
  type ChatSessionEvent,
  type ChatSessionStatus,
  type PrismaClient
} from "@prisma/client";
import {
  conflictError,
  notFoundError,
  validationError
} from "../../shared/errors.js";
import {
  formatNullableVndBigInt,
  formatVndBigInt
} from "../../shared/money.js";
import {
  clampLimit,
  decodeTimestampIdCursor,
  encodeTimestampIdCursor
} from "../../shared/pagination.js";
import type { createAuthGuards } from "../auth/auth.guard.js";
import { constantTimeBytesEqual, sha256Bytes } from "../auth/crypto.js";
import {
  normalizePhone,
  normalizePhoneQuery
} from "../orders/order-domain.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{8,128}$/;

function truncatePreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= 160 ? oneLine : oneLine.slice(0, 157) + "...";
}

function serializeConversationSummary(s: ChatSession) {
  return {
    id: s.id,
    channel: s.channel,
    visitorName: s.visitorName,
    visitorPhone: s.visitorPhone,
    status: s.status,
    handlingMode: s.handlingMode,
    unreadForShop: s.unreadForShop,
    lastMessageAt: s.lastMessageAt.toISOString(),
    lastMessagePreview: s.lastMessagePreview,
    closedAt: s.closedAt ? s.closedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString()
  };
}

function serializeAdminMessage(
  m: ChatMessage & {
    actorAdmin: { id: string; emailNormalized: string } | null;
  }
) {
  return {
    id: m.id,
    senderType: m.senderType,
    body: m.body,
    actorAdmin: m.actorAdmin
      ? { id: m.actorAdmin.id, email: m.actorAdmin.emailNormalized }
      : null,
    createdAt: m.createdAt.toISOString()
  };
}

function serializeNote(
  n: ChatNote & {
    authorAdmin: { id: string; emailNormalized: string };
  }
) {
  return {
    id: n.id,
    body: n.body,
    authorAdmin: {
      id: n.authorAdmin.id,
      email: n.authorAdmin.emailNormalized
    },
    createdAt: n.createdAt.toISOString()
  };
}

function serializeSessionEvent(
  ev: ChatSessionEvent & {
    actorAdmin: { id: string; emailNormalized: string } | null;
  }
) {
  return {
    id: ev.id,
    eventType: ev.eventType,
    detail: ev.detail,
    actorAdmin: ev.actorAdmin
      ? { id: ev.actorAdmin.id, email: ev.actorAdmin.emailNormalized }
      : null,
    createdAt: ev.createdAt.toISOString()
  };
}

export async function registerAdminChatRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    guards: ReturnType<typeof createAuthGuards>;
  }
): Promise<void> {
  const { prisma, guards } = deps;

  app.get<{
    Querystring: {
      status?: ChatSessionStatus;
      handlingMode?: ChatHandlingMode;
      q?: string;
      cursor?: string;
      limit?: string;
    };
  }>(
    "/api/v1/admin/conversations",
    {
      preValidation: [guards.requireAdmin],
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["open", "waiting_shop", "waiting_customer", "closed"]
            },
            handlingMode: {
              type: "string",
              enum: ["bot", "human"]
            },
            q: { type: "string", maxLength: 100 },
            cursor: { type: "string", maxLength: 512 },
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

      const andConditions: Prisma.ChatSessionWhereInput[] = [
        { shopId: auth.shopId }
      ];

      if (request.query.status) {
        andConditions.push({ status: request.query.status });
      }
      if (request.query.handlingMode) {
        andConditions.push({ handlingMode: request.query.handlingMode });
      }

      const rawQ = request.query.q?.trim() ?? "";
      if (rawQ.length > 0) {
        const phoneDigits = normalizePhoneQuery(rawQ);
        const searchOr: Prisma.ChatSessionWhereInput[] = [
          { visitorName: { contains: rawQ, mode: "insensitive" } },
          { visitorPhone: { contains: rawQ, mode: "insensitive" } },
          { lastMessagePreview: { contains: rawQ, mode: "insensitive" } }
        ];
        if (phoneDigits.length >= 3) {
          searchOr.push({ visitorPhoneNorm: { contains: phoneDigits } });
        }
        andConditions.push({ OR: searchOr });
      }

      if (request.query.cursor && request.query.cursor.length > 0) {
        const c = decodeTimestampIdCursor(request.query.cursor);
        andConditions.push({
          OR: [
            { lastMessageAt: { lt: c.createdAt } },
            { lastMessageAt: c.createdAt, id: { lt: c.id } }
          ]
        });
      }

      const [rows, unreadConversationsCount] = await Promise.all([
        prisma.chatSession.findMany({
          where: { AND: andConditions },
          orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
          take: limit + 1
        }),
        prisma.chatSession.count({
          where: { shopId: auth.shopId, unreadForShop: { gt: 0 } }
        })
      ]);

      const hasMore = rows.length > limit;
      const pageItems = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? encodeTimestampIdCursor(lastItem.lastMessageAt, lastItem.id)
          : null;

      return reply.status(200).send({
        data: pageItems.map(serializeConversationSummary),
        unreadConversationsCount,
        nextCursor,
        requestId: request.id
      });
    }
  );

  app.get<{
    Params: { id: string };
  }>(
    "/api/v1/admin/conversations/:id",
    {
      preValidation: [guards.requireAdmin],
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const session = await prisma.chatSession.findFirst({
        where: { id: request.params.id, shopId: auth.shopId },
        include: {
          notes: {
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            include: {
              authorAdmin: { select: { id: true, emailNormalized: true } }
            }
          },
          events: {
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            include: {
              actorAdmin: { select: { id: true, emailNormalized: true } }
            }
          }
        }
      });

      if (!session) {
        throw notFoundError();
      }

      const relatedOrders = session.visitorPhoneNorm
        ? await prisma.order.findMany({
            where: {
              shopId: auth.shopId,
              recipientPhoneNorm: session.visitorPhoneNorm
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 5
          })
        : [];

      return reply.status(200).send({
        data: {
          session: serializeConversationSummary(session),
          notes: session.notes.map(serializeNote),
          events: session.events.map(serializeSessionEvent),
          relatedOrders: relatedOrders.map((o) => ({
            id: o.id,
            orderNo: o.orderNo,
            status: o.status,
            subtotalVnd: formatVndBigInt(o.subtotalVnd),
            totalVnd: formatNullableVndBigInt(o.totalVnd),
            createdAt: o.createdAt.toISOString()
          }))
        },
        requestId: request.id
      });
    }
  );

  app.get<{
    Params: { id: string };
    Querystring: {
      afterCursor?: string;
      beforeCursor?: string;
      limit?: string;
    };
  }>(
    "/api/v1/admin/conversations/:id/messages",
    {
      preValidation: [guards.requireAdmin],
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN }
          }
        },
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            afterCursor: { type: "string", maxLength: 512 },
            beforeCursor: { type: "string", maxLength: 512 },
            limit: { type: "string", pattern: "^[0-9]{1,4}$" }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const session = await prisma.chatSession.findFirst({
        where: { id: request.params.id, shopId: auth.shopId }
      });
      if (!session) {
        throw notFoundError();
      }

      const limit = clampLimit(
        request.query.limit !== undefined ? Number(request.query.limit) : undefined
      );

      if (request.query.afterCursor && request.query.beforeCursor) {
        throw validationError("Không thể truyền đồng thời afterCursor và beforeCursor.");
      }

      if (request.query.afterCursor) {
        const c = decodeTimestampIdCursor(request.query.afterCursor);
        const rows = await prisma.chatMessage.findMany({
          where: {
            chatSessionId: session.id,
            shopId: auth.shopId,
            OR: [
              { createdAt: { gt: c.createdAt } },
              { createdAt: c.createdAt, id: { gt: c.id } }
            ]
          },
          include: {
            actorAdmin: { select: { id: true, emailNormalized: true } }
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit + 1
        });

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const lastItem = items[items.length - 1];

        return reply.status(200).send({
          data: items.map(serializeAdminMessage),
          latestCursor: lastItem
            ? encodeTimestampIdCursor(lastItem.createdAt, lastItem.id)
            : request.query.afterCursor,
          hasMore,
          requestId: request.id
        });
      }

      // Initial load or beforeCursor load (fetch latest N backwards, return ascending)
      const beforeFilter: Prisma.ChatMessageWhereInput = request.query.beforeCursor
        ? (() => {
            const c = decodeTimestampIdCursor(request.query.beforeCursor);
            return {
              OR: [
                { createdAt: { lt: c.createdAt } },
                { createdAt: c.createdAt, id: { lt: c.id } }
              ]
            };
          })()
        : {};

      const rowsDesc = await prisma.chatMessage.findMany({
        where: {
          chatSessionId: session.id,
          shopId: auth.shopId,
          ...beforeFilter
        },
        include: {
          actorAdmin: { select: { id: true, emailNormalized: true } }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1
      });

      const hasMoreOlder = rowsDesc.length > limit;
      const sliceDesc = hasMoreOlder ? rowsDesc.slice(0, limit) : rowsDesc;
      const chronological = sliceDesc.reverse();
      const firstItem = chronological[0];
      const lastItem = chronological[chronological.length - 1];

      return reply.status(200).send({
        data: chronological.map(serializeAdminMessage),
        oldestCursor:
          hasMoreOlder && firstItem
            ? encodeTimestampIdCursor(firstItem.createdAt, firstItem.id)
            : null,
        latestCursor: lastItem
          ? encodeTimestampIdCursor(lastItem.createdAt, lastItem.id)
          : null,
        hasMore: hasMoreOlder,
        requestId: request.id
      });
    }
  );

  app.post<{
    Params: { id: string };
    Body: { body: string };
  }>(
    "/api/v1/admin/conversations/:id/messages",
    {
      preValidation: [guards.requireAdminMutation],
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN }
          }
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["body"],
          properties: {
            body: { type: "string", minLength: 1, maxLength: 2000 }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
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
        throw validationError("Nội dung tin nhắn trả lời không được để trống.", [
          { field: "body", reason: "must not be blank" }
        ]);
      }

      const session = await prisma.chatSession.findFirst({
        where: { id: request.params.id, shopId: auth.shopId }
      });
      if (!session) {
        throw notFoundError();
      }

      const fingerprint = sha256Bytes(
        JSON.stringify({
          role: "admin",
          adminUserId: auth.adminUserId,
          body: trimmedBody
        })
      );

      const existing = await prisma.chatMessage.findUnique({
        where: {
          chatSessionId_idempotencyKey: {
            chatSessionId: session.id,
            idempotencyKey
          }
        },
        include: {
          actorAdmin: { select: { id: true, emailNormalized: true } }
        }
      });

      if (existing) {
        if (
          !existing.requestFingerprint ||
          !constantTimeBytesEqual(existing.requestFingerprint, fingerprint)
        ) {
          throw conflictError("Idempotency-Key đã được dùng cho nội dung khác.");
        }
        return reply.status(200).send({
          data: {
            message: serializeAdminMessage(existing),
            session: serializeConversationSummary(session),
            latestCursor: encodeTimestampIdCursor(existing.createdAt, existing.id)
          },
          requestId: request.id
        });
      }

      const now = new Date();
      const { createdMsg, updatedSession } = await prisma.$transaction(
        async (tx) => {
          const fresh = await tx.chatSession.findFirst({
            where: { id: session.id, shopId: auth.shopId }
          });
          if (!fresh) throw notFoundError();

          const msg = await tx.chatMessage.create({
            data: {
              shopId: auth.shopId,
              chatSessionId: fresh.id,
              senderType: "admin",
              actorAdminUserId: auth.adminUserId,
              body: trimmedBody,
              idempotencyKey,
              requestFingerprint: fingerprint,
              createdAt: now
            },
            include: {
              actorAdmin: { select: { id: true, emailNormalized: true } }
            }
          });

          if (fresh.handlingMode !== "human") {
            await tx.chatSessionEvent.create({
              data: {
                shopId: auth.shopId,
                chatSessionId: fresh.id,
                actorAdminUserId: auth.adminUserId,
                eventType: "takeover_human",
                detail: "Chủ shop gửi tin trả lời — tạm dừng bot tự động"
              }
            });
          }

          const updated = await tx.chatSession.update({
            where: { id: fresh.id },
            data: {
              handlingMode: "human",
              status: "waiting_customer",
              closedAt: null,
              unreadForShop: 0,
              lastMessageAt: now,
              lastMessagePreview: truncatePreview(trimmedBody)
            }
          });

          return { createdMsg: msg, updatedSession: updated };
        }
      );

      request.log.info(
        {
          event: "admin_chat_reply_sent",
          chatSessionId: updatedSession.id,
          adminUserId: auth.adminUserId,
          shopId: auth.shopId
        },
        "Admin sent chat reply"
      );

      return reply.status(201).send({
        data: {
          message: serializeAdminMessage(createdMsg),
          session: serializeConversationSummary(updatedSession),
          latestCursor: encodeTimestampIdCursor(createdMsg.createdAt, createdMsg.id)
        },
        requestId: request.id
      });
    }
  );

  app.post<{
    Params: { id: string };
    Body: { body: string };
  }>(
    "/api/v1/admin/conversations/:id/notes",
    {
      preValidation: [guards.requireAdminMutation],
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN }
          }
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["body"],
          properties: {
            body: { type: "string", minLength: 1, maxLength: 2000 }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const trimmedBody = request.body.body.trim();
      if (!trimmedBody) {
        throw validationError("Nội dung ghi chú không được để trống.", [
          { field: "body", reason: "must not be blank" }
        ]);
      }

      const session = await prisma.chatSession.findFirst({
        where: { id: request.params.id, shopId: auth.shopId }
      });
      if (!session) {
        throw notFoundError();
      }

      const createdNote = await prisma.chatNote.create({
        data: {
          shopId: auth.shopId,
          chatSessionId: session.id,
          authorAdminUserId: auth.adminUserId,
          body: trimmedBody
        },
        include: {
          authorAdmin: { select: { id: true, emailNormalized: true } }
        }
      });

      request.log.info(
        {
          event: "admin_chat_note_created",
          chatSessionId: session.id,
          noteId: createdNote.id,
          adminUserId: auth.adminUserId,
          shopId: auth.shopId
        },
        "Admin created internal chat note"
      );

      return reply.status(201).send({
        data: serializeNote(createdNote),
        requestId: request.id
      });
    }
  );

  app.patch<{
    Params: { id: string };
    Body: {
      status?: ChatSessionStatus;
      handlingMode?: ChatHandlingMode;
      visitorName?: string | null;
      visitorPhone?: string | null;
      markRead?: boolean;
    };
  }>(
    "/api/v1/admin/conversations/:id",
    {
      preValidation: [guards.requireAdminMutation],
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: {
            id: { type: "string", pattern: UUID_PATTERN }
          }
        },
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            status: {
              type: "string",
              enum: ["open", "waiting_shop", "waiting_customer", "closed"]
            },
            handlingMode: {
              type: "string",
              enum: ["bot", "human"]
            },
            visitorName: { type: ["string", "null"], maxLength: 120 },
            visitorPhone: { type: ["string", "null"], maxLength: 32 },
            markRead: { type: "boolean" }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);

      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.chatSession.findFirst({
          where: { id: request.params.id, shopId: auth.shopId }
        });
        if (!existing) {
          throw notFoundError();
        }

        const updateData: Prisma.ChatSessionUpdateInput = {};
        const eventsToLog: Array<{ eventType: string; detail: string }> = [];

        if (
          request.body.status !== undefined &&
          request.body.status !== existing.status
        ) {
          updateData.status = request.body.status;
          updateData.closedAt =
            request.body.status === "closed" ? new Date() : null;
          eventsToLog.push({
            eventType: "status_changed",
            detail: `${existing.status} → ${request.body.status}`
          });
        }

        if (
          request.body.handlingMode !== undefined &&
          request.body.handlingMode !== existing.handlingMode
        ) {
          updateData.handlingMode = request.body.handlingMode;
          eventsToLog.push({
            eventType:
              request.body.handlingMode === "bot"
                ? "resume_bot"
                : "takeover_human",
            detail: `Chế độ phụ trách: ${existing.handlingMode} → ${request.body.handlingMode}`
          });
        }

        if (request.body.visitorName !== undefined) {
          const val = request.body.visitorName?.trim() ?? "";
          updateData.visitorName = val.length > 0 ? val : null;
        }

        if (request.body.visitorPhone !== undefined) {
          const rawPhone = request.body.visitorPhone?.trim() ?? "";
          if (rawPhone.length === 0) {
            updateData.visitorPhone = null;
            updateData.visitorPhoneNorm = null;
          } else {
            const parsed = normalizePhone(rawPhone);
            updateData.visitorPhone = parsed.displayPhone;
            updateData.visitorPhoneNorm = parsed.normalizedPhone;
          }
        }

        if (request.body.markRead === true) {
          updateData.unreadForShop = 0;
        }

        for (const ev of eventsToLog) {
          await tx.chatSessionEvent.create({
            data: {
              shopId: auth.shopId,
              chatSessionId: existing.id,
              actorAdminUserId: auth.adminUserId,
              eventType: ev.eventType,
              detail: ev.detail
            }
          });
        }

        return tx.chatSession.update({
          where: { id: existing.id },
          data: updateData
        });
      });

      return reply.status(200).send({
        data: serializeConversationSummary(updated),
        requestId: request.id
      });
    }
  );
}
