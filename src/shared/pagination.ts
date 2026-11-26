import { validationError } from "./errors.js";

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

export function clampLimit(rawLimit: number | undefined): number {
  if (rawLimit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT) {
    throw validationError("Tham số phân trang không hợp lệ.", [
      { field: "limit", reason: `must be an integer between 1 and ${MAX_PAGE_LIMIT}` }
    ]);
  }
  return rawLimit;
}

export function encodeCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor<T>(
  rawCursor: string,
  validate: (parsed: unknown) => T | null
): T {
  try {
    const json = Buffer.from(rawCursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    const validated = validate(parsed);
    if (validated === null) {
      throw new Error("Invalid cursor shape");
    }
    return validated;
  } catch {
    throw validationError("Con trỏ phân trang (cursor) không hợp lệ.", [
      { field: "cursor", reason: "invalid cursor" }
    ]);
  }
}

export interface TimestampIdCursor {
  createdAt: Date;
  id: string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeTimestampIdCursor(createdAt: Date, id: string): string {
  return encodeCursor({ createdAt: createdAt.toISOString(), id });
}

export function decodeTimestampIdCursor(rawCursor: string): TimestampIdCursor {
  return decodeCursor(rawCursor, (parsed) => {
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.createdAt !== "string" || typeof obj.id !== "string") return null;
    if (!UUID_REGEX.test(obj.id)) return null;
    const date = new Date(obj.createdAt);
    if (Number.isNaN(date.getTime())) return null;
    return { createdAt: date, id: obj.id };
  });
}
