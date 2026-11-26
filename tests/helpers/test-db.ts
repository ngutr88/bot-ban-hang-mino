import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { PGlite } from "@electric-sql/pglite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "prisma",
  "migrations",
  "20261126000000_init_m1",
  "migration.sql"
);

export interface TestDbContext {
  prisma: PrismaClient;
  databaseUrl: string;
  cleanup: () => Promise<void>;
}

function buildParamStatus(name: string, value: string): Buffer {
  const payload = Buffer.from(`${name}\0${value}\0`, "utf8");
  const header = Buffer.alloc(5);
  header[0] = 0x53; // 'S'
  header.writeInt32BE(4 + payload.length, 1);
  return Buffer.concat([header, payload]);
}

function buildStartupResponse(): Buffer {
  const authOk = Buffer.alloc(9);
  authOk[0] = 0x52; // 'R'
  authOk.writeInt32BE(8, 1);
  authOk.writeInt32BE(0, 5);

  const keyData = Buffer.alloc(13);
  keyData[0] = 0x4b; // 'K'
  keyData.writeInt32BE(12, 1);
  keyData.writeInt32BE(1, 5);
  keyData.writeInt32BE(1, 9);

  const ready = Buffer.from([0x5a, 0x00, 0x00, 0x00, 0x05, 0x49]); // 'Z', len 5, 'I'

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

async function startPgliteTcpServer(pglite: PGlite): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  let mutex = Promise.resolve();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let handshakeDone = false;
    let buf: Buffer = Buffer.alloc(0);

    const drainBuffer = () => {
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
                // SSLRequest -> decline SSL
                socket.write(Buffer.from("N", "ascii"));
                continue;
              }
              // StartupMessage (v3.0 = 196608)
              handshakeDone = true;
              socket.write(buildStartupResponse());
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
              // 'X' Terminate
              socket.end();
              return;
            }

            const response = await pglite.execProtocolRaw(frame);
            if (response.byteLength > 0 && !socket.destroyed) {
              socket.write(Buffer.from(response));
            }
          }
        })
        .catch(() => {
          if (!socket.destroyed) socket.destroy();
        });
    };

    socket.on("data", (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      drainBuffer();
    });

    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("error", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind PGlite TCP server");
  }

  return {
    port: addr.port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export async function createTestDatabase(): Promise<TestDbContext> {
  const migrationSql = await fs.readFile(MIGRATION_SQL_PATH, "utf8");

  const externalTestUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalTestUrl) {
    const pool = new pg.Pool({ connectionString: externalTestUrl, max: 5 });
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await pool.query(migrationSql);
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    return {
      prisma,
      databaseUrl: externalTestUrl,
      cleanup: async () => {
        await prisma.$disconnect();
        await pool.end();
      }
    };
  }

  const pglite = await PGlite.create();
  await pglite.exec(migrationSql);

  const tcp = await startPgliteTcpServer(pglite);
  const connectionString = `postgresql://postgres:postgres@127.0.0.1:${tcp.port}/postgres?sslmode=disable`;

  const pool = new pg.Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 30000
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  return {
    prisma,
    databaseUrl: connectionString,
    cleanup: async () => {
      await prisma.$disconnect();
      await pool.end();
      await tcp.close();
      await pglite.close();
    }
  };
}
