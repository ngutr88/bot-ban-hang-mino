import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "./config/env.js";
import { AppError, type ErrorFieldDetail } from "./shared/errors.js";
import { applySecurityHeaders } from "./plugins/security.js";
import { createAuthGuards } from "./modules/auth/auth.guard.js";
import { registerAuthRoutes } from "./modules/auth/auth.routes.js";
import { registerShopRoutes } from "./modules/shop/shop.routes.js";
import { registerProductRoutes } from "./modules/products/products.routes.js";
import { registerBotRuleRoutes } from "./modules/bot-rules/bot-rules.routes.js";
import { registerOrderRoutes } from "./modules/orders/orders.routes.js";
import { registerHealthRoutes } from "./modules/health/health.routes.js";
import { registerPublicChatRoutes } from "./modules/chat/chat-public.routes.js";
import { registerAdminChatRoutes } from "./modules/chat/chat-admin.routes.js";
import { createMessengerAdapter } from "./modules/integrations/messenger-adapter.js";
import { registerMessengerWebhookRoutes } from "./modules/integrations/messenger-webhook.routes.js";
import { registerAdminIntegrationRoutes } from "./modules/integrations/integrations-admin.routes.js";
import { processDueOutboundMessages } from "./modules/integrations/outbox.service.js";
import { registerMultiShopRoutes } from "./modules/multishop/multishop.routes.js";
import { createGroundedAiProvider } from "./modules/ai/ai-provider.js";
import { registerAiAdminRoutes } from "./modules/ai/ai-admin.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

export interface BuildAppOptions {
  prisma: PrismaClient;
  config: AppConfig;
  loggerStream?: Writable;
  fetchFn?: typeof fetch;
  aiFetchFn?: typeof fetch;
  enableOutboxWorker?: boolean;
}

function mapValidationFields(err: FastifyError): ErrorFieldDetail[] {
  if (!err.validation || err.validation.length === 0) {
    return [];
  }
  return err.validation.map((v) => {
    const rawPath = v.instancePath ? v.instancePath.replace(/^\//, "").replace(/\//g, ".") : "";
    const missingProp =
      typeof v.params === "object" && v.params !== null && "missingProperty" in v.params
        ? String(v.params.missingProperty)
        : "";
    const additionalProp =
      typeof v.params === "object" && v.params !== null && "additionalProperty" in v.params
        ? String(v.params.additionalProperty)
        : "";

    let field = rawPath;
    if (missingProp) {
      field = field ? `${field}.${missingProp}` : missingProp;
    } else if (additionalProp) {
      field = field ? `${field}.${additionalProp}` : additionalProp;
    } else if (!field) {
      field = err.validationContext ?? "request";
    }

    const reason = additionalProp
      ? "unknown property is not allowed"
      : v.message ?? "invalid value";

    return { field, reason };
  });
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const {
    prisma,
    config,
    loggerStream,
    fetchFn,
    aiFetchFn,
    enableOutboxWorker = false
  } = options;

  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024, // 64 KB limit to mitigate oversized payload abuse
    genReqId: () => `req_${randomBytes(12).toString("hex")}`,
    logger: {
      level: config.logLevel,
      ...(loggerStream ? { stream: loggerStream } : {}),
      serializers: {
        req(request) {
          const cleanPath = request.url.split("?")[0] ?? request.url;
          return {
            method: request.method,
            url: cleanPath,
            remoteAddress: request.ip
          };
        }
      },
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]'
        ],
        remove: true
      }
    },
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        allErrors: true
      }
    }
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
    applySecurityHeaders(reply, config);
  });

  await app.register(fastifyCookie);

  await app.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: (request) => ({
      statusCode: 429,
      error: {
        code: "RATE_LIMITED",
        message: "Bạn gửi quá nhiều yêu cầu, vui lòng thử lại sau ít phút.",
        requestId: request.id
      }
    })
  });

  app.setErrorHandler((err: FastifyError | AppError | Error, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          requestId: request.id,
          ...(err.fields && err.fields.length > 0 ? { fields: err.fields } : {})
        }
      });
    }

    const fastifyErr = err as FastifyError;

    if (fastifyErr.statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Bạn gửi quá nhiều yêu cầu, vui lòng thử lại sau ít phút.",
          requestId: request.id
        }
      });
    }

    if (fastifyErr.validation) {
      const fields = mapValidationFields(fastifyErr);
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Thông tin gửi lên chưa hợp lệ.",
          requestId: request.id,
          ...(fields.length > 0 ? { fields } : {})
        }
      });
    }

    if (
      fastifyErr.statusCode === 400 ||
      fastifyErr.statusCode === 413 ||
      fastifyErr.statusCode === 415
    ) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Định dạng hoặc kích thước dữ liệu gửi lên không hợp lệ.",
          requestId: request.id
        }
      });
    }

    request.log.error(
      {
        event: "unhandled_error",
        errorName: err.name,
        statusCode: fastifyErr.statusCode ?? 500,
        route: request.routeOptions?.url
      },
      "Unhandled server error"
    );

    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Đã xảy ra lỗi hệ thống, vui lòng thử lại sau.",
        requestId: request.id
      }
    });
  });

  const guards = createAuthGuards(prisma, config);
  const messengerAdapter = createMessengerAdapter(config, fetchFn);
  const aiProvider = createGroundedAiProvider(config, aiFetchFn ?? fetchFn);

  await registerHealthRoutes(app, { prisma });
  await registerAuthRoutes(app, { prisma, config, guards });
  await registerMultiShopRoutes(app, { prisma, config, guards });
  await registerAiAdminRoutes(app, { prisma, config, guards });
  await registerShopRoutes(app, { prisma, guards });
  await registerProductRoutes(app, { prisma, guards });
  await registerBotRuleRoutes(app, { prisma, guards });
  await registerOrderRoutes(app, { prisma, config, guards });
  await registerPublicChatRoutes(app, { prisma, config, aiProvider });
  await registerAdminChatRoutes(app, { prisma, guards, messengerAdapter });
  await registerMessengerWebhookRoutes(app, {
    prisma,
    config,
    messengerAdapter,
    aiProvider
  });
  await registerAdminIntegrationRoutes(app, {
    prisma,
    config,
    guards,
    messengerAdapter
  });

  if (enableOutboxWorker) {
    const outboxTimer = setInterval(() => {
      void processDueOutboundMessages(prisma, messengerAdapter).catch((err: unknown) => {
        app.log.error(
          {
            event: "outbox_worker_error",
            errorName: err instanceof Error ? err.name : "OutboxError"
          },
          "Outbox background retry failed"
        );
      });
    }, 15_000);
    outboxTimer.unref();

    app.addHook("onClose", async () => {
      clearInterval(outboxTimer);
    });
  }

  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: "/",
    index: ["index.html"],
    wildcard: false
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/health/")) {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Không tìm thấy đường dẫn API yêu cầu.",
          requestId: request.id
        }
      });
    }
    return reply.status(404).type("text/plain; charset=utf-8").send("404 - Không tìm thấy trang.");
  });

  return app;
}
