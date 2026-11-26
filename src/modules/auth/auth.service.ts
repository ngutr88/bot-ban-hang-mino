import type { PrismaClient, ShopMemberRole } from "@prisma/client";
import type { AppConfig } from "../../config/env.js";
import {
  forbiddenError,
  unauthenticatedError,
  validationError
} from "../../shared/errors.js";
import {
  deriveCsrfToken,
  generateOpaqueToken,
  hashPassword,
  sha256Bytes,
  verifyDummyPassword,
  verifyPassword
} from "./crypto.js";

export const SESSION_COOKIE_NAME = "mino_session";

export interface UserShopMembershipSummary {
  shopId: string;
  shopSlug: string;
  shopName: string;
  role: ShopMemberRole;
}

export interface AdminAuthContext {
  sessionId: string;
  adminUserId: string;
  email: string;
  shopId: string;
  role: ShopMemberRole;
  memberships: UserShopMembershipSummary[];
  csrfToken: string;
  csrfTokenHash: Uint8Array;
  expiresAt: Date;
}

export function normalizeEmail(rawEmail: string): string {
  return rawEmail.trim().toLowerCase();
}

export async function createAdminUser(
  prisma: PrismaClient,
  params: {
    shopId: string;
    email: string;
    password: string;
    role?: ShopMemberRole;
  }
): Promise<{ id: string; email: string; shopId: string; role: ShopMemberRole }> {
  const emailNormalized = normalizeEmail(params.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized) || emailNormalized.length > 254) {
    throw validationError("Địa chỉ email không hợp lệ.", [
      { field: "email", reason: "must be a valid email address" }
    ]);
  }
  if (params.password.length < 12 || params.password.length > 128) {
    throw validationError("Mật khẩu phải từ 12 đến 128 ký tự.", [
      { field: "password", reason: "must be between 12 and 128 characters" }
    ]);
  }

  const passwordHash = await hashPassword(params.password);
  const role = params.role ?? "owner";

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.adminUser.create({
      data: {
        shopId: params.shopId,
        emailNormalized,
        passwordHash,
        status: "active"
      }
    });

    await tx.shopMembership.upsert({
      where: {
        shopId_adminUserId: {
          shopId: params.shopId,
          adminUserId: user.id
        }
      },
      update: {
        role,
        status: "active",
        revokedAt: null
      },
      create: {
        shopId: params.shopId,
        adminUserId: user.id,
        role,
        status: "active"
      }
    });

    return user;
  });

  return {
    id: created.id,
    email: created.emailNormalized,
    shopId: created.shopId,
    role
  };
}

async function loadActiveMemberships(
  prisma: PrismaClient,
  adminUserId: string
): Promise<UserShopMembershipSummary[]> {
  const rows = await prisma.shopMembership.findMany({
    where: { adminUserId, status: "active" },
    include: {
      shop: { select: { id: true, slug: true, name: true } }
    },
    orderBy: { createdAt: "asc" }
  });

  return rows.map((m) => ({
    shopId: m.shop.id,
    shopSlug: m.shop.slug,
    shopName: m.shop.name,
    role: m.role
  }));
}

