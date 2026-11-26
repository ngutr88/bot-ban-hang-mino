import type { FastifyInstance } from "fastify";
import type { BotRule, Prisma, PrismaClient } from "@prisma/client";
import { notFoundError, validationError } from "../../shared/errors.js";
import type { createAuthGuards } from "../auth/auth.guard.js";
import { getPrimaryPublicShop } from "../shop/shop.routes.js";
import { recordAuditLog } from "../audit/audit.service.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

function normalizeKeywords(rawKeywords: string[]): string[] {
  const cleaned = rawKeywords
    .map((k) => k.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " "))
    .filter((k) => k.length > 0);

  const unique = [...new Set(cleaned)];
  if (unique.length < 1 || unique.length > 20) {
    throw validationError("Cần từ 1 đến 20 từ khóa hợp lệ.", [
      { field: "keywords", reason: "must contain 1 to 20 non-empty keywords" }
    ]);
  }
  for (const kw of unique) {
    if (kw.length > 80) {
      throw validationError("Mỗi từ khóa tối đa 80 ký tự.", [
        { field: "keywords", reason: "keyword exceeds 80 characters" }
      ]);
    }
  }
  return unique;
}

function serializePublicRule(r: BotRule) {
  return {
    keywords: r.keywords,
    answer: r.answer,
    priority: r.priority
  };
}

function serializeAdminRule(r: BotRule) {
  return {
    id: r.id,
    keywords: r.keywords,
    answer: r.answer,
    priority: r.priority,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  };
}

export async function registerBotRuleRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    guards: ReturnType<typeof createAuthGuards>;
  }
): Promise<void> {
  const { prisma, guards } = deps;

  app.get<{
    Querystring: { shop?: string };
  }>(
    "/api/v1/public/bot-rules",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            shop: { type: "string", maxLength: 64 }
          }
        }
      }
    },
    async (request, reply) => {
      const shop = await getPrimaryPublicShop(prisma, request);
    const rules = await prisma.botRule.findMany({
      where: { shopId: shop.id, enabled: true },
      orderBy: [{ priority: "asc" }, { id: "asc" }]
    });

    return reply.status(200).send({
      data: rules.map(serializePublicRule),
      requestId: request.id
    });
  });

  app.get(
    "/api/v1/admin/bot-rules",
    { preValidation: [guards.requireAdmin] },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const rules = await prisma.botRule.findMany({
        where: { shopId: auth.shopId },
        orderBy: [{ priority: "asc" }, { id: "asc" }]
      });

      return reply.status(200).send({
        data: rules.map(serializeAdminRule),
        requestId: request.id
      });
    }
  );

  app.post<{
    Body: {
      keywords: string[];
      answer: string;
      priority?: number;
      enabled?: boolean;
    };
  }>(
    "/api/v1/admin/bot-rules",
    {
      preValidation: [guards.requireOwnerMutation],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["keywords", "answer"],
          properties: {
            keywords: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 80 }
            },
            answer: { type: "string", minLength: 1, maxLength: 1000 },
            priority: { type: "integer", minimum: -10000, maximum: 100000 },
            enabled: { type: "boolean" }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const keywords = normalizeKeywords(request.body.keywords);
      const answer = request.body.answer.trim();
      if (!answer) {
        throw validationError("Câu trả lời không được để trống.", [
          { field: "answer", reason: "must not be blank" }
        ]);
      }

      const created = await prisma.$transaction(async (tx) => {
        const r = await tx.botRule.create({
          data: {
            shopId: auth.shopId,
            keywords,
            answer,
            priority: request.body.priority ?? 100,
            enabled: request.body.enabled ?? true
          }
        });
        await recordAuditLog(tx, {
          shopId: auth.shopId,
          actorAdminUserId: auth.adminUserId,
          action: "bot_rule.created",
          targetType: "bot_rule",
          targetId: r.id,
          summary: `Tạo kịch bản từ khóa [${r.keywords.slice(0, 3).join(", ")}]`
        });
        return r;
      });

      request.log.info(
        {
          event: "bot_rule_created",
          ruleId: created.id,
          adminUserId: auth.adminUserId,
          shopId: auth.shopId
        },
        "Bot rule created"
      );

      return reply.status(201).send({
        data: serializeAdminRule(created),
        requestId: request.id
      });
    }
  );

  app.patch<{
    Params: { id: string };
    Body: {
      keywords?: string[];
      answer?: string;
      priority?: number;
      enabled?: boolean;
    };
  }>(
    "/api/v1/admin/bot-rules/:id",
    {
      preValidation: [guards.requireOwnerMutation],
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
            keywords: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 80 }
            },
            answer: { type: "string", minLength: 1, maxLength: 1000 },
            priority: { type: "integer", minimum: -10000, maximum: 100000 },
            enabled: { type: "boolean" }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const existing = await prisma.botRule.findFirst({
        where: { id: request.params.id, shopId: auth.shopId }
      });
      if (!existing) {
        throw notFoundError();
      }

      const data: Prisma.BotRuleUpdateInput = {};
      if (request.body.keywords !== undefined) {
        data.keywords = normalizeKeywords(request.body.keywords);
      }
      if (request.body.answer !== undefined) {
        const answer = request.body.answer.trim();
        if (!answer) {
          throw validationError("Câu trả lời không được để trống.", [
            { field: "answer", reason: "must not be blank" }
          ]);
        }
        data.answer = answer;
      }
      if (request.body.priority !== undefined) {
        data.priority = request.body.priority;
      }
      if (request.body.enabled !== undefined) {
        data.enabled = request.body.enabled;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const r = await tx.botRule.update({
          where: { id: existing.id },
          data
        });
        await recordAuditLog(tx, {
          shopId: auth.shopId,
          actorAdminUserId: auth.adminUserId,
          action: "bot_rule.updated",
          targetType: "bot_rule",
          targetId: r.id,
          summary: `Cập nhật kịch bản từ khóa (enabled=${r.enabled})`
        });
        return r;
      });

      request.log.info(
        {
          event: "bot_rule_updated",
          ruleId: updated.id,
          adminUserId: auth.adminUserId,
          shopId: auth.shopId
        },
        "Bot rule updated"
      );

      return reply.status(200).send({
        data: serializeAdminRule(updated),
        requestId: request.id
      });
    }
  );
}
