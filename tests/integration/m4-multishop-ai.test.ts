import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { createAdminUser } from "../../src/modules/auth/auth.service.js";
import { seedDemoData } from "../../prisma/seed.js";
import { createTestDatabase, type TestDbContext } from "../helpers/test-db.js";

const APP_ORIGIN = "http://localhost:3000";
const OWNER_EMAIL = "owner-m4@mino.local";
const OWNER_PASSWORD = "StrongOwnerPassword!2026";
const STAFF_EMAIL = "staff-m4@mino.local";
const STAFF_PASSWORD = "StrongStaffPassword!2026";
const AI_API_KEY = "sk-test-controlled-ai-secret-do-not-log";

function extractCookiePair(
  setCookieHeader: string | string[] | undefined,
  cookieName: string
): string {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
    ? [setCookieHeader]
    : [];
  const found = list.find((c) => c.startsWith(`${cookieName}=`));
  if (!found) throw new Error(`Missing cookie ${cookieName}`);
  return found.split(";")[0] ?? "";
}

describe("Mino M4 Multi-Shop RBAC, Invitations, Audit Logs & Controlled Grounded AI", () => {
  let dbCtx: TestDbContext;
  let app: FastifyInstance;
  let shop1Id: string;
  const capturedLogs: string[] = [];

  // Mock LLM responses for Controlled AI testing
  let nextMockAiJson: {
    answer: string;
    confidence: number;
    needsHuman: boolean;
  } = {
    answer: "Dạ Trà Ô Long Thượng Hạng đang niêm yết giá 95.000đ ạ!",
    confidence: 0.92,
    needsHuman: false
  };
  let aiCallCount = 0;

  const mockAiFetch: typeof fetch = async () => {
    aiCallCount++;
    return new Response(
      JSON.stringify({
        model: "gpt-4o-mini",
        choices: [
          {
            message: {
              content: JSON.stringify(nextMockAiJson)
            }
          }
        ],
        usage: {
          prompt_tokens: 180,
          completion_tokens: 45
        }
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

  beforeAll(async () => {
    dbCtx = await createTestDatabase();
    const seeded = await seedDemoData(dbCtx.prisma);
    shop1Id = seeded.shopId;

    await createAdminUser(dbCtx.prisma, {
      shopId: shop1Id,
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
      role: "owner"
    });

    const config = loadConfig({
      NODE_ENV: "test",
      PORT: "3000",
      APP_BASE_URL: APP_ORIGIN,
      DATABASE_URL: dbCtx.databaseUrl,
      SESSION_SECRET: "m4-test-session-secret-with-more-than-32-bytes-entropy",
      LOG_LEVEL: "info",
      AI_API_KEY,
      AI_MODEL: "gpt-4o-mini"
    });

    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        capturedLogs.push(chunk.toString("utf8"));
        callback();
      }
    });

    app = await buildApp({
      prisma: dbCtx.prisma,
      config,
      loggerStream: logStream,
      aiFetchFn: mockAiFetch
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  it("enforces multi-shop tenant isolation, staff vs owner RBAC, member invite/revoke, audit logs, and AI anti-hallucination guardrails", async () => {
    // 1. Owner logs in (starts on Shop 1)
    const ownerLogin = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      headers: { origin: APP_ORIGIN },
      payload: { email: OWNER_EMAIL, password: OWNER_PASSWORD }
    });
    expect(ownerLogin.statusCode).toBe(200);
    const ownerCookie = extractCookiePair(
      ownerLogin.headers["set-cookie"],
      "mino_session"
    );
    const ownerCsrf = ownerLogin.json().data.csrfToken as string;
    expect(ownerLogin.json().data.user.role).toBe("owner");

    // 2. Owner creates a second tenant shop ("Tiệm Trà Xanh", slug: "tiem-tra-xanh")
    const createShop2 = await app.inject({
      method: "POST",
      url: "/api/v1/admin/shops",
      headers: {
        cookie: ownerCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": ownerCsrf
      },
      payload: {
        name: "Tiệm Trà Xanh",
        slug: "tiem-tra-xanh",
        botName: "Trà Bot",
        fallbackReply: "Dạ để chủ tiệm trà tư vấn thêm cho anh/chị nhé!"
      }
    });
    expect(createShop2.statusCode).toBe(201);
    const shop2Id = createShop2.json().data.id as string;

    // Switch Owner's active session to Shop 2
    const switchToShop2 = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session/switch-shop",
      headers: {
        cookie: ownerCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": ownerCsrf
      },
      payload: { shopId: shop2Id }
    });
    expect(switchToShop2.statusCode).toBe(200);
    expect(switchToShop2.json().data.user.shopId).toBe(shop2Id);
    expect(switchToShop2.json().data.memberships).toHaveLength(2);

    // Create a product in Shop 2 ("Trà Ô Long Thượng Hạng", 95,000đ)
    const createTeaProd = await app.inject({
      method: "POST",
      url: "/api/v1/admin/products",
      headers: {
        cookie: ownerCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": ownerCsrf
      },
      payload: {
        name: "Trà Ô Long Thượng Hạng",
        priceVnd: "95000",
        emoji: "🍵",
        description: "Trà nguyên lá vùng cao Lộc Phát",
        status: "active"
      }
    });
    expect(createTeaProd.statusCode).toBe(201);
    const teaProductId = createTeaProd.json().data.id as string;

    // 3. Verify Public Storefront Multi-Shop Isolation (?shop=tiem-tra-xanh vs default Shop 1)
    const shop2PublicProds = await app.inject({
      method: "GET",
      url: "/api/v1/public/products?shop=tiem-tra-xanh"
    });
    expect(shop2PublicProds.statusCode).toBe(200);
    expect(shop2PublicProds.json().data).toHaveLength(1);
    expect(shop2PublicProds.json().data[0].name).toBe("Trà Ô Long Thượng Hạng");

    const shop1PublicProds = await app.inject({
      method: "GET",
      url: "/api/v1/public/products"
    });
    const shop1Names = (
      shop1PublicProds.json().data as Array<{ name: string }>
    ).map((p) => p.name);
    expect(shop1Names).not.toContain("Trà Ô Long Thượng Hạng");

    // Place a COD order on Shop 2
    const shop2OrderRes = await app.inject({
      method: "POST",
      url: "/api/v1/public/orders?shop=tiem-tra-xanh",
      headers: { "idempotency-key": "m4-shop2-order-001" },
      payload: {
        recipient: {
          name: "Khách Tiệm Trà",
          phone: "0944 555 666",
          address: "25 Trần Phú, Đà Lạt"
        },
        items: [{ productId: teaProductId, quantity: 2 }]
      }
    });
    expect(shop2OrderRes.statusCode).toBe(201);
    expect(shop2OrderRes.json().data.subtotalVnd).toBe("190000");

    // 4. Invite Staff member to Shop 2, accept invitation, and verify Staff RBAC boundaries
    const inviteRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/invitations",
      headers: {
        cookie: ownerCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": ownerCsrf
      },
      payload: { email: STAFF_EMAIL, role: "staff" }
    });
    expect(inviteRes.statusCode).toBe(201);
    const rawInviteToken = inviteRes.json().data.inviteToken as string;
    expect(rawInviteToken.length).toBeGreaterThan(20);

    const acceptRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/invitations/accept",
      headers: { origin: APP_ORIGIN },
      payload: {
        inviteToken: rawInviteToken,
        password: STAFF_PASSWORD
      }
    });
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json().data.role).toBe("staff");

    // Staff logs in -> scoped to Shop 2 with role="staff"
    const staffLogin = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      headers: { origin: APP_ORIGIN },
      payload: { email: STAFF_EMAIL, password: STAFF_PASSWORD }
    });
    expect(staffLogin.statusCode).toBe(200);
    const staffCookie = extractCookiePair(
      staffLogin.headers["set-cookie"],
      "mino_session"
    );
    const staffCsrf = staffLogin.json().data.csrfToken as string;
    expect(staffLogin.json().data.user.role).toBe("staff");
    expect(staffLogin.json().data.user.shopId).toBe(shop2Id);

    // Staff CAN list & confirm orders in Shop 2
    const staffOrdersRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/orders",
      headers: { cookie: staffCookie }
    });
    expect(staffOrdersRes.statusCode).toBe(200);
    expect(staffOrdersRes.json().data).toHaveLength(1);
    const shop2OrderId = staffOrdersRes.json().data[0].id as string;

    const staffConfirmOrder = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/orders/${shop2OrderId}`,
      headers: {
        cookie: staffCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": staffCsrf
      },
      payload: { status: "confirmed", shippingFeeVnd: "25000" }
    });
    expect(staffConfirmOrder.statusCode).toBe(200);

    // Staff CANNOT create products, change AI settings, invite members, read audit logs, or switch to Shop 1!
    const staffCreateProd = await app.inject({
      method: "POST",
      url: "/api/v1/admin/products",
      headers: {
        cookie: staffCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": staffCsrf
      },
      payload: { name: "Unauthorized", priceVnd: "10000" }
    });
    expect(staffCreateProd.statusCode).toBe(403);

    const staffSwitchShop1 = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session/switch-shop",
      headers: {
        cookie: staffCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": staffCsrf
      },
      payload: { shopId: shop1Id }
    });
    expect(staffSwitchShop1.statusCode).toBe(403);

    const staffAuditLogs = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit-logs",
      headers: { cookie: staffCookie }
    });
    expect(staffAuditLogs.statusCode).toBe(403);

    // 5. Controlled Grounded AI & Anti-Hallucination Guardrails on Shop 2 Web Chat
    const startChat = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions?shop=tiem-tra-xanh"
    });
    expect(startChat.statusCode).toBe(201);
    const visitorShop2Cookie = extractCookiePair(
      startChat.headers["set-cookie"],
      "mino_visitor_chat_tiem-tra-xanh"
    );

    // While AI is disabled by default -> unmatched question does NOT call LLM
    const msgBeforeAi = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages?shop=tiem-tra-xanh",
      headers: {
        cookie: visitorShop2Cookie,
        "idempotency-key": "m4-chat-001"
      },
      payload: { body: "Tiệm có loại trà vùng cao nào uống dịu nhẹ buổi tối?" }
    });
    expect(msgBeforeAi.statusCode).toBe(201);
    expect(aiCallCount).toBe(0);
    expect(msgBeforeAi.json().data.session.status).toBe("waiting_shop");

    // Owner enables Controlled AI on Shop 2 for web channel
    const enableAiRes = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/ai/settings",
      headers: {
        cookie: ownerCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": ownerCsrf
      },
      payload: {
        aiEnabled: true,
        aiChannels: ["web"],
        aiDailyTokenBudget: 5000
      }
    });
    expect(enableAiRes.statusCode).toBe(200);
    expect(enableAiRes.json().data.aiEnabled).toBe(true);

    // Case A: Grounded AI reply citing exact authoritative price (95.000đ) -> ALLOWED!
    nextMockAiJson = {
      answer: "Dạ tiệm có Trà Ô Long Thượng Hạng nguyên lá vùng cao Lộc Phát, giá niêm yết 95.000đ ạ!",
      confidence: 0.91,
      needsHuman: false
    };
    const msgGroundedOk = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages?shop=tiem-tra-xanh",
      headers: {
        cookie: visitorShop2Cookie,
        "idempotency-key": "m4-chat-002"
      },
      payload: { body: "Gợi ý giúp mình trà nguyên lá vùng cao nhé" }
    });
    expect(msgGroundedOk.statusCode).toBe(201);
    expect(aiCallCount).toBe(1);
    expect(msgGroundedOk.json().data.messages[1].body).toContain("95.000đ");
    expect(msgGroundedOk.json().data.session.status).toBe("open");

    // Case B: AI hallucinates an unauthorized discount price ("49.000đ" not in catalog!) -> BLOCKED!
    nextMockAiJson = {
      answer: "Dạ hôm nay Trà Ô Long đang giảm sốc chỉ còn 49.000đ thôi ạ!",
      confidence: 0.95,
      needsHuman: false
    };
    const msgHallucinatedPrice = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages?shop=tiem-tra-xanh",
      headers: {
        cookie: visitorShop2Cookie,
        "idempotency-key": "m4-chat-003"
      },
      payload: { body: "Mua nhiều có giảm xuống dưới năm chục nghìn không?" }
    });
    expect(msgHallucinatedPrice.statusCode).toBe(201);
    expect(msgHallucinatedPrice.json().data.messages[1].body).not.toContain("49.000đ");
    expect(msgHallucinatedPrice.json().data.session.status).toBe("waiting_shop");

    // Case C: AI fabricates stock availability / delivery guarantee -> BLOCKED!
    nextMockAiJson = {
      answer: "Dạ trong kho còn 25 hộp sẵn hàng, cam kết giao trước 9h sáng mai!",
      confidence: 0.9,
      needsHuman: false
    };
    const msgHallucinatedStock = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages?shop=tiem-tra-xanh",
      headers: {
        cookie: visitorShop2Cookie,
        "idempotency-key": "m4-chat-004"
      },
      payload: { body: "Kho hiện có bao nhiêu hộp để mình lấy liền?" }
    });
    expect(msgHallucinatedStock.statusCode).toBe(201);
    expect(msgHallucinatedStock.json().data.messages[1].body).not.toContain("còn 25 hộp");
    expect(msgHallucinatedStock.json().data.session.status).toBe("waiting_shop");

    // Case D: Customer explicitly asks for human -> immediate handoff without calling AI!
    const callsBeforeHandoff = aiCallCount;
    const msgHumanReq = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages?shop=tiem-tra-xanh",
      headers: {
        cookie: visitorShop2Cookie,
        "idempotency-key": "m4-chat-005"
      },
      payload: { body: "Cho mình gặp nhân viên tư vấn trực tiếp nhé" }
    });
    expect(msgHumanReq.statusCode).toBe(201);
    expect(aiCallCount).toBe(callsBeforeHandoff);
    expect(msgHumanReq.json().data.session.handlingMode).toBe("human");
    expect(msgHumanReq.json().data.session.status).toBe("waiting_shop");

    // 6. Owner inspects AI metrics & Audit Logs, then revokes Staff member
    const aiMetrics = await app.inject({
      method: "GET",
      url: "/api/v1/admin/ai/metrics",
      headers: { cookie: ownerCookie }
    });
    expect(aiMetrics.statusCode).toBe(200);
    expect(aiMetrics.json().data.answeredGroundedCount).toBe(1);
    expect(aiMetrics.json().data.blockedHallucinationCount).toBe(2);
    expect(aiMetrics.json().data.tokensUsedToday).toBeGreaterThan(0);

    const membersRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/members",
      headers: { cookie: ownerCookie }
    });
    expect(membersRes.statusCode).toBe(200);
    const members = membersRes.json().data.members as Array<{
      id: string;
      role: string;
      email: string;
    }>;
    const ownerMem = members.find((m) => m.role === "owner")!;
    const staffMem = members.find((m) => m.role === "staff")!;

    // Cannot revoke sole remaining owner
    const revokeSoleOwner = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${ownerMem.id}/revoke`,
      headers: {
        cookie: ownerCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": ownerCsrf
      }
    });
    expect(revokeSoleOwner.statusCode).toBe(409);

    // Revoking Staff immediately invalidates Staff's active session
    const revokeStaff = await app.inject({
      method: "POST",
      url: `/api/v1/admin/members/${staffMem.id}/revoke`,
      headers: {
        cookie: ownerCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": ownerCsrf
      }
    });
    expect(revokeStaff.statusCode).toBe(200);

    const staffAfterRevoke = await app.inject({
      method: "GET",
      url: "/api/v1/admin/orders",
      headers: { cookie: staffCookie }
    });
    expect(staffAfterRevoke.statusCode).toBe(401);

    // Audit trail contains full action history
    const auditRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit-logs",
      headers: { cookie: ownerCookie }
    });
    expect(auditRes.statusCode).toBe(200);
    const actions = (
      auditRes.json().data as Array<{ action: string }>
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "shop.created",
        "product.created",
        "member.invited",
        "member.accepted",
        "order.status_changed",
        "ai_settings.updated",
        "member.revoked"
      ])
    );

    // Ensure AI_API_KEY never leaked into logs
    expect(capturedLogs.join("\n")).not.toContain(AI_API_KEY);
  });
});
