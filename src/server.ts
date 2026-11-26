import { PrismaClient } from "@prisma/client";
import { loadConfig } from "./config/env.js";
import { buildApp } from "./app.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const prisma = new PrismaClient({
    datasources: {
      db: { url: config.databaseUrl }
    }
  });

  const app = await buildApp({ prisma, config });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "Shutting down server gracefully");
    try {
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err: unknown) {
    app.log.fatal(
      { errorName: err instanceof Error ? err.name : "StartupError" },
      "Failed to bind server port"
    );
    await prisma.$disconnect();
    process.exit(1);
  }
}

void start();
