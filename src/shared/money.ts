import { validationError } from "./errors.js";

export const VND_STRING_REGEX = /^(0|[1-9][0-9]{0,14})$/;
const MAX_SAFE_VND = 900_000_000_000_000n;

export function parseVndString(value: unknown, fieldName: string): bigint {
  if (typeof value !== "string" || !VND_STRING_REGEX.test(value)) {
    throw validationError("Số tiền VND không hợp lệ.", [
      { field: fieldName, reason: "must be a non-negative integer string" }
    ]);
  }
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > MAX_SAFE_VND) {
    throw validationError("Số tiền VND vượt giới hạn cho phép.", [
      { field: fieldName, reason: "out of allowed VND range" }
    ]);
  }
  return parsed;
}

export function formatVndBigInt(value: bigint): string {
  return value.toString(10);
}

export function formatNullableVndBigInt(value: bigint | null): string | null {
  return value === null ? null : value.toString(10);
}
