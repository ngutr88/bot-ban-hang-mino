import type { FastifyInstance } from "fastify";
import type { Prisma, PrismaClient, Product, ProductStatus } from "@prisma/client";
import { notFoundError, validationError } from "../../shared/errors.js";
import { formatVndBigInt, parseVndString } from "../../shared/money.js";
import {
  clampLimit,
  decodeTimestampIdCursor,
  encodeTimestampIdCursor
} from "../../shared/pagination.js";
import type { createAuthGuards } from "../auth/auth.guard.js";
import { getPrimaryPublicShop } from "../shop/shop.routes.js";
import { recordAuditLog } from "../audit/audit.service.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

function serializePublicProduct(p: Product) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    priceVnd: formatVndBigInt(p.priceVnd),
    emoji: p.emoji
  };
}

function serializeAdminProduct(p: Product) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    priceVnd: formatVndBigInt(p.priceVnd),
    emoji: p.emoji,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString()
  };
}

export async function registerProductRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    guards: ReturnType<typeof createAuthGuards>;
  }
): Promise<void> {
  const { prisma, guards } = deps;

  app.get<{
    Querystring: { cursor?: string; limit?: string; shop?: string };
  }>(
    "/api/v1/public/products",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            cursor: { type: "string", maxLength: 512 },
            limit: { type: "string", pattern: "^[0-9]{1,4}$" },
            shop: { type: "string", maxLength: 64 }
          }
        }
      }
    },
    async (request, reply) => {
      const shop = await getPrimaryPublicShop(prisma, request);
      const limit = clampLimit(
        request.query.limit !== undefined ? Number(request.query.limit) : undefined
      );

      const cursorFilter: Prisma.ProductWhereInput =
        request.query.cursor && request.query.cursor.length > 0
          ? (() => {
              const c = decodeTimestampIdCursor(request.query.cursor);
              return {
                OR: [
                  { createdAt: { gt: c.createdAt } },
                  { createdAt: c.createdAt, id: { gt: c.id } }
                ]
              };
            })()
          : {};

      const rows = await prisma.product.findMany({
        where: {
          shopId: shop.id,
          status: "active",
          ...cursorFilter
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit + 1
      });

      const hasMore = rows.length > limit;
      const pageItems = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? encodeTimestampIdCursor(lastItem.createdAt, lastItem.id)
          : null;

      return reply.status(200).send({
        data: pageItems.map(serializePublicProduct),
        nextCursor,
        requestId: request.id
      });
    }
  );

  app.get<{
    Querystring: { cursor?: string; limit?: string; status?: ProductStatus };
  }>(
    "/api/v1/admin/products",
    {
      preValidation: [guards.requireAdmin],
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            cursor: { type: "string", maxLength: 512 },
            limit: { type: "string", pattern: "^[0-9]{1,4}$" },
            status: { type: "string", enum: ["active", "hidden", "archived"] }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const limit = clampLimit(
        request.query.limit !== undefined ? Number(request.query.limit) : undefined
      );

      const cursorFilter: Prisma.ProductWhereInput =
        request.query.cursor && request.query.cursor.length > 0
          ? (() => {
              const c = decodeTimestampIdCursor(request.query.cursor);
              return {
                OR: [
                  { createdAt: { gt: c.createdAt } },
                  { createdAt: c.createdAt, id: { gt: c.id } }
                ]
              };
            })()
          : {};

      const rows = await prisma.product.findMany({
        where: {
          shopId: auth.shopId,
          ...(request.query.status ? { status: request.query.status } : {}),
          ...cursorFilter
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit + 1
      });

      const hasMore = rows.length > limit;
      const pageItems = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = pageItems[pageItems.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? encodeTimestampIdCursor(lastItem.createdAt, lastItem.id)
          : null;

      return reply.status(200).send({
        data: pageItems.map(serializeAdminProduct),
        nextCursor,
        requestId: request.id
      });
    }
  );

  app.post<{
    Body: {
      name: string;
      description?: string | null;
      priceVnd: string;
      emoji?: string | null;
      status?: ProductStatus;
    };
  }>(
    "/api/v1/admin/products",
    {
      preValidation: [guards.requireOwnerMutation],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "priceVnd"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            description: { type: ["string", "null"], maxLength: 1000 },
            priceVnd: { type: "string", minLength: 1, maxLength: 20 },
            emoji: { type: ["string", "null"], maxLength: 16 },
            status: { type: "string", enum: ["active", "hidden", "archived"] }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const name = request.body.name.trim();
      if (!name) {
        throw validationError("Tên sản phẩm không được để trống.", [
          { field: "name", reason: "must not be blank" }
        ]);
      }

      const priceVnd = parseVndString(request.body.priceVnd, "priceVnd");
      const description = request.body.description?.trim() || null;
      const emoji = request.body.emoji?.trim() || null;

      const created = await prisma.$transaction(async (tx) => {
        const p = await tx.product.create({
          data: {
            shopId: auth.shopId,
            name,
            description,
            priceVnd,
            emoji,
            status: request.body.status ?? "active"
          }
        });
        await recordAuditLog(tx, {
          shopId: auth.shopId,
          actorAdminUserId: auth.adminUserId,
          action: "product.created",
          targetType: "product",
          targetId: p.id,
          summary: `Tạo sản phẩm "${p.name}" (${formatVndBigInt(p.priceVnd)}đ)`
        });
        return p;
      });

      request.log.info(
        {
          event: "product_created",
          productId: created.id,
          adminUserId: auth.adminUserId,
          shopId: auth.shopId
        },
        "Product created"
      );

      return reply.status(201).send({
        data: serializeAdminProduct(created),
        requestId: request.id
      });
    }
  );

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string | null;
      priceVnd?: string;
      emoji?: string | null;
      status?: ProductStatus;
    };
  }>(
    "/api/v1/admin/products/:id",
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
            name: { type: "string", minLength: 1, maxLength: 160 },
            description: { type: ["string", "null"], maxLength: 1000 },
            priceVnd: { type: "string", minLength: 1, maxLength: 20 },
            emoji: { type: ["string", "null"], maxLength: 16 },
            status: { type: "string", enum: ["active", "hidden", "archived"] }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const existing = await prisma.product.findFirst({
        where: { id: request.params.id, shopId: auth.shopId }
      });
      if (!existing) {
        throw notFoundError();
      }

      const data: Prisma.ProductUpdateInput = {};
      if (request.body.name !== undefined) {
        const trimmed = request.body.name.trim();
        if (!trimmed) {
          throw validationError("Tên sản phẩm không được để trống.", [
            { field: "name", reason: "must not be blank" }
          ]);
        }
        data.name = trimmed;
      }

      if (request.body.description !== undefined) {
        const val = request.body.description?.trim() ?? "";
        data.description = val.length > 0 ? val : null;
      }

      if (request.body.emoji !== undefined) {
        const val = request.body.emoji?.trim() ?? "";
        data.emoji = val.length > 0 ? val : null;
      }

      if (request.body.priceVnd !== undefined) {
        data.priceVnd = parseVndString(request.body.priceVnd, "priceVnd");
      }

      if (request.body.status !== undefined) {
        data.status = request.body.status;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const p = await tx.product.update({
          where: { id: existing.id },
          data
        });
        await recordAuditLog(tx, {
          shopId: auth.shopId,
          actorAdminUserId: auth.adminUserId,
          action: "product.updated",
          targetType: "product",
          targetId: p.id,
          summary: `Cập nhật sản phẩm "${p.name}" (${p.status})`
        });
        return p;
      });

      request.log.info(
        {
          event: "product_updated",
          productId: updated.id,
          adminUserId: auth.adminUserId,
          shopId: auth.shopId
        },
        "Product updated"
      );

      return reply.status(200).send({
        data: serializeAdminProduct(updated),
        requestId: request.id
      });
    }
  );
}
