import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient, type ShopMemberRole } from "@prisma/client";
import type { AppConfig } from "../../config/env.js";
import {
  conflictError,
  notFoundError,
  unauthenticatedError,
  validationError
} from "../../shared/errors.js";
import {
  clampLimit,
  decodeTimestampIdCursor,
  encodeTimestampIdCursor
} from "../../shared/pagination.js";
import { assertSameOrigin } from "../../plugins/security.js";
import type { createAuthGuards } from "../auth/auth.guard.js";
import { normalizeEmail } from "../auth/auth.service.js";
import {
  generateOpaqueToken,
  hashPassword,
  sha256Bytes,
  verifyPassword
} from "../auth/crypto.js";
import { recordAuditLog } from "../audit/audit.service.js";

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function registerMultiShopRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    config: AppConfig;
    guards: ReturnType<typeof createAuthGuards>;
  }
): Promise<void> {
  const { prisma, config, guards } = deps;

  // Create a new tenant shop (caller becomes owner)
  app.post<{
    Body: {
      name: string;
      slug: string;
      botName?: string;
      fallbackReply?: string;
    };
  }>(
    "/api/v1/admin/shops",
    {
      preValidation: [guards.requireOwnerMutation],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name", "slug"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            slug: { type: "string", minLength: 2, maxLength: 64 },
            botName: { type: "string", minLength: 1, maxLength: 60 },
            fallbackReply: { type: "string", minLength: 1, maxLength: 1000 }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const name = request.body.name.trim();
      const slug = request.body.slug.trim().toLowerCase();
      const botName = request.body.botName?.trim() || "Mino";
      const fallbackReply =
        request.body.fallbackReply?.trim() ||
        "Dạ câu này em nhờ chủ shop tư vấn chi tiết hơn ạ 🙏";

      if (!name) {
        throw validationError("Tên cửa hàng không được để trống.", [
          { field: "name", reason: "must not be blank" }
        ]);
      }
      if (!SLUG_REGEX.test(slug) || slug.length < 2 || slug.length > 64) {
        throw validationError(
          "Slug cửa hàng chỉ gồm chữ thường a-z, số 0-9 và dấu gạch ngang.",
          [{ field: "slug", reason: "invalid slug format" }]
        );
      }

      try {
        const createdShop = await prisma.$transaction(async (tx) => {
          const shop = await tx.shop.create({
            data: {
              slug,
              name,
              botName,
              fallbackReply
            }
          });

          await tx.shopMembership.create({
            data: {
              shopId: shop.id,
              adminUserId: auth.adminUserId,
              role: "owner",
              status: "active"
            }
          });

          await recordAuditLog(tx, {
            shopId: shop.id,
            actorAdminUserId: auth.adminUserId,
            action: "shop.created",
            targetType: "shop",
            targetId: shop.id,
            summary: `Tạo cửa hàng mới "${shop.name}" (${shop.slug})`
          });

          return shop;
        });

        return reply.status(201).send({
          data: {
            id: createdShop.id,
            slug: createdShop.slug,
            name: createdShop.name,
            botName: createdShop.botName
          },
          requestId: request.id
        });
      } catch (err: unknown) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          throw conflictError("Mã đường dẫn (slug) cửa hàng này đã được sử dụng.");
        }
        throw err;
      }
    }
  );

  // List members & pending invitations of active shop (owner only)
  app.get(
    "/api/v1/admin/members",
    { preValidation: [guards.requireOwner] },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const now = new Date();

      const [memberships, invitations] = await Promise.all([
        prisma.shopMembership.findMany({
          where: { shopId: auth.shopId },
          include: {
            adminUser: {
              select: { id: true, emailNormalized: true, lastLoginAt: true }
            }
          },
          orderBy: [{ status: "asc" }, { createdAt: "asc" }]
        }),
        prisma.shopInvitation.findMany({
          where: {
            shopId: auth.shopId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now }
          },
          orderBy: [{ createdAt: "desc" }]
        })
      ]);

      return reply.status(200).send({
        data: {
          members: memberships.map((m) => ({
            id: m.id,
            adminUserId: m.adminUser.id,
            email: m.adminUser.emailNormalized,
            role: m.role,
            status: m.status,
            lastLoginAt: m.adminUser.lastLoginAt
              ? m.adminUser.lastLoginAt.toISOString()
              : null,
            revokedAt: m.revokedAt ? m.revokedAt.toISOString() : null,
            createdAt: m.createdAt.toISOString()
          })),
          pendingInvitations: invitations.map((inv) => ({
            id: inv.id,
            email: inv.emailNormalized,
            role: inv.role,
            expiresAt: inv.expiresAt.toISOString(),
            createdAt: inv.createdAt.toISOString()
          }))
        },
        requestId: request.id
      });
    }
  );

  // Invite staff / co-owner to active shop (owner only)
  app.post<{
    Body: { email: string; role: ShopMemberRole };
  }>(
    "/api/v1/admin/invitations",
    {
      preValidation: [guards.requireOwnerMutation],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "role"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 254 },
            role: { type: "string", enum: ["owner", "staff"] }
          }
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const emailNormalized = normalizeEmail(request.body.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized)) {
        throw validationError("Địa chỉ email lời mời không hợp lệ.", [
          { field: "email", reason: "invalid email" }
        ]);
      }

      const rawInviteToken = generateOpaqueToken(32);
      const tokenHash = sha256Bytes(rawInviteToken);
      const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);

      const invitation = await prisma.$transaction(async (tx) => {
        const inv = await tx.shopInvitation.create({
          data: {
            shopId: auth.shopId,
            emailNormalized,
            role: request.body.role,
            tokenHash,
            invitedByUserId: auth.adminUserId,
            expiresAt
          }
        });

        await recordAuditLog(tx, {
          shopId: auth.shopId,
          actorAdminUserId: auth.adminUserId,
          action: "member.invited",
          targetType: "shop_invitation",
          targetId: inv.id,
          summary: `Mời thành viên vai trò ${inv.role}`
        });

        return inv;
      });

      return reply.status(201).send({
        data: {
          id: invitation.id,
          email: invitation.emailNormalized,
          role: invitation.role,
          inviteToken: rawInviteToken,
          expiresAt: invitation.expiresAt.toISOString()
        },
        requestId: request.id
      });
    }
  );

  // Accept invitation (creates user if new, or verifies existing password if account exists)
  app.post<{
    Body: { inviteToken: string; password: string };
  }>(
    "/api/v1/admin/invitations/accept",
    {
      config: {
        rateLimit: {
          max: config.adminLoginRateLimitMax,
          timeWindow: config.adminLoginRateLimitWindowMs
        }
      },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["inviteToken", "password"],
          properties: {
            inviteToken: { type: "string", minLength: 20, maxLength: 256 },
            password: { type: "string", minLength: 12, maxLength: 128 }
          }
        }
      }
    },
    async (request, reply) => {
      assertSameOrigin(request, config, false);

      const tokenHash = sha256Bytes(request.body.inviteToken.trim());
      const now = new Date();

      const invitation = await prisma.shopInvitation.findUnique({
        where: { tokenHash }
      });

      if (
        !invitation ||
        invitation.acceptedAt !== null ||
        invitation.revokedAt !== null ||
        invitation.expiresAt <= now
      ) {
        throw validationError("Mã mời không hợp lệ, đã được sử dụng hoặc đã hết hạn.");
      }

      const existingUser = await prisma.adminUser.findFirst({
        where: { emailNormalized: invitation.emailNormalized },
        orderBy: { createdAt: "asc" }
      });

      let passwordHashToCreate: string | null = null;
      if (existingUser) {
        const ok = await verifyPassword(
          existingUser.passwordHash,
          request.body.password
        );
        if (!ok) {
          throw unauthenticatedError(
            "Email này đã có tài khoản — vui lòng nhập đúng mật khẩu hiện tại để nhận lời mời."
          );
        }
      } else {
        passwordHashToCreate = await hashPassword(request.body.password);
      }

      const result = await prisma.$transaction(async (tx) => {
        const user =
          existingUser ??
          (await tx.adminUser.create({
            data: {
              shopId: invitation.shopId,
              emailNormalized: invitation.emailNormalized,
              passwordHash: passwordHashToCreate!,
              status: "active"
            }
          }));

        const membership = await tx.shopMembership.upsert({
          where: {
            shopId_adminUserId: {
              shopId: invitation.shopId,
              adminUserId: user.id
            }
          },
          update: {
            role: invitation.role,
            status: "active",
            revokedAt: null
          },
          create: {
            shopId: invitation.shopId,
            adminUserId: user.id,
            role: invitation.role,
            status: "active"
          }
        });

        await tx.shopInvitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: now }
        });

        await recordAuditLog(tx, {
          shopId: invitation.shopId,
          actorAdminUserId: user.id,
          action: "member.accepted",
          targetType: "shop_membership",
          targetId: membership.id,
          summary: `Chấp nhận lời mời vai trò ${membership.role}`
        });

        return { user, membership };
      });

      return reply.status(200).send({
        data: {
          email: result.user.emailNormalized,
          shopId: invitation.shopId,
          role: result.membership.role
        },
        requestId: request.id
      });
    }
  );

  // Revoke member access (owner only)
  app.post<{
    Params: { id: string };
  }>(
    "/api/v1/admin/members/:id/revoke",
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
        }
      }
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      const now = new Date();

      const updated = await prisma.$transaction(async (tx) => {
        const target = await tx.shopMembership.findFirst({
          where: { id: request.params.id, shopId: auth.shopId }
        });
        if (!target) {
          throw notFoundError();
        }

        if (target.role === "owner" && target.status === "active") {
          const activeOwnerCount = await tx.shopMembership.count({
            where: {
              shopId: auth.shopId,
              role: "owner",
              status: "active"
            }
          });
          if (activeOwnerCount <= 1) {
            throw conflictError(
              "Không thể thu hồi quyền của Chủ shop duy nhất còn lại."
            );
          }
        }

        const revoked = await tx.shopMembership.update({
          where: { id: target.id },
          data: {
            status: "revoked",
            revokedAt: now
          }
        });

        // Immediately revoke active sessions of this user scoped to this shop
        await tx.adminSession.updateMany({
          where: {
            adminUserId: target.adminUserId,
            activeShopId: auth.shopId,
            revokedAt: null
          },
          data: { revokedAt: now }
        });

        await recordAuditLog(tx, {
          shopId: auth.shopId,
          actorAdminUserId: auth.adminUserId,
          action: "member.revoked",
          targetType: "shop_membership",
          targetId: revoked.id,
          summary: `Thu hồi quyền truy cập của thành viên (${target.role})`
        });

        return revoked;
      });

      return reply.status(200).send({
        data: {
          id: updated.id,
          status: updated.status,
          revokedAt: updated.revokedAt?.toISOString() ?? null
        },
        requestId: request.id
      });
    }
  );

  // List audit logs for active shop (owner only)
  app.get<{
    Querystring: { cursor?: string; limit?: string };
  }>(
    "/api/v1/admin/audit-logs",
    {
      preValidation: [guards.requireOwner],
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
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

      const cursorFilter: Prisma.AuditLogWhereInput =
        request.query.cursor && request.query.cursor.length > 0
          ? (() => {
              const c = decodeTimestampIdCursor(request.query.cursor);
              return {
                OR: [
                  { createdAt: { lt: c.createdAt } },
                  { createdAt: c.createdAt, id: { lt: c.id } }
                ]
              };
            })()
          : {};

      const rows = await prisma.auditLog.findMany({
        where: {
          shopId: auth.shopId,
          ...cursorFilter
        },
        include: {
          actorAdmin: { select: { id: true, emailNormalized: true } }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last ? encodeTimestampIdCursor(last.createdAt, last.id) : null;

      return reply.status(200).send({
        data: items.map((l) => ({
          id: l.id,
          action: l.action,
          targetType: l.targetType,
          targetId: l.targetId,
          summary: l.summary,
          actorAdmin: l.actorAdmin
            ? { id: l.actorAdmin.id, email: l.actorAdmin.emailNormalized }
            : null,
          createdAt: l.createdAt.toISOString()
        })),
        nextCursor,
        requestId: request.id
      });
    }
  );
}
