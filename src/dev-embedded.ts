import "dotenv/config";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { PGlite } from "@electric-sql/pglite";
import { loadConfig } from "./config/env.js";
import { buildApp } from "./app.js";
import { seedDemoData } from "../prisma/seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT_DIR, "prisma", "migrations");
const PGLITE_DIR = path.join(ROOT_DIR, ".pglite", "dev-db");

async function applyPendingEmbeddedMigrations(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    CREATE TABLE IF NOT EXISTS "_embedded_migrations" (
      "name" TEXT PRIMARY KEY,
      "applied_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedRows = await pglite.query<{ name: string }>(
    `SELECT "name" FROM "_embedded_migrations";`
  );
  const applied = new Set(appliedRows.rows.map((r) => r.name));

  // Backfill M1 marker if database was initialized before _embedded_migrations existed
  if (!applied.has("20261126000000_init_m1")) {
    const shopsCheck = await pglite.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'shops') AS exists;"
    );
    if (shopsCheck.rows[0]?.exists) {
      await pglite.query(
        `INSERT INTO "_embedded_migrations" ("name") VALUES ($1) ON CONFLICT DO NOTHING;`,
        ["20261126000000_init_m1"]
      );
      applied.add("20261126000000_init_m1");
    }
  }

  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const migrationDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  for (const dirName of migrationDirs) {
    if (applied.has(dirName)) continue;
    const sqlPath = path.join(MIGRATIONS_DIR, dirName, "migration.sql");
    const sql = await fs.readFile(sqlPath, "utf8");
    await pglite.exec(sql);
    await pglite.query(
      `INSERT INTO "_embedded_migrations" ("name") VALUES ($1);`,
      [dirName]
    );
    console.log(`Applied migration ${dirName} to local embedded PostgreSQL.`);
  }
}

function buildParamStatus(name: string, value: string): Buffer {
  const payload = Buffer.from(`${name}\0${value}\0`, "utf8");
  const header = Buffer.alloc(5);
  header[0] = 0x53;
  header.writeInt32BE(4 + payload.length, 1);
  return Buffer.concat([header, payload]);
}

function buildStartupPacket(): Buffer {
  const authOk = Buffer.alloc(9);
  authOk[0] = 0x52;
  authOk.writeInt32BE(8, 1);
  authOk.writeInt32BE(0, 5);

  const keyData = Buffer.alloc(13);
  keyData[0] = 0x4b;
  keyData.writeInt32BE(12, 1);
  keyData.writeInt32BE(1, 5);
  keyData.writeInt32BE(1, 9);

  const ready = Buffer.from([0x5a, 0x00, 0x00, 0x00, 0x05, 0x49]);

  return Buffer.concat([
    authOk,
    buildParamStatus("server_version", "17.4"),
    buildParamStatus("client_encoding", "UTF8"),
    buildParamStatus("server_encoding", "UTF8"),
    buildParamStatus("DateStyle", "ISO, MDY"),
    buildParamStatus("TimeZone", "UTC"),
    buildParamStatus("integer_datetimes", "on"),
    keyData,
    ready
  ]);
}

async function startEmbeddedPostgresTcp(
  pglite: PGlite,
  port = 5432
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  let mutex = Promise.resolve();
  const startupPacket = buildStartupPacket();

  const createServerInstance = () =>
    net.createServer((socket) => {
      sockets.add(socket);
      socket.setNoDelay(true);
      let handshakeDone = false;
      let buf: Buffer = Buffer.alloc(0);

      const drain = () => {
        mutex = mutex
          .then(async () => {
            while (buf.length > 0 && !socket.destroyed) {
              if (!handshakeDone) {
                if (buf.length < 8) return;
                const msgLen = buf.readInt32BE(0);
                if (buf.length < msgLen) return;
                const code = buf.readInt32BE(4);
                buf = buf.subarray(msgLen);
                if (msgLen === 8 && code === 80877103) {
                  socket.write(Buffer.from("N", "ascii"));
                  continue;
                }
                handshakeDone = true;
                socket.write(startupPacket);
                continue;
              }

              if (buf.length < 5) return;
              const msgType = buf[0];
              const payloadLen = buf.readInt32BE(1);
              const frameLen = 1 + payloadLen;
              if (buf.length < frameLen) return;

              const frame = new Uint8Array(buf.subarray(0, frameLen));
              buf = buf.subarray(frameLen);

              if (msgType === 0x58) {
                socket.end();
                return;
              }

              const out = await pglite.execProtocolRaw(frame);
              if (out.byteLength > 0 && !socket.destroyed) {
                socket.write(Buffer.from(out));
              }
            }
          })
          .catch(() => {
            if (!socket.destroyed) socket.destroy();
          });
      };

      socket.on("data", (chunk: Buffer) => {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        drain();
      });
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    });

  let server = createServerInstance();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  } catch {
    server = createServerInstance();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  }

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Unable to bind embedded PostgreSQL TCP port.");
  }

  return {
    port: addr.port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run embedded dev server in production.");
    process.exit(1);
  }

  await fs.mkdir(path.dirname(PGLITE_DIR), { recursive: true });
  const pglite = await PGlite.create(PGLITE_DIR);
  await applyPendingEmbeddedMigrations(pglite);

  const tcp = await startEmbeddedPostgresTcp(pglite, 5432);
  const connectionString = `postgresql://mino:change-me@127.0.0.1:${tcp.port}/mino_dev?sslmode=disable`;

  const pool = new pg.Pool({ connectionString, max: 1 });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  await seedDemoData(prisma);

  const config = loadConfig({ DATABASE_URL: connectionString });
  const app = await buildApp({ prisma, config });

  const shutdown = async () => {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
    await tcp.close();
    await pglite.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port: config.port, host: config.host });
  console.log(
    `Mino dev server listening at http://localhost:${config.port} (embedded PostgreSQL on 127.0.0.1:${tcp.port})`
  );
}

void main();
