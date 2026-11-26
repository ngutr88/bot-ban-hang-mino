import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { createAdminUser } from "../../src/modules/auth/auth.service.js";
import { SEED_PRODUCTS, seedDemoData } from "../../prisma/seed.js";
import { createTestDatabase, type TestDbContext } from "../helpers/test-db.js";

const APP_ORIGIN = "http://localhost:3000";
const ADMIN_EMAIL = "owner@mino.local";
const ADMIN_PASSWORD = "StrongAdminPassword!2026";

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("Missing set-cookie header");
  return raw.split(";")[0] ?? "";
}

describe("Mino M1 Integration, Security, Contract & E2E Flow", () => {
  let dbCtx: TestDbContext;
  let app: FastifyInstance;
  let shopId: string;
  const capturedLogs: string[] = [];

  beforeAll(async () => {
    dbCtx = await createTestDatabase();

    // Seed twice to verify seed idempotency (M1.2 acceptance criterion)
    const firstSeed = await seedDemoData(dbCtx.prisma);
    const secondSeed = await seedDemoData(dbCtx.prisma);
    expect(secondSeed.shopId).toBe(firstSeed.shopId);
    shopId = firstSeed.shopId;

    await createAdminUser(dbCtx.prisma, {
      shopId,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD
    });

    const config = loadConfig({
      NODE_ENV: "test",
      PORT: "3000",
      APP_BASE_URL: APP_ORIGIN,
      DATABASE_URL: dbCtx.databaseUrl,
      SESSION_SECRET: "test-session-secret-with-more-than-32-bytes-entropy-2026",
      LOG_LEVEL: "info",
      ADMIN_LOGIN_RATE_LIMIT_MAX: "5",
      ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: "60000",
      PUBLIC_ORDER_RATE_LIMIT_MAX: "25",
      PUBLIC_ORDER_RATE_LIMIT_WINDOW_MS: "60000"
    });

    // Attach real Pino log sink to verify zero PII/secret leakage in logs
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        capturedLogs.push(chunk.toString("utf8"));
        callback();
      }
    });

    app = await buildApp({ prisma: dbCtx.prisma, config, loggerStream: logStream });

    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  it("serves health endpoints, static storefront pages, and 404 JSON envelope on unknown API routes", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    expect(live.json().data).toEqual({ status: "ok" });
    expect(live.headers["x-request-id"]).toBeTruthy();
    expect(live.headers["x-frame-options"]).toBe("DENY");

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data).toEqual({ status: "ready" });

    const htmlRes = await app.inject({ method: "GET", url: "/" });
    expect(htmlRes.statusCode).toBe(200);
    expect(htmlRes.headers["content-type"]).toContain("text/html");
    expect(htmlRes.body).toContain("Cửa hàng của Mino");

    const unknownApi = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.json().error.code).toBe("NOT_FOUND");
  });

  it("exposes only allowlisted public shop, active products, and enabled bot rules", async () => {
    const shopRes = await app.inject({ method: "GET", url: "/api/v1/public/shop" });
    expect(shopRes.statusCode).toBe(200);
    const shopData = shopRes.json().data;
    expect(shopData).toEqual({
      name: "Cửa hàng của Mino",
      publicPhone: "0900 000 000",
      publicAddress: "Số 1 Đường Hoa, Phường BV, TP. Hồ Chí Minh",
      botName: "Mino",
      fallbackReply: expect.any(String),
      currency: "VND"
    });
    expect(shopData.id).toBeUndefined();

    const prodRes = await app.inject({ method: "GET", url: "/api/v1/public/products?limit=3" });
    expect(prodRes.statusCode).toBe(200);
    const prodJson = prodRes.json();
    expect(prodJson.data).toHaveLength(3);
    expect(prodJson.nextCursor).toBeTruthy();
    expect(prodJson.data[0]).toEqual({
      id: SEED_PRODUCTS[0].id,
      name: SEED_PRODUCTS[0].name,
      description: SEED_PRODUCTS[0].description,
      priceVnd: "129000",
      emoji: SEED_PRODUCTS[0].emoji
    });
    expect(prodJson.data[0].status).toBeUndefined();

    const rulesRes = await app.inject({ method: "GET", url: "/api/v1/public/bot-rules" });
    expect(rulesRes.statusCode).toBe(200);
    const firstRule = rulesRes.json().data[0];
    expect(firstRule).toEqual({
      keywords: expect.any(Array),
      answer: expect.any(String),
      priority: 10
    });
    expect(firstRule.id).toBeUndefined();
  });

  it("blocks anonymous access to all admin endpoints with 401", async () => {
    const targets = [
      { method: "GET" as const, url: "/api/v1/admin/session" },
      { method: "GET" as const, url: "/api/v1/admin/shop" },
      { method: "PATCH" as const, url: "/api/v1/admin/shop" },
      { method: "GET" as const, url: "/api/v1/admin/products" },
      { method: "GET" as const, url: "/api/v1/admin/bot-rules" },
      { method: "GET" as const, url: "/api/v1/admin/orders" }
    ];

    for (const t of targets) {
      const res = await app.inject({ method: t.method, url: t.url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("enforces admin login, HttpOnly cookie, CSRF token, Origin check, cross-shop isolation, and logout revocation", async () => {
    // Generic 401 on wrong email vs wrong password
    const badEmail = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      headers: { origin: APP_ORIGIN },
      payload: { email: "nobody@mino.local", password: "wrong-password" }
    });
    const badPass = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      headers: { origin: APP_ORIGIN },
      payload: { email: ADMIN_EMAIL, password: "wrong-password" }
    });
    expect(badEmail.statusCode).toBe(401);
    expect(badPass.statusCode).toBe(401);
    expect(badEmail.json().error.message).toBe(badPass.json().error.message);

    // Valid login
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      headers: { origin: APP_ORIGIN },
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    });
    expect(loginRes.statusCode).toBe(200);
    const rawSetCookie = String(loginRes.headers["set-cookie"]);
    expect(rawSetCookie).toContain("mino_session=");
    expect(rawSetCookie).toContain("HttpOnly");
    expect(rawSetCookie).toContain("SameSite=Lax");

    const cookieHeader = extractSessionCookie(loginRes.headers["set-cookie"]);
    const { csrfToken, user } = loginRes.json().data;
    expect(csrfToken).toBeTruthy();
    expect(user.email).toBe(ADMIN_EMAIL);
    expect(loginRes.json().data.rawSessionToken).toBeUndefined();

    // Missing CSRF rejected with 403
    const noCsrf = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/shop",
      headers: { cookie: cookieHeader, origin: APP_ORIGIN },
      payload: { botName: "Mino2" }
    });
    expect(noCsrf.statusCode).toBe(403);

    // Cross-origin CSRF attempt rejected with 403
    const badOrigin = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/shop",
      headers: {
        cookie: cookieHeader,
        origin: "https://attacker.example",
        "x-csrf-token": csrfToken
      },
      payload: { botName: "Hacked" }
    });
    expect(badOrigin.statusCode).toBe(403);

    // Cross-shop tenant isolation: create second shop + product directly in DB
    const otherShop = await dbCtx.prisma.shop.create({
      data: {
        name: "Other Shop",
        botName: "BotB",
        fallbackReply: "Fallback B"
      }
    });
    const otherProduct = await dbCtx.prisma.product.create({
      data: {
        shopId: otherShop.id,
        name: "Secret Product",
        priceVnd: 50000n,
        status: "active"
      }
    });

    const crossShopPatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/products/${otherProduct.id}`,
      headers: {
        cookie: cookieHeader,
        origin: APP_ORIGIN,
        "x-csrf-token": csrfToken
      },
      payload: { name: "Tampered" }
    });
    expect(crossShopPatch.statusCode).toBe(404);

    // Logout revokes session immediately
    const logoutRes = await app.inject({
      method: "DELETE",
      url: "/api/v1/admin/session",
      headers: {
        cookie: cookieHeader,
        origin: APP_ORIGIN,
        "x-csrf-token": csrfToken
      }
    });
    expect(logoutRes.statusCode).toBe(204);

    const replayAfterLogout = await app.inject({
      method: "GET",
      url: "/api/v1/admin/session",
      headers: { cookie: cookieHeader }
    });
    expect(replayAfterLogout.statusCode).toBe(401);
  });

  it("handles full E2E flow: catalog hide/update, XSS text safety, COD order creation, price-tamper rejection, idempotency, snapshot preservation, and status transitions", async () => {
    // Login fresh admin session
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      headers: { origin: APP_ORIGIN },
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    });
    const cookie = extractSessionCookie(loginRes.headers["set-cookie"]);
    const csrf = loginRes.json().data.csrfToken as string;

    // Create a new product and hide another product
    const createProdRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/products",
      headers: { cookie, origin: APP_ORIGIN, "x-csrf-token": csrf },
      payload: {
        name: "Bình giữ nhiệt <script>alert(1)</script>",
        priceVnd: "210000",
        emoji: "🥤",
        description: "Giữ nóng lạnh 12h",
        status: "active"
      }
    });
    expect(createProdRes.statusCode).toBe(201);
    const newProdId = createProdRes.json().data.id as string;

    // Hide a seeded product and ensure customer cannot order it
    const hiddenProdId = SEED_PRODUCTS[7].id;
    const hideRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/products/${hiddenProdId}`,
      headers: { cookie, origin: APP_ORIGIN, "x-csrf-token": csrf },
      payload: { status: "hidden" }
    });
    expect(hideRes.statusCode).toBe(200);

    // Public products must NOT include hidden product
    const publicProds = await app.inject({
      method: "GET",
      url: "/api/v1/public/products?limit=100"
    });
    const publicIds = (publicProds.json().data as Array<{ id: string }>).map((p) => p.id);
    expect(publicIds).toContain(newProdId);
    expect(publicIds).not.toContain(hiddenProdId);

    // Ordering hidden product returns 409 CONFLICT
    const orderHiddenRes = await app.inject({
      method: "POST",
      url: "/api/v1/public/orders",
      headers: { "idempotency-key": "idem-hidden-product-001" },
      payload: {
        recipient: {
          name: "Trần Thị B",
          phone: "0912345678",
          address: "12 Lê Lợi, Q.1, TP.HCM"
        },
        items: [{ productId: hiddenProdId, quantity: 1 }]
      }
    });
    expect(orderHiddenRes.statusCode).toBe(409);

    // Price tampering / unknown field in order body rejected with 400 VALIDATION_ERROR
    const tamperedOrderRes = await app.inject({
      method: "POST",
      url: "/api/v1/public/orders",
      headers: { "idempotency-key": "idem-tampered-001" },
      payload: {
        recipient: {
          name: "Hacker",
          phone: "0912345678",
          address: "12 Lê Lợi, Q.1, TP.HCM"
        },
        items: [{ productId: newProdId, quantity: 2, priceVnd: "1" }],
        totalVnd: "2"
      }
    });
    expect(tamperedOrderRes.statusCode).toBe(400);
    expect(tamperedOrderRes.json().error.code).toBe("VALIDATION_ERROR");

    // Missing Idempotency-Key rejected with 400
    const missingKeyRes = await app.inject({
      method: "POST",
      url: "/api/v1/public/orders",
      payload: {
        recipient: {
          name: "Khách A",
          phone: "0988777666",
          address: "99 Nguyễn Huệ, Quận 1, TP.HCM"
        },
        items: [{ productId: newProdId, quantity: 2 }]
      }
    });
    expect(missingKeyRes.statusCode).toBe(400);

    // Valid customer order (anonymous browser)
    const validOrderPayload = {
      recipient: {
        name: "Lê Minh Khôi",
        phone: "0988 777 666",
        address: "99 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh"
      },
      items: [
        { productId: newProdId, quantity: 2 }, // 2 * 210,000 = 420,000
        { productId: SEED_PRODUCTS[0].id, quantity: 1 } // 1 * 129,000 = 129,000 -> subtotal = 549,000
      ],
      note: "Giao giờ hành chính <img src=x onerror=alert(1)>"
    };

    const createOrderRes = await app.inject({
      method: "POST",
      url: "/api/v1/public/orders",
      headers: { "idempotency-key": "idem-valid-order-2026-001" },
      payload: validOrderPayload
    });
    expect(createOrderRes.statusCode).toBe(201);
    const createdOrderPublic = createOrderRes.json().data;
    expect(createdOrderPublic).toEqual({
      orderNo: expect.stringMatching(/^MN-\d{8}-[A-Z0-9]{8}$/),
      status: "new",
      subtotalVnd: "549000",
      shippingFeeVnd: null,
      totalVnd: null,
      createdAt: expect.any(String)
    });
    // Public response omits phone and address
    expect(createdOrderPublic.recipient).toBeUndefined();
    expect(createdOrderPublic.recipientPhone).toBeUndefined();

    // Idempotent replay (same key + same payload) returns 200 and exact same orderNo
    const replaySameRes = await app.inject({
      method: "POST",
      url: "/api/v1/public/orders",
      headers: { "idempotency-key": "idem-valid-order-2026-001" },
      payload: validOrderPayload
    });
    expect(replaySameRes.statusCode).toBe(200);
    expect(replaySameRes.json().data.orderNo).toBe(createdOrderPublic.orderNo);

    // Idempotent key reuse with different payload returns 409 CONFLICT
    const replayDiffRes = await app.inject({
      method: "POST",
      url: "/api/v1/public/orders",
      headers: { "idempotency-key": "idem-valid-order-2026-001" },
      payload: {
        ...validOrderPayload,
        items: [{ productId: newProdId, quantity: 3 }]
      }
    });
    expect(replayDiffRes.statusCode).toBe(409);

    // Change product price AFTER order was placed -> historic order snapshot must NOT change
    const changePriceRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/products/${newProdId}`,
      headers: { cookie, origin: APP_ORIGIN, "x-csrf-token": csrf },
      payload: { priceVnd: "299000" }
    });
    expect(changePriceRes.statusCode).toBe(200);

    // Admin searches order by normalized phone digits
    const listOrdersRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/orders?q=0988777666&limit=10",
      headers: { cookie }
    });
    expect(listOrdersRes.statusCode).toBe(200);
    const listItems = listOrdersRes.json().data as Array<{
      id: string;
      orderNo: string;
      subtotalVnd: string;
      idempotencyKey?: string;
    }>;
    expect(listItems).toHaveLength(1);
    expect(listItems[0]?.orderNo).toBe(createdOrderPublic.orderNo);
    expect(listItems[0]?.subtotalVnd).toBe("549000");
    expect(listItems[0]?.idempotencyKey).toBeUndefined();

    const orderId = listItems[0]!.id;

    // Confirming order without shippingFeeVnd fails with 400
    const confirmMissingShip = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/orders/${orderId}`,
      headers: { cookie, origin: APP_ORIGIN, "x-csrf-token": csrf },
      payload: { status: "confirmed" }
    });
    expect(confirmMissingShip.statusCode).toBe(400);

    // Confirming order with shippingFeeVnd = "30000" sets totalVnd = "579000" and records audit event
    const confirmOk = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/orders/${orderId}`,
      headers: { cookie, origin: APP_ORIGIN, "x-csrf-token": csrf },
      payload: {
        status: "confirmed",
        shippingFeeVnd: "30000",
        note: "Đã gọi xác nhận phí ship 30k"
      }
    });
    expect(confirmOk.statusCode).toBe(200);
    expect(confirmOk.json().data.status).toBe("confirmed");
    expect(confirmOk.json().data.shippingFeeVnd).toBe("30000");
    expect(confirmOk.json().data.totalVnd).toBe("579000");

    // Passing shippingFeeVnd on confirmed -> preparing is rejected with 400
    const modifyShipAfterConfirm = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/orders/${orderId}`,
      headers: { cookie, origin: APP_ORIGIN, "x-csrf-token": csrf },
      payload: { status: "preparing", shippingFeeVnd: "0" }
    });
    expect(modifyShipAfterConfirm.statusCode).toBe(400);

    // Walk remaining lifecycle: confirmed -> preparing -> shipping -> completed
    for (const nextStatus of ["preparing", "shipping", "completed"] as const) {
      const stepRes = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/orders/${orderId}`,
        headers: { cookie, origin: APP_ORIGIN, "x-csrf-token": csrf },
        payload: { status: nextStatus }
      });
      expect(stepRes.statusCode).toBe(200);
      expect(stepRes.json().data.status).toBe(nextStatus);
    }

    // Terminal state rejects further transition with 409 CONFLICT
    const cancelCompleted = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/orders/${orderId}`,
      headers: { cookie, origin: APP_ORIGIN, "x-csrf-token": csrf },
      payload: { status: "cancelled" }
    });
    expect(cancelCompleted.statusCode).toBe(409);

    // Verify full order detail preserves item snapshot price ("210000", not "299000") and full event history
    const detailRes = await app.inject({
      method: "GET",
      url: `/api/v1/admin/orders/${orderId}`,
      headers: { cookie }
    });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json().data;
    const cupItem = (detail.items as Array<{ productId: string; unitPriceVnd: string }>).find(
      (i) => i.productId === newProdId
    );
    expect(cupItem?.unitPriceVnd).toBe("210000");
    expect(detail.events).toHaveLength(5); // 1 created + 4 transitions

    // Verify captured logs contain zero PII or credentials
    const combinedLogs = capturedLogs.join("\n");
    expect(combinedLogs).not.toContain(ADMIN_PASSWORD);
    expect(combinedLogs).not.toContain("0988 777 666");
    expect(combinedLogs).not.toContain("99 Nguyễn Huệ");
  });

  it("rate-limits repeated admin login attempts with 429 RATE_LIMITED", async () => {
    let saw429 = false;
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/admin/session",
        remoteAddress: "198.51.100.77",
        headers: { origin: APP_ORIGIN },
        payload: { email: ADMIN_EMAIL, password: "wrong-password-attempt" }
      });
      if (res.statusCode === 429) {
        saw429 = true;
        expect(res.json().error.code).toBe("RATE_LIMITED");
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});
