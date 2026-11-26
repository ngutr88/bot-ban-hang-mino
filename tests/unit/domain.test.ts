import { describe, expect, it } from "vitest";
import {
  formatNullableVndBigInt,
  formatVndBigInt,
  parseVndString
} from "../../src/shared/money.js";
import {
  clampLimit,
  decodeTimestampIdCursor,
  encodeTimestampIdCursor
} from "../../src/shared/pagination.js";
import { matchBotReply } from "../../src/shared/bot-matcher.js";
import {
  canonicalizeCreateOrderInput,
  planOrderTransition
} from "../../src/modules/orders/order-domain.js";

describe("Money helpers (VND integer strings)", () => {
  it("parses valid non-negative integer strings and formats BigInt safely", () => {
    expect(parseVndString("0", "priceVnd")).toBe(0n);
    expect(parseVndString("125000", "priceVnd")).toBe(125000n);
    expect(formatVndBigInt(399000n)).toBe("399000");
    expect(formatNullableVndBigInt(null)).toBeNull();
    expect(formatNullableVndBigInt(30000n)).toBe("30000");
  });

  it("rejects negative, decimal, leading-zero, and non-numeric strings", () => {
    expect(() => parseVndString("-1000", "priceVnd")).toThrow();
    expect(() => parseVndString("12500.5", "priceVnd")).toThrow();
    expect(() => parseVndString("0125", "priceVnd")).toThrow();
    expect(() => parseVndString("abc", "priceVnd")).toThrow();
    expect(() => parseVndString(125000, "priceVnd")).toThrow();
  });
});

describe("Order status transitions & shipping fee rules", () => {
  it("requires non-negative shippingFeeVnd on new -> confirmed and computes total", () => {
    expect(() =>
      planOrderTransition({
        currentStatus: "new",
        nextStatus: "confirmed",
        subtotalVnd: 250000n
      })
    ).toThrow();

    const plan = planOrderTransition({
      currentStatus: "new",
      nextStatus: "confirmed",
      subtotalVnd: 250000n,
      rawShippingFeeVnd: "30000"
    });
    expect(plan).toEqual({
      shippingFeeVnd: 30000n,
      totalVnd: 280000n
    });
  });

  it("rejects shippingFeeVnd on non-confirmation transitions", () => {
    expect(() =>
      planOrderTransition({
        currentStatus: "confirmed",
        nextStatus: "preparing",
        subtotalVnd: 250000n,
        rawShippingFeeVnd: "15000"
      })
    ).toThrow();
  });

  it("enforces allowed state machine transitions and terminal states", () => {
    expect(
      planOrderTransition({
        currentStatus: "confirmed",
        nextStatus: "preparing",
        subtotalVnd: 100000n
      })
    ).toEqual({});

    expect(
      planOrderTransition({
        currentStatus: "shipping",
        nextStatus: "completed",
        subtotalVnd: 100000n
      })
    ).toEqual({});

    expect(() =>
      planOrderTransition({
        currentStatus: "shipping",
        nextStatus: "cancelled",
        subtotalVnd: 100000n
      })
    ).toThrow();

    expect(() =>
      planOrderTransition({
        currentStatus: "completed",
        nextStatus: "cancelled",
        subtotalVnd: 100000n
      })
    ).toThrow();
  });
});

describe("Bot keyword & product matcher", () => {
  const products = [
    {
      id: "22222222-2222-4222-8222-222222222202",
      name: "Nến thơm vanilla",
      priceVnd: "185000",
      emoji: "🕯️",
      description: "Cháy 35 giờ."
    }
  ];

  it("reports listed product price without falsely claiming stock availability", () => {
    const reply = matchBotReply({
      message: "Shop ơi nến thơm vanilla còn hàng không?",
      products,
      rules: [],
      fallbackReply: "Fallback"
    });
    expect(reply).toContain("185.000đ");
    expect(reply).toContain("đang được niêm yết");
    expect(reply.toLowerCase()).not.toContain("bên em còn hàng nha");
  });

  it("orders rules by priority ASC and breaks ties deterministically by id ASC", () => {
    const reply = matchBotReply({
      message: "Cho mình hỏi ship nội thành",
      products,
      rules: [
        {
          id: "33333333-3333-4333-8333-333333333302",
          keywords: ["ship"],
          answer: "Rule B",
          priority: 10
        },
        {
          id: "33333333-3333-4333-8333-333333333301",
          keywords: ["ship"],
          answer: "Rule A",
          priority: 10
        },
        {
          id: "33333333-3333-4333-8333-333333333300",
          keywords: ["đổi trả"],
          answer: "Rule Early Unmatched",
          priority: 1
        }
      ],
      fallbackReply: "Fallback"
    });
    expect(reply).toBe("Rule A");
  });

  it("returns fallbackReply when nothing matches", () => {
    const reply = matchBotReply({
      message: "Câu hỏi bất kỳ ngoài kịch bản",
      products,
      rules: [{ keywords: ["ship"], answer: "Ship COD", priority: 10 }],
      fallbackReply: "Nhờ chủ shop hỗ trợ"
    });
    expect(reply).toBe("Nhờ chủ shop hỗ trợ");
  });
});

describe("Pagination & canonical order input", () => {
  it("encodes/decodes valid cursor and rejects tampered cursors", () => {
    const now = new Date("2026-11-26T10:00:00.000Z");
    const id = "2bc6c6fa-863c-41f9-8b17-60e8f0b71b0d";
    const encoded = encodeTimestampIdCursor(now, id);
    const decoded = decodeTimestampIdCursor(encoded);
    expect(decoded.id).toBe(id);
    expect(decoded.createdAt.toISOString()).toBe(now.toISOString());

    expect(() => decodeTimestampIdCursor("not-a-valid-cursor")).toThrow();
    expect(() => clampLimit(0)).toThrow();
    expect(() => clampLimit(101)).toThrow();
    expect(clampLimit(undefined)).toBe(25);
  });

  it("produces identical fingerprint regardless of item order and rejects duplicate productIds", () => {
    const a = canonicalizeCreateOrderInput({
      recipient: { name: " Nguyễn Văn A ", phone: "0901234567", address: "Quận 1, TP.HCM" },
      items: [
        { productId: "22222222-2222-4222-8222-222222222202", quantity: 1 },
        { productId: "22222222-2222-4222-8222-222222222201", quantity: 2 }
      ],
      note: " Giao sáng "
    });

    const b = canonicalizeCreateOrderInput({
      recipient: { name: "Nguyễn Văn A", phone: "0901234567", address: "Quận 1, TP.HCM" },
      items: [
        { productId: "22222222-2222-4222-8222-222222222201", quantity: 2 },
        { productId: "22222222-2222-4222-8222-222222222202", quantity: 1 }
      ],
      note: "Giao sáng"
    });

    expect(Buffer.from(a.requestFingerprint).equals(Buffer.from(b.requestFingerprint))).toBe(true);

    expect(() =>
      canonicalizeCreateOrderInput({
        recipient: { name: "A", phone: "0901234567", address: "HCM" },
        items: [
          { productId: "22222222-2222-4222-8222-222222222201", quantity: 1 },
          { productId: "22222222-2222-4222-8222-222222222201", quantity: 2 }
        ]
      })
    ).toThrow();
  });
});
