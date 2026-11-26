import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

const ARGON2_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  outputLen: 32,
  parallelism: 1
} as const;

let cachedDummyPasswordHash: string | null = null;

export async function hashPassword(plainPassword: string): Promise<string> {
  return hash(plainPassword, ARGON2_OPTIONS);
}

export async function verifyPassword(
  passwordHash: string,
  plainPassword: string
): Promise<boolean> {
  try {
    return await verify(passwordHash, plainPassword);
  } catch {
    return false;
  }
}

export async function verifyDummyPassword(plainPassword: string): Promise<void> {
  if (!cachedDummyPasswordHash) {
    cachedDummyPasswordHash = await hashPassword("dummy-password-for-constant-time-check");
  }
  await verifyPassword(cachedDummyPasswordHash, plainPassword);
}

export function generateOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function sha256Bytes(value: string): Uint8Array<ArrayBuffer> {
  const digest = createHash("sha256").update(value, "utf8").digest();
  const ab = new ArrayBuffer(digest.byteLength);
  const out = new Uint8Array(ab);
  out.set(digest);
  return out;
}

export function deriveCsrfToken(sessionSecret: string, rawSessionToken: string): string {
  return createHmac("sha256", sessionSecret)
    .update(`mino-csrf-v1:${rawSessionToken}`, "utf8")
    .digest("base64url");
}

export function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return timingSafeEqual(a, b);
}
