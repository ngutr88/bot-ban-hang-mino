import type { FastifyInstance } from "fastify";
import {
  Prisma,
  type Order,
  type OrderEvent,
  type OrderItem,
  type OrderStatus,
  type PrismaClient
} from "@prisma/client";
import type { AppConfig } from "../../config/env.js";
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
import { constantTimeBytesEqual } from "../auth/crypto.js";
import { getPrimaryPublicShop } from "../shop/shop.routes.js";
import { recordAuditLog } from "../audit/audit.service.js";
import {
  canonicalizeCreateOrderInput,
  generateOrderNo,
  normalizePhoneQuery,
  planOrderTransition,
  type CreateOrderBodyInput
} from "./order-domain.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{8,128}$/;

function serializePublicOrder(order: Order) {
  return {
    orderNo: order.orderNo,
    status: order.status,
    subtotalVnd: formatVndBigInt(order.subtotalVnd),
    shippingFeeVnd: formatNullableVndBigInt(order.shippingFeeVnd),
    totalVnd: formatNullableVndBigInt(order.totalVnd),
    createdAt: order.createdAt.toISOString()
  };
}

function serializeAdminOrderSummary(
  order: Order & { _count: { items: number } }
) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    recipientName: order.recipientName,
    recipientPhone: order.recipientPhone,
    subtotalVnd: formatVndBigInt(order.subtotalVnd),
    shippingFeeVnd: formatNullableVndBigInt(order.shippingFeeVnd),
    totalVnd: formatNullableVndBigInt(order.totalVnd),
    itemCount: order._count.items,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString()
  };
}

type FullOrderRecord = Order & {
  items: OrderItem[];
  events: Array<
    OrderEvent & {
      actorAdmin: { id: string; emailNormalized: string } | null;
    }
  >;
};

function serializeAdminOrderDetail(order: FullOrderRecord) {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    recipient: {
      name: order.recipientName,
      phone: order.recipientPhone,
      address: order.shippingAddress
    },
    note: order.customerNote,
    subtotalVnd: formatVndBigInt(order.subtotalVnd),
    shippingFeeVnd: formatNullableVndBigInt(order.shippingFeeVnd),
    totalVnd: formatNullableVndBigInt(order.totalVnd),
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productNameSnapshot: item.productNameSnapshot,
      unitPriceVnd: formatVndBigInt(item.unitPriceVnd),
      quantity: item.quantity,
      lineTotalVnd: formatVndBigInt(item.lineTotalVnd)
    })),
    events: order.events.map((ev) => ({
      id: ev.id,
      eventType: ev.eventType,
      oldStatus: ev.oldStatus,
      newStatus: ev.newStatus,
      note: ev.note,
      actorAdmin: ev.actorAdmin
        ? { id: ev.actorAdmin.id, email: ev.actorAdmin.emailNormalized }
        : null,
      createdAt: ev.createdAt.toISOString()
    })),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString()
  };
}

