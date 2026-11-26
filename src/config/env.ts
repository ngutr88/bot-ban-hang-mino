import "dotenv/config";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  appBaseUrl: string;
  allowedOrigin: string;
  databaseUrl: string;
  sessionSecret: string;
  sessionTtlHours: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  trustProxy: boolean;
  publicOrderRateLimitMax: number;
  publicOrderRateLimitWindowMs: number;
  adminLoginRateLimitMax: number;
  adminLoginRateLimitWindowMs: number;
  visitorChatTtlDays: number;
  publicChatSessionRateLimitMax: number;
  publicChatSessionRateLimitWindowMs: number;
  publicChatMessageRateLimitMax: number;
  publicChatMessageRateLimitWindowMs: number;
  chatRetentionDays: number | null;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid environment variable ${name}: must be a positive integer.`);
  }
  return n;
}

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const env = { ...process.env, ...overrides };

  const rawNodeEnv = env.NODE_ENV ?? "development";
  if (rawNodeEnv !== "development" && rawNodeEnv !== "test" && rawNodeEnv !== "production") {
    throw new Error("Invalid NODE_ENV: must be development, test, or production.");
  }

  const port = parsePositiveInt(env.PORT, 3000, "PORT");
  const host = (env.HOST ?? "127.0.0.1").trim();

  const appBaseUrl = (env.APP_BASE_URL ?? `http://localhost:${port}`).trim();
  let allowedOrigin: string;
  try {
    allowedOrigin = new URL(appBaseUrl).origin;
  } catch {
    throw new Error("Invalid APP_BASE_URL: must be a valid URL including scheme and host.");
  }

  const databaseUrl = (env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    throw new Error("Missing required environment variable DATABASE_URL.");
  }

  const sessionSecret = env.SESSION_SECRET ?? "";
  if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
    throw new Error("SESSION_SECRET must be at least 32 bytes long.");
  }
  if (
    rawNodeEnv === "production" &&
    sessionSecret.includes("replace-with-random-secret")
  ) {
    throw new Error("Refusing to start in production with placeholder SESSION_SECRET.");
  }

  const sessionTtlHours = parsePositiveInt(env.SESSION_TTL_HOURS, 24, "SESSION_TTL_HOURS");

  const validLogLevels = new Set([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent"
  ]);
  const rawLogLevel = (env.LOG_LEVEL ?? (rawNodeEnv === "test" ? "silent" : "info")).trim();
  if (!validLogLevels.has(rawLogLevel)) {
    throw new Error("Invalid LOG_LEVEL.");
  }

  const trustProxy = env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true";

  return {
    nodeEnv: rawNodeEnv,
    port,
    host,
    appBaseUrl,
    allowedOrigin,
    databaseUrl,
    sessionSecret,
    sessionTtlHours,
    logLevel: rawLogLevel as AppConfig["logLevel"],
    trustProxy,
    publicOrderRateLimitMax: parsePositiveInt(
      env.PUBLIC_ORDER_RATE_LIMIT_MAX,
      15,
      "PUBLIC_ORDER_RATE_LIMIT_MAX"
    ),
    publicOrderRateLimitWindowMs: parsePositiveInt(
      env.PUBLIC_ORDER_RATE_LIMIT_WINDOW_MS,
      60_000,
      "PUBLIC_ORDER_RATE_LIMIT_WINDOW_MS"
    ),
    adminLoginRateLimitMax: parsePositiveInt(
      env.ADMIN_LOGIN_RATE_LIMIT_MAX,
      8,
      "ADMIN_LOGIN_RATE_LIMIT_MAX"
    ),
    adminLoginRateLimitWindowMs: parsePositiveInt(
      env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS,
      900_000,
      "ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS"
    ),
    visitorChatTtlDays: parsePositiveInt(
      env.VISITOR_CHAT_TTL_DAYS,
      30,
      "VISITOR_CHAT_TTL_DAYS"
    ),
    publicChatSessionRateLimitMax: parsePositiveInt(
      env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX,
      15,
      "PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX"
    ),
    publicChatSessionRateLimitWindowMs: parsePositiveInt(
      env.PUBLIC_CHAT_SESSION_RATE_LIMIT_WINDOW_MS,
      900_000,
      "PUBLIC_CHAT_SESSION_RATE_LIMIT_WINDOW_MS"
    ),
    publicChatMessageRateLimitMax: parsePositiveInt(
      env.PUBLIC_CHAT_MESSAGE_RATE_LIMIT_MAX,
      30,
      "PUBLIC_CHAT_MESSAGE_RATE_LIMIT_MAX"
    ),
    publicChatMessageRateLimitWindowMs: parsePositiveInt(
      env.PUBLIC_CHAT_MESSAGE_RATE_LIMIT_WINDOW_MS,
      60_000,
      "PUBLIC_CHAT_MESSAGE_RATE_LIMIT_WINDOW_MS"
    ),
    chatRetentionDays:
      env.CHAT_RETENTION_DAYS && env.CHAT_RETENTION_DAYS.trim() !== ""
        ? parsePositiveInt(env.CHAT_RETENTION_DAYS, 90, "CHAT_RETENTION_DAYS")
        : null
  };
}
