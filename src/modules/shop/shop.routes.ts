import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient, Shop } from "@prisma/client";
import {
  notFoundError,
  serviceUnavailableError,
  validationError
} from "../../shared/errors.js";
import type { createAuthGuards } from "../auth/auth.guard.js";
import { recordAuditLog } from "../audit/audit.service.js";

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function getPrimaryPublicShop(
  prisma: PrismaClient,
  request?: FastifyRequest
): Promise<Shop> {
  if (request) {
    const headerSlug = request.headers["x-shop-slug"];
    const queryObj = request.query as Record<string, unknown> | undefined;
    const rawSlug =
      typeof headerSlug === "string" && headerSlug.trim() !== ""
        ? headerSlug.trim().toLowerCase()
        : typeof queryObj?.shop === "string" && queryObj.shop.trim() !== ""
        ? queryObj.shop.trim().toLowerCase()
        : null;

    if (rawSlug !== null) {
      if (!SLUG_REGEX.test(rawSlug) || rawSlug.length > 64) {
        throw validationError("Mã đường dẫn cửa hàng (shop slug) không hợp lệ.", [
          { field: "shop", reason: "invalid shop slug" }
        ]);
      }
      const found = await prisma.shop.findUnique({ where: { slug: rawSlug } });
      if (!found) {
        throw notFoundError("Không tìm thấy cửa hàng theo đường dẫn này.");
      }
      return found;
    }
  }

  const shop = await prisma.shop.findFirst({
    orderBy: { createdAt: "asc" }
  });
  if (!shop) {
    throw serviceUnavailableError("Cửa hàng chưa được khởi tạo dữ liệu.");
  }
  return shop;
}

function serializePublicShop(shop: Shop) {
  return {
    name: shop.name,
    publicPhone: shop.publicPhone,
    publicAddress: shop.publicAddress,
    botName: shop.botName,
    fallbackReply: shop.fallbackReply,
    currency: shop.currency
  };
}

function serializeAdminShop(shop: Shop) {
  return {
    id: shop.id,
    slug: shop.slug,
    name: shop.name,
    publicPhone: shop.publicPhone,
    publicAddress: shop.publicAddress,
    timezone: shop.timezone,
    currency: shop.currency,
    botName: shop.botName,
    fallbackReply: shop.fallbackReply,
    updatedAt: shop.updatedAt.toISOString()
  };
}

export async function registerShopRoutes(
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
    "/api/v1/public/shop",
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
      return reply.status(200).send({
        data: serializePublicShop(shop),
        requestId: request.id
      });
    }
  );

  app.get(
    "/api/v1/admin/shop",
    { preValidation: [guards.requireAdmin] },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const shop = await prisma.shop.findUnique({ where: { id: auth.shopId } });
      if (!shop) {
        throw notFoundError();
      }
      return reply.status(200).send({
        data: serializeAdminShop(shop),
        requestId: request.id
      });
    }
  );

  app.patch<{
    Body: {
      name?: string;
      publicPhone?: string | null;
      publicAddress?: string | null;
      botName?: string;
      fallbackReply?: string;
    };
  }>(
    "/api/v1/admin/shop",
    {
      preValidation: [guards.requireOwnerMutation],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            publicPhone: { type: ["string", "null"], maxLength: 40 },
            publicAddress: { type: ["string", "null"], maxLength: 500 },
            botName: { type: "string", minLength: 1, maxLength: 60 },
            fallbackReply: { type: "string", minLength: 1, maxLength: 1000 }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const data: {
        name?: string;
        publicPhone?: string | null;
        publicAddress?: string | null;
        botName?: string;
        fallbackReply?: string;
      } = {};

      if (request.body.name !== undefined) {
        const trimmed = request.body.name.trim();
        if (!trimmed) {
          throw validationError("Tên shop không được để trống.", [
            { field: "name", reason: "must not be blank" }
          ]);
        }
        data.name = trimmed;
      }

      if (request.body.botName !== undefined) {
        const trimmed = request.body.botName.trim();
        if (!trimmed) {
          throw validationError("Tên bot không được để trống.", [
            { field: "botName", reason: "must not be blank" }
          ]);
        }
        data.botName = trimmed;
      }

      if (request.body.fallbackReply !== undefined) {
        const trimmed = request.body.fallbackReply.trim();
        if (!trimmed) {
          throw validationError("Câu trả lời mặc định không được để trống.", [
            { field: "fallbackReply", reason: "must not be blank" }
          ]);
        }
        data.fallbackReply = trimmed;
      }

      if (request.body.publicPhone !== undefined) {
        const val = request.body.publicPhone?.trim() ?? "";
        data.publicPhone = val.length > 0 ? val : null;
      }

      if (request.body.publicAddress !== undefined) {
        const val = request.body.publicAddress?.trim() ?? "";
        data.publicAddress = val.length > 0 ? val : null;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const s = await tx.shop.update({
          where: { id: auth.shopId },
          data
        });
        await recordAuditLog(tx, {
          shopId: auth.shopId,
          actorAdminUserId: auth.adminUserId,
          action: "shop.updated",
          targetType: "shop",
          targetId: auth.shopId,
          summary: `Cập nhật thông tin cửa hàng "${s.name}"`
        });
        return s;
      });

      request.log.info(
        { event: "shop_updated", adminUserId: auth.adminUserId, shopId: auth.shopId },
        "Shop configuration updated"
      );

      return reply.status(200).send({
        data: serializeAdminShop(updated),
        requestId: request.id
      });
    }
  );
}
