import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";

export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: { prisma: PrismaClient }
): Promise<void> {
  const { prisma } = deps;

  app.get("/health/live", async (request, reply) => {
    return reply.status(200).send({
      data: { status: "ok" },
      requestId: request.id
    });
  });

  app.get("/health/ready", async (request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.status(200).send({
        data: { status: "ready" },
        requestId: request.id
      });
    } catch (err: unknown) {
      request.log.error(
        {
          event: "readiness_check_failed",
          errorName: err instanceof Error ? err.name : "UnknownError"
        },
        "Database readiness check failed"
      );
      return reply.status(503).send({
        error: {
          code: "INTERNAL_ERROR",
          message: "Hệ thống chưa sẵn sàng kết nối cơ sở dữ liệu.",
          requestId: request.id
        }
      });
    }
  });
}
