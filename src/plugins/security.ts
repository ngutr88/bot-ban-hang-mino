import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config/env.js";
import { forbiddenError } from "../shared/errors.js";

export function isAllowedOrigin(
  originHeader: string | undefined,
  request: FastifyRequest,
  config: AppConfig
): boolean {
  if (!originHeader) return false;
  let parsedOrigin: string;
  try {
    parsedOrigin = new URL(originHeader).origin;
  } catch {
    return false;
  }

  if (parsedOrigin === config.allowedOrigin) {
    return true;
  }

  // In development/test, also allow matching exact host header (e.g., 127.0.0.1 vs localhost on same port)
  if (config.nodeEnv !== "production" && request.headers.host) {
    const reqOrigin = `${request.protocol}://${request.headers.host}`;
    if (parsedOrigin === reqOrigin) {
      return true;
    }
  }

  return false;
}

export function assertSameOrigin(
  request: FastifyRequest,
  config: AppConfig,
  requirePresent: boolean
): void {
  const originHeader = request.headers.origin;
  if (!originHeader) {
    if (requirePresent) {
      throw forbiddenError("Thiếu thông tin Origin hợp lệ.");
    }
    return;
  }
  if (!isAllowedOrigin(originHeader, request, config)) {
    throw forbiddenError("Origin của yêu cầu không được phép.");
  }
}

export function applySecurityHeaders(reply: FastifyReply, config: AppConfig): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
  );
  if (config.nodeEnv === "production") {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}