export async function registerOrderRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    config: AppConfig;
    guards: ReturnType<typeof createAuthGuards>;
  }
): Promise<void> {
  const { prisma, config, guards } = deps;

  app.post<{
    Querystring: { shop?: string };
    Body: CreateOrderBodyInput;
  }>(
    "/api/v1/public/orders",
    {
      config: {
        rateLimit: {
          max: config.publicOrderRateLimitMax,
          timeWindow: config.publicOrderRateLimitWindowMs
        }
      },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            shop: { type: "string", maxLength: 64 }
          }
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["recipient", "items"],
          properties: {
            recipient: {
              type: "object",
              additionalProperties: false,
              required: ["name", "phone", "address"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 120 },
                phone: { type: "string", minLength: 9, maxLength: 25 },
                address: { type: "string", minLength: 1, maxLength: 500 }
              }
            },
            items: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["productId", "quantity"],
                properties: {
                  productId: { type: "string", pattern: UUID_PATTERN },
                  quantity: { type: "integer", minimum: 1, maximum: 1000 }
                }
              }
            },
            note: { type: ["string", "null"], maxLength: 1000 }
          }
        }
      }
    },
    async (request, reply) => {
      const rawIdempotencyKey = request.headers["idempotency-key"];
      if (
        typeof rawIdempotencyKey !== "string" ||
        !IDEMPOTENCY_KEY_REGEX.test(rawIdempotencyKey.trim())
      ) {
        throw validationError("Thiếu hoặc sai định dạng Idempotency-Key.", [
          { field: "Idempotency-Key", reason: "must be an 8-128 char idempotency key header" }
        ]);
      }
      const idempotencyKey = rawIdempotencyKey.trim();

      const canonical = canonicalizeCreateOrderInput(request.body);
      const shop = await getPrimaryPublicShop(prisma, request);

      const existing = await prisma.order.findUnique({
        where: {
          shopId_idempotencyKey: {
            shopId: shop.id,
            idempotencyKey
          }
        }
      });

      if (existing) {
        if (!constantTimeBytesEqual(existing.requestFingerprint, canonical.requestFingerprint)) {
          throw conflictError(
            "Idempotency-Key đã được sử dụng với dữ liệu đặt hàng khác."
          );
        }
        return reply.status(200).send({
          data: serializePublicOrder(existing),
          requestId: request.id
        });
      }

      try {
        const created = await prisma.$transaction(async (tx) => {
          const productIds = canonical.items.map((i) => i.productId);
          const products = await tx.product.findMany({
            where: {
              shopId: shop.id,
              id: { in: productIds }
            }
          });

          if (products.length !== productIds.length) {
            throw conflictError("Một hoặc nhiều sản phẩm không tồn tại hoặc đã ngừng bán.");
          }

          const productMap = new Map(products.map((p) => [p.id.toLowerCase(), p]));
          let subtotalVnd = 0n;

          const itemSnapshots = canonical.items.map((item) => {
            const product = productMap.get(item.productId);
            if (!product || product.status !== "active") {
              throw conflictError("Một hoặc nhiều sản phẩm hiện không còn mở bán.");
            }
            const lineTotalVnd = product.priceVnd * BigInt(item.quantity);
            subtotalVnd += lineTotalVnd;
            return {
              shopId: shop.id,
              productId: product.id,
              productNameSnapshot: product.name,
              unitPriceVnd: product.priceVnd,
              quantity: item.quantity,
              lineTotalVnd
            };
          });

          const orderNo = generateOrderNo();
          const newOrder = await tx.order.create({
            data: {
              shopId: shop.id,
              orderNo,
              status: "new",
              recipientName: canonical.recipientName,
              recipientPhone: canonical.recipientPhone,
              recipientPhoneNorm: canonical.recipientPhoneNorm,
              shippingAddress: canonical.shippingAddress,
              customerNote: canonical.customerNote,
              subtotalVnd,
              shippingFeeVnd: null,
              totalVnd: null,
              idempotencyKey,
              requestFingerprint: canonical.requestFingerprint
            }
          });

          await tx.orderItem.createMany({
            data: itemSnapshots.map((snap) => ({
              ...snap,
              orderId: newOrder.id
            }))
          });

          await tx.orderEvent.create({
            data: {
              shopId: shop.id,
              orderId: newOrder.id,
              actorAdminUserId: null,
              eventType: "order_created",
              oldStatus: null,
              newStatus: "new",
              note: null
            }
          });

          return newOrder;
        });

        request.log.info(
          {
            event: "order_created",
            orderId: created.id,
            orderNo: created.orderNo,
            shopId: shop.id
          },
          "New COD order created"
        );

        return reply.status(201).send({
          data: serializePublicOrder(created),
          requestId: request.id
        });
      } catch (err: unknown) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          const raced = await prisma.order.findUnique({
            where: {
              shopId_idempotencyKey: {
                shopId: shop.id,
                idempotencyKey
              }
            }
          });
          if (raced) {
            if (!constantTimeBytesEqual(raced.requestFingerprint, canonical.requestFingerprint)) {
              throw conflictError(
                "Idempotency-Key đã được sử dụng với dữ liệu đặt hàng khác."
              );
            }
            return reply.status(200).send({
              data: serializePublicOrder(raced),
              requestId: request.id
            });
          }
        }
        throw err;
      }
    }
  );

  app.get<{
    Querystring: {
      status?: OrderStatus;
      q?: string;
      cursor?: string;
      limit?: string;
    };
  }>(
    "/api/v1/admin/orders",
    {
      preValidation: [guards.requireAdmin],
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: [
                "new",
                "confirmed",
                "preparing",
                "shipping",
                "completed",
                "cancelled"
              ]
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

      const andConditions: Prisma.OrderWhereInput[] = [{ shopId: auth.shopId }];

      if (request.query.status) {
        andConditions.push({ status: request.query.status });
      }

      const rawQ = request.query.q?.trim() ?? "";
      if (rawQ.length > 0) {
        const phoneDigits = normalizePhoneQuery(rawQ);
        const searchOr: Prisma.OrderWhereInput[] = [
          { orderNo: { contains: rawQ, mode: "insensitive" } },
          { recipientName: { contains: rawQ, mode: "insensitive" } },
          { recipientPhone: { contains: rawQ, mode: "insensitive" } }
        ];
        if (phoneDigits.length >= 3) {
          searchOr.push({ recipientPhoneNorm: { contains: phoneDigits } });
        }
        andConditions.push({ OR: searchOr });
      }

      if (request.query.cursor && request.query.cursor.length > 0) {
        const c = decodeTimestampIdCursor(request.query.cursor);
        andConditions.push({
          OR: [
            { createdAt: { lt: c.createdAt } },
            { createdAt: c.createdAt, id: { lt: c.id } }
          ]
        });
      }

      const rows = await prisma.order.findMany({
        where: { AND: andConditions },
        include: {
          _count: { select: { items: true } }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
        data: pageItems.map(serializeAdminOrderSummary),
        nextCursor,
        requestId: request.id
      });
    }
  );

  app.get<{
    Params: { id: string };
  }>(
    "/api/v1/admin/orders/:id",
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
      const order = await prisma.order.findFirst({
        where: { id: request.params.id, shopId: auth.shopId },
        include: {
          items: { orderBy: { id: "asc" } },
          events: {
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            include: {
              actorAdmin: { select: { id: true, emailNormalized: true } }
            }
          }
        }
      });

      if (!order) {
        throw notFoundError();
      }

      return reply.status(200).send({
        data: serializeAdminOrderDetail(order),
        requestId: request.id
      });
    }
  );

  app.patch<{
    Params: { id: string };
    Body: {
      status: OrderStatus;
      shippingFeeVnd?: string;
      note?: string | null;
    };
  }>(
    "/api/v1/admin/orders/:id",
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
          required: ["status"],
          properties: {
            status: {
              type: "string",
              enum: [
                "new",
                "confirmed",
                "preparing",
                "shipping",
                "completed",
                "cancelled"
              ]
            },
            shippingFeeVnd: { type: "string", minLength: 1, maxLength: 20 },
            note: { type: ["string", "null"], maxLength: 1000 }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const trimmedNote = request.body.note?.trim() || null;

      const updatedOrder = await prisma.$transaction(async (tx) => {
        const existing = await tx.order.findFirst({
          where: { id: request.params.id, shopId: auth.shopId }
        });
        if (!existing) {
          throw notFoundError();
        }

        const transitionPlan = planOrderTransition({
          currentStatus: existing.status,
          nextStatus: request.body.status,
          subtotalVnd: existing.subtotalVnd,
          rawShippingFeeVnd: request.body.shippingFeeVnd
        });

        await tx.orderEvent.create({
          data: {
            shopId: auth.shopId,
            orderId: existing.id,
            actorAdminUserId: auth.adminUserId,
            eventType: "status_changed",
            oldStatus: existing.status,
            newStatus: request.body.status,
            note: trimmedNote
          }
        });

        await recordAuditLog(tx, {
          shopId: auth.shopId,
          actorAdminUserId: auth.adminUserId,
          action: "order.status_changed",
          targetType: "order",
          targetId: existing.id,
          summary: `${existing.orderNo}: ${existing.status} -> ${request.body.status}`
        });

        return tx.order.update({
          where: { id: existing.id },
          data: {
            status: request.body.status,
            ...(transitionPlan.shippingFeeVnd !== undefined
              ? {
                  shippingFeeVnd: transitionPlan.shippingFeeVnd,
                  totalVnd: transitionPlan.totalVnd
                }
              : {})
          },
          include: {
            items: { orderBy: { id: "asc" } },
            events: {
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              include: {
                actorAdmin: { select: { id: true, emailNormalized: true } }
              }
            }
          }
        });
      });

      request.log.info(
        {
          event: "order_status_changed",
          orderId: updatedOrder.id,
          orderNo: updatedOrder.orderNo,
          newStatus: updatedOrder.status,
          adminUserId: auth.adminUserId,
          shopId: auth.shopId
        },
        "Order status updated"
      );

      return reply.status(200).send({
        data: serializeAdminOrderDetail(updatedOrder),
        requestId: request.id
      });
    }
  );
}
