import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../../config/env.js";
import { assertSameOrigin } from "../../plugins/security.js";
import {
  SESSION_COOKIE_NAME,
  loginAdmin,
  revokeSession
} from "./auth.service.js";
import type { createAuthGuards } from "./auth.guard.js";

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    prisma: PrismaClient;
    config: AppConfig;
    guards: ReturnType<typeof createAuthGuards>;
  }
): Promise<void> {
  const { prisma, config, guards } = deps;

  app.post<{
    Body: { email: string; password: string };
  }>(
    "/api/v1/admin/session",
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
          required: ["email", "password"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 254 },
            password: { type: "string", minLength: 1, maxLength: 256 }
          }
        }
      }
    },
    async (request, reply) => {
      assertSameOrigin(request, config, false);

      const session = await loginAdmin(prisma, config, {
        email: request.body.email,
        password: request.body.password
      });

      request.log.info(
        {
          event: "admin_login_succeeded",
          adminUserId: session.user.id,
          shopId: session.user.shopId
        },
        "Admin user authenticated"
      );

      reply.setCookie(SESSION_COOKIE_NAME, session.rawSessionToken, {
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: "lax",
        path: "/",
        expires: session.expiresAt
      });

      return reply.status(200).send({
        data: {
          user: session.user,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt.toISOString()
        },
        requestId: request.id
      });
    }
  );

  app.get(
    "/api/v1/admin/session",
    {
      preValidation: [guards.requireAdmin]
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      return reply.status(200).send({
        data: {
          user: {
            id: auth.adminUserId,
            email: auth.email,
            shopId: auth.shopId
          },
          csrfToken: auth.csrfToken,
          expiresAt: auth.expiresAt.toISOString()
        },
        requestId: request.id
      });
    }
  );

  app.delete(
    "/api/v1/admin/session",
    {
      preValidation: [guards.requireAdminMutation]
    },
    async (request, reply) => {
      const auth = guards.getAdminContext(request);
      await revokeSession(prisma, auth.sessionId);

      request.log.info(
        {
          event: "admin_logout",
          adminUserId: auth.adminUserId,
          shopId: auth.shopId
        },
        "Admin session revoked"
      );

      reply.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: "lax",
        path: "/"
      });

      return reply.status(204).send();
    }
  );
}
