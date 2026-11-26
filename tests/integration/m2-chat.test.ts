import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { createAdminUser } from "../../src/modules/auth/auth.service.js";
import { SEED_PRODUCTS, seedDemoData } from "../../prisma/seed.js";
import { createTestDatabase, type TestDbContext } from "../helpers/test-db.js";

const APP_ORIGIN = "http://localhost:3000";
const ADMIN_EMAIL = "owner-m2@mino.local";
const ADMIN_PASSWORD = "StrongAdminPassword!2026";

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
  if (!found) {
    throw new Error(`Missing Set-Cookie for ${cookieName}`);
  }
  return found.split(";")[0] ?? "";
}

describe("Mino M2 Web Chat & Shared Inbox Integration", () => {
  let dbCtx: TestDbContext;
  let app: FastifyInstance;
  const capturedLogs: string[] = [];

  beforeAll(async () => {
    dbCtx = await createTestDatabase();
    const { shopId } = await seedDemoData(dbCtx.prisma);
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
      SESSION_SECRET: "m2-test-session-secret-with-more-than-32-bytes-entropy",
      LOG_LEVEL: "info"
    });

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

  it("isolates visitor sessions strictly via HttpOnly cookie, prevents private note leaks, supports human takeover/bot resume, and links COD orders by phone", async () => {
    // 1. Unauthenticated visitor cannot read or post messages
    const anonPoll = await app.inject({
      method: "GET",
      url: "/api/v1/public/chat/sessions/current/messages"
    });
    expect(anonPoll.statusCode).toBe(401);

    // 2. Visitor A starts session -> receives HttpOnly mino_visitor_chat cookie & welcome message
    const startA = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions"
    });
    expect(startA.statusCode).toBe(201);
    const rawCookieHeaderA = String(startA.headers["set-cookie"]);
    expect(rawCookieHeaderA).toContain("mino_visitor_chat=");
    expect(rawCookieHeaderA).toContain("HttpOnly");
    expect(rawCookieHeaderA).toContain("Path=/api/v1/public/chat");

    const visitorACookie = extractCookiePair(
      startA.headers["set-cookie"],
      "mino_visitor_chat"
    );
    const sessionAId = startA.json().data.session.id as string;
    expect(startA.json().data.latestCursor).toBeTruthy();
    expect(startA.json().data.messages).toHaveLength(1);

    // Resuming session with same cookie returns 200 and same session ID
    const resumeA = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions",
      headers: { cookie: visitorACookie }
    });
    expect(resumeA.statusCode).toBe(200);
    expect(resumeA.json().data.session.id).toBe(sessionAId);

    // 3. Visitor B starts an independent session
    const startB = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions"
    });
    expect(startB.statusCode).toBe(201);
    const visitorBCookie = extractCookiePair(
      startB.headers["set-cookie"],
      "mino_visitor_chat"
    );
    expect(startB.json().data.session.id).not.toBe(sessionAId);

    // 4. Visitor A asks about a product -> bot answers with listed price, status stays "open"
    const askProdRes = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages",
      headers: {
        cookie: visitorACookie,
        "idempotency-key": "chat-msg-a-001"
      },
      payload: { body: "Cho mình hỏi giá Nến thơm vanilla" }
    });
    expect(askProdRes.statusCode).toBe(201);
    expect(askProdRes.json().data.messages).toHaveLength(2);
    expect(askProdRes.json().data.messages[1].senderType).toBe("bot");
    expect(askProdRes.json().data.messages[1].body).toContain("185.000đ");
    expect(askProdRes.json().data.session.status).toBe("open");

    // Replay same Idempotency-Key + same body -> 200 without duplicating; different body -> 409
    const replaySame = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages",
      headers: {
        cookie: visitorACookie,
        "idempotency-key": "chat-msg-a-001"
      },
      payload: { body: "Cho mình hỏi giá Nến thơm vanilla" }
    });
    expect(replaySame.statusCode).toBe(200);

    const replayDiff = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages",
      headers: {
        cookie: visitorACookie,
        "idempotency-key": "chat-msg-a-001"
      },
      payload: { body: "Nội dung khác hoàn toàn" }
    });
    expect(replayDiff.statusCode).toBe(409);

    // 5. Visitor A asks an out-of-scope question -> bot triggers fallback & escalates session to waiting_shop
    const askFallback = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages",
      headers: {
        cookie: visitorACookie,
        "idempotency-key": "chat-msg-a-002"
      },
      payload: { body: "Shop có nhận in thiệp riêng 500 bản thiết kế theo file AI không?" }
    });
    expect(askFallback.statusCode).toBe(201);
    expect(askFallback.json().data.session.status).toBe("waiting_shop");
    const visitorACursor = askFallback.json().data.latestCursor as string;

    // Visitor B polling sees ONLY Visitor B's welcome message (zero cross-session leak!)
    const pollB = await app.inject({
      method: "GET",
      url: "/api/v1/public/chat/sessions/current/messages",
      headers: { cookie: visitorBCookie }
    });
    expect(pollB.statusCode).toBe(200);
    expect(pollB.json().data).toHaveLength(1);

    // 6. Place a COD order with Visitor A's phone number to test inbox <-> order linking
    const orderRes = await app.inject({
      method: "POST",
      url: "/api/v1/public/orders",
      headers: { "idempotency-key": "order-for-visitor-a-001" },
      payload: {
        recipient: {
          name: "Chị Minh Anh",
          phone: "0933 444 555",
          address: "10 Hai Bà Trưng, Quận 1, TP.HCM"
        },
        items: [{ productId: SEED_PRODUCTS[1].id, quantity: 2 }]
      }
    });
    expect(orderRes.statusCode).toBe(201);
    const placedOrderNo = orderRes.json().data.orderNo as string;

    // 7. Admin logs in, filters waiting_shop conversations, writes an internal note, and replies
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      headers: { origin: APP_ORIGIN },
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminCookie = extractCookiePair(
      adminLogin.headers["set-cookie"],
      "mino_session"
    );
    const csrf = adminLogin.json().data.csrfToken as string;

    const inboxRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/conversations?status=waiting_shop",
      headers: { cookie: adminCookie }
    });
    expect(inboxRes.statusCode).toBe(200);
    expect(inboxRes.json().unreadConversationsCount).toBeGreaterThanOrEqual(1);
    const waitingIds = (inboxRes.json().data as Array<{ id: string }>).map(
      (c) => c.id
    );
    expect(waitingIds).toContain(sessionAId);

    // Admin adds a private internal note -> must NOT leak to visitor
    const secretNoteText = "GHI_CHU_NOI_BO_CHI_SHOP_THAY_999";
    const noteRes = await app.inject({
      method: "POST",
      url: `/api/v1/admin/conversations/${sessionAId}/notes`,
      headers: {
        cookie: adminCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": csrf
      },
      payload: { body: secretNoteText }
    });
    expect(noteRes.statusCode).toBe(201);

    // Admin attaches visitor phone & name -> detail endpoint returns matching COD order
    const patchVisitorRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/conversations/${sessionAId}`,
      headers: {
        cookie: adminCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": csrf
      },
      payload: {
        visitorName: "Chị Minh Anh",
        visitorPhone: "+84 933 444 555",
        markRead: true
      }
    });
    expect(patchVisitorRes.statusCode).toBe(200);
    expect(patchVisitorRes.json().data.unreadForShop).toBe(0);

    const convDetail = await app.inject({
      method: "GET",
      url: `/api/v1/admin/conversations/${sessionAId}`,
      headers: { cookie: adminCookie }
    });
    expect(convDetail.statusCode).toBe(200);
    expect(convDetail.json().data.notes).toHaveLength(1);
    expect(convDetail.json().data.notes[0].body).toBe(secretNoteText);
    expect(convDetail.json().data.relatedOrders[0].orderNo).toBe(placedOrderNo);

    // Admin replies to Visitor A -> switches session to handlingMode="human", status="waiting_customer"
    const adminReplyText = "Dạ bên em nhận in thiệp riêng từ 100 bản trở lên nha chị Minh Anh!";
    const replyRes = await app.inject({
      method: "POST",
      url: `/api/v1/admin/conversations/${sessionAId}/messages`,
      headers: {
        cookie: adminCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": csrf,
        "idempotency-key": "admin-reply-001"
      },
      payload: { body: adminReplyText }
    });
    expect(replyRes.statusCode).toBe(201);
    expect(replyRes.json().data.session.handlingMode).toBe("human");
    expect(replyRes.json().data.session.status).toBe("waiting_customer");

    // 8. Visitor A polls with afterCursor -> receives ONLY the admin reply, NEVER the private note!
    const pollAfterReply = await app.inject({
      method: "GET",
      url: `/api/v1/public/chat/sessions/current/messages?afterCursor=${encodeURIComponent(
        visitorACursor
      )}`,
      headers: { cookie: visitorACookie }
    });
    expect(pollAfterReply.statusCode).toBe(200);
    const newVisitorMsgs = pollAfterReply.json().data as Array<{
      senderType: string;
      body: string;
    }>;
    expect(newVisitorMsgs).toEqual([
      expect.objectContaining({
        senderType: "admin",
        body: adminReplyText
      })
    ]);
    expect(JSON.stringify(pollAfterReply.json())).not.toContain(secretNoteText);

    // 9. While handlingMode === "human", Visitor A replies -> Bot MUST NOT interrupt!
    const followUpDuringHuman = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages",
      headers: {
        cookie: visitorACookie,
        "idempotency-key": "chat-msg-a-003"
      },
      payload: { body: "Vậy báo giá ship giúp mình luôn nha" }
    });
    expect(followUpDuringHuman.statusCode).toBe(201);
    expect(followUpDuringHuman.json().data.messages).toHaveLength(1);
    expect(followUpDuringHuman.json().data.messages[0].senderType).toBe("customer");
    expect(followUpDuringHuman.json().data.session.status).toBe("waiting_shop");

    // 10. Admin hands session back to Bot -> Visitor A asks "ship" -> Bot resumes replying!
    const resumeBotRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/conversations/${sessionAId}`,
      headers: {
        cookie: adminCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": csrf
      },
      payload: { handlingMode: "bot" }
    });
    expect(resumeBotRes.statusCode).toBe(200);

    const askAfterResume = await app.inject({
      method: "POST",
      url: "/api/v1/public/chat/sessions/current/messages",
      headers: {
        cookie: visitorACookie,
        "idempotency-key": "chat-msg-a-004"
      },
      payload: { body: "ship tỉnh mất bao lâu ạ?" }
    });
    expect(askAfterResume.statusCode).toBe(201);
    expect(askAfterResume.json().data.messages).toHaveLength(2);
    expect(askAfterResume.json().data.messages[1].senderType).toBe("bot");

    // 11. Verify chat bodies and phone numbers are never leaked into application logs
    const logs = capturedLogs.join("\n");
    expect(logs).not.toContain(secretNoteText);
    expect(logs).not.toContain(adminReplyText);
    expect(logs).not.toContain("0933 444 555");
  });
});
