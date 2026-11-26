import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../../config/env.js";
import { forbiddenError, unauthenticatedError } from "../../shared/errors.js";
import { assertSameOrigin } from "../../plugins/security.js";
import {
  SESSION_COOKIE_NAME,
  authenticateSession,
  type AdminAuthContext
} from "./auth.service.js";
import { constantTimeBytesEqual, sha256Bytes } from "./crypto.js";

declare module "fastify" {
  interface FastifyRequest {
    adminAuth?: AdminAuthContext;
  }
}

export function createAuthGuards(prisma: PrismaClient, config: AppConfig) {
  async function requireAdmin(request: FastifyRequest): Promise<void> {
    const rawToken = request.cookies[SESSION_COOKIE_NAME];
    request.adminAuth = await authenticateSession(prisma, config, rawToken);
  }

  async function requireAdminMutation(request: FastifyRequest): Promise<void> {
    await requireAdmin(request);
    assertSameOrigin(request, config, true);

    const auth = request.adminAuth;
    if (!auth) {
      throw unauthenticatedError();
    }

    const csrfHeader = request.headers["x-csrf-token"];
    if (typeof csrfHeader !== "string" || csrfHeader.length === 0) {
      throw forbiddenError("Thiếu mã bảo vệ CSRF.");
    }

    const providedHash = sha256Bytes(csrfHeader);
    if (!constantTimeBytesEqual(providedHash, auth.csrfTokenHash)) {
      throw forbiddenError("Mã bảo vệ CSRF không hợp lệ.");
    }
  }

  function getAdminContext(request: FastifyRequest): AdminAuthContext {
    if (!request.adminAuth) {
      throw unauthenticatedError();
    }
    return request.adminAuth;
  }

  return {
    requireAdmin,
    requireAdminMutation,
    getAdminContext
  };
}
