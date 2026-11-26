import { randomBytes } from "node:crypto";
import type { OrderStatus } from "@prisma/client";
import { conflictError, validationError } from "../../shared/errors.js";
import { parseVndString } from "../../shared/money.js";
import { sha256Bytes } from "../auth/crypto.js";

export const ALLOWED_ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ["confirmed", "cancelled"],
  confirmed: ["preparing", "cancelled"],
  preparing: ["shipping", "cancelled"],
  shipping: ["completed"],
  completed: [],
  cancelled: []
};

export function planOrderTransition(params: {
  currentStatus: OrderStatus;
  nextStatus: OrderStatus;
  subtotalVnd: bigint;
  rawShippingFeeVnd?: string;
}): {
  shippingFeeVnd?: bigint;
  totalVnd?: bigint;
} {
  const allowed = ALLOWED_ORDER_TRANSITIONS[params.currentStatus];
  if (!allowed.includes(params.nextStatus)) {
    throw conflictError(
      `Không thể chuyển trạng thái đơn từ "${params.currentStatus}" sang "${params.nextStatus}".`
    );
  }

  if (params.currentStatus === "new" && params.nextStatus === "confirmed") {
    if (params.rawShippingFeeVnd === undefined) {
      throw validationError("Cần nhập phí vận chuyển khi xác nhận đơn mới.", [
        { field: "shippingFeeVnd", reason: "required when confirming a new order" }
      ]);
    }
    const shippingFeeVnd = parseVndString(params.rawShippingFeeVnd, "shippingFeeVnd");
    return {
      shippingFeeVnd,
      totalVnd: params.subtotalVnd + shippingFeeVnd
    };
  }

  if (params.rawShippingFeeVnd !== undefined) {
    throw validationError(
      "Chỉ được gửi phí vận chuyển ở bước xác nhận đơn mới (new → confirmed).",
      [{ field: "shippingFeeVnd", reason: "only allowed for new -> confirmed transition" }]
    );
  }

  return {};
}

export function normalizePhone(rawPhone: string): {
  displayPhone: string;
  normalizedPhone: string;
} {
  const displayPhone = rawPhone.trim();
  if (!/^[0-9+\s().-]{9,25}$/.test(displayPhone)) {
    throw validationError("Số điện thoại người nhận không hợp lệ.", [
      { field: "recipient.phone", reason: "invalid phone number format" }
    ]);
  }

  let digits = displayPhone.replace(/\D/g, "");
  if (displayPhone.startsWith("+84") && digits.startsWith("84")) {
    digits = "0" + digits.slice(2);
  }
  if (digits.length < 9 || digits.length > 15) {
    throw validationError("Số điện thoại phải có từ 9 đến 15 chữ số.", [
      { field: "recipient.phone", reason: "phone must contain 9 to 15 digits" }
    ]);
  }

  return { displayPhone, normalizedPhone: digits };
}

export function normalizePhoneQuery(rawQuery: string): string {
  let digits = rawQuery.replace(/\D/g, "");
  if (rawQuery.trim().startsWith("+84") && digits.startsWith("84")) {
    digits = "0" + digits.slice(2);
  }
  return digits;
}

const ORDER_NO_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateOrderNo(now = new Date()): string {
  // Format date in Asia/Ho_Chi_Minh (UTC+7)
  const vnTime = new Date(now.getTime() + 7 * 3600 * 1000);
  const yyyy = vnTime.getUTCFullYear().toString();
  const mm = String(vnTime.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(vnTime.getUTCDate()).padStart(2, "0");

  const bytes = randomBytes(8);
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    const idx = (bytes[i] ?? 0) % ORDER_NO_ALPHABET.length;
    suffix += ORDER_NO_ALPHABET[idx];
  }
  return `MN-${yyyy}${mm}${dd}-${suffix}`;
}

export interface CreateOrderBodyInput {
  recipient: {
    name: string;
    phone: string;
    address: string;
  };
  items: Array<{
    productId: string;
    quantity: number;
  }>;
  note?: string | null;
}

export interface CanonicalOrderInput {
  recipientName: string;
  recipientPhone: string;
  recipientPhoneNorm: string;
  shippingAddress: string;
  customerNote: string | null;
  items: Array<{ productId: string; quantity: number }>;
  requestFingerprint: Uint8Array<ArrayBuffer>;
}

export function canonicalizeCreateOrderInput(body: CreateOrderBodyInput): CanonicalOrderInput {
  const recipientName = body.recipient.name.trim();
  if (recipientName.length < 1 || recipientName.length > 120) {
    throw validationError("Họ tên người nhận không hợp lệ.", [
      { field: "recipient.name", reason: "must be between 1 and 120 characters" }
    ]);
  }

  const { displayPhone, normalizedPhone } = normalizePhone(body.recipient.phone);

  const shippingAddress = body.recipient.address.trim();
  if (shippingAddress.length < 1 || shippingAddress.length > 500) {
    throw validationError("Địa chỉ giao hàng không hợp lệ.", [
      { field: "recipient.address", reason: "must be between 1 and 500 characters" }
    ]);
  }

  const rawNote = body.note?.trim() ?? "";
  if (rawNote.length > 1000) {
    throw validationError("Ghi chú vượt quá 1000 ký tự.", [
      { field: "note", reason: "must be at most 1000 characters" }
    ]);
  }
  const customerNote = rawNote.length > 0 ? rawNote : null;

  if (body.items.length < 1 || body.items.length > 20) {
    throw validationError("Đơn hàng phải có từ 1 đến 20 sản phẩm.", [
      { field: "items", reason: "must contain 1 to 20 items" }
    ]);
  }

  const seenIds = new Set<string>();
  const normalizedItems = body.items.map((item, idx) => {
    const productId = item.productId.toLowerCase();
    if (seenIds.has(productId)) {
      throw validationError("Danh sách sản phẩm bị trùng mã sản phẩm.", [
        { field: `items[${idx}].productId`, reason: "duplicate productId in items" }
      ]);
    }
    seenIds.add(productId);

    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000) {
      throw validationError("Số lượng sản phẩm phải từ 1 đến 1000.", [
        { field: `items[${idx}].quantity`, reason: "must be between 1 and 1000" }
      ]);
    }
    return { productId, quantity: item.quantity };
  });

  const sortedItemsForHash = [...normalizedItems].sort((a, b) =>
    a.productId.localeCompare(b.productId)
  );

  const canonicalPayload = JSON.stringify({
    recipient: {
      name: recipientName,
      phone: displayPhone,
      address: shippingAddress
    },
    items: sortedItemsForHash,
    note: customerNote
  });

  return {
    recipientName,
    recipientPhone: displayPhone,
    recipientPhoneNorm: normalizedPhone,
    shippingAddress,
    customerNote,
    items: normalizedItems,
    requestFingerprint: sha256Bytes(canonicalPayload)
  };
}