export async function loginAdmin(
  prisma: PrismaClient,
  config: AppConfig,
  params: { email: string; password: string }
): Promise<{
  rawSessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  user: { id: string; email: string; shopId: string; role: ShopMemberRole };
  memberships: UserShopMembershipSummary[];
}> {
  const emailNormalized = normalizeEmail(params.email);

  const user = await prisma.adminUser.findFirst({
    where: { emailNormalized },
    orderBy: { createdAt: "asc" }
  });

  if (!user || user.status !== "active") {
    await verifyDummyPassword(params.password);
    throw unauthenticatedError("Email hoặc mật khẩu không đúng.");
  }

  const ok = await verifyPassword(user.passwordHash, params.password);
  if (!ok) {
    throw unauthenticatedError("Email hoặc mật khẩu không đúng.");
  }

  const memberships = await loadActiveMemberships(prisma, user.id);
  if (memberships.length === 0) {
    throw unauthenticatedError("Tài khoản hiện không có quyền truy cập cửa hàng nào.");
  }

  const preferredMembership =
    memberships.find((m) => m.shopId === user.shopId) ?? memberships[0]!;

  const rawSessionToken = generateOpaqueToken(32);
  const sessionTokenHash = sha256Bytes(rawSessionToken);
  const csrfToken = deriveCsrfToken(config.sessionSecret, rawSessionToken);
  const csrfTokenHash = sha256Bytes(csrfToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlHours * 3600 * 1000);

  await prisma.$transaction([
    prisma.adminSession.create({
      data: {
        adminUserId: user.id,
        activeShopId: preferredMembership.shopId,
        sessionTokenHash,
        csrfTokenHash,
        createdAt: now,
        lastSeenAt: now,
        expiresAt
      }
    }),
    prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: now }
    })
  ]);

  return {
    rawSessionToken,
    csrfToken,
    expiresAt,
    user: {
      id: user.id,
      email: user.emailNormalized,
      shopId: preferredMembership.shopId,
      role: preferredMembership.role
    },
    memberships
  };
}

export async function authenticateSession(
  prisma: PrismaClient,
  config: AppConfig,
  rawSessionToken: string | undefined
): Promise<AdminAuthContext> {
  if (!rawSessionToken || rawSessionToken.length < 20 || rawSessionToken.length > 256) {
    throw unauthenticatedError();
  }

  const tokenHash = sha256Bytes(rawSessionToken);
  const session = await prisma.adminSession.findUnique({
    where: { sessionTokenHash: tokenHash },
    include: { adminUser: true }
  });

  const now = new Date();
  if (
    !session ||
    session.revokedAt !== null ||
    session.expiresAt <= now ||
    session.adminUser.status !== "active"
  ) {
    throw unauthenticatedError();
  }

  const memberships = await loadActiveMemberships(prisma, session.adminUserId);
  if (memberships.length === 0) {
    throw unauthenticatedError();
  }

  const targetShopId = session.activeShopId ?? session.adminUser.shopId;
  const activeMembership = memberships.find((m) => m.shopId === targetShopId);
  if (!activeMembership) {
    throw unauthenticatedError("Quyền truy cập cửa hàng của phiên này đã bị thu hồi.");
  }

  await prisma.adminSession.update({
    where: { id: session.id },
    data: { lastSeenAt: now }
  });

  const csrfToken = deriveCsrfToken(config.sessionSecret, rawSessionToken);

  return {
    sessionId: session.id,
    adminUserId: session.adminUser.id,
    email: session.adminUser.emailNormalized,
    shopId: activeMembership.shopId,
    role: activeMembership.role,
    memberships,
    csrfToken,
    csrfTokenHash: session.csrfTokenHash,
    expiresAt: session.expiresAt
  };
}

export async function switchSessionActiveShop(
  prisma: PrismaClient,
  sessionId: string,
  adminUserId: string,
  targetShopId: string
): Promise<{
  activeMembership: UserShopMembershipSummary;
  memberships: UserShopMembershipSummary[];
}> {
  const memberships = await loadActiveMemberships(prisma, adminUserId);
  const target = memberships.find((m) => m.shopId === targetShopId);
  if (!target) {
    throw forbiddenError("Bạn không có quyền thành viên đang hoạt động tại cửa hàng này.");
  }

  await prisma.adminSession.update({
    where: { id: sessionId },
    data: { activeShopId: target.shopId }
  });

  return { activeMembership: target, memberships };
}

export async function revokeSession(
  prisma: PrismaClient,
  sessionId: string
): Promise<void> {
  await prisma.adminSession.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() }
  });
}

export async function revokeAllUserSessions(
  prisma: PrismaClient,
  adminUserId: string
): Promise<void> {
  await prisma.adminSession.updateMany({
    where: { adminUserId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}
