import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import { createAdminUser } from "../../src/modules/auth/auth.service.js";
import { seedDemoData } from "../../prisma/seed.js";
import { createTestDatabase, type TestDbContext } from "../helpers/test-db.js";

const APP_ORIGIN = "http://localhost:3000";
const ADMIN_EMAIL = "owner-m3@mino.local";
const ADMIN_PASSWORD = "StrongAdminPassword!2026";
const VERIFY_TOKEN = "mino-webhook-verify-token-2026";
const APP_SECRET = "meta-app-secret-for-hmac-sha256-test";
const PAGE_ACCESS_TOKEN = "EAAB-test-secret-page-access-token-do-not-log";
const PAGE_ID = "109988776655443";
const CUSTOMER_PSID = "8877665544332211";

function signWebhookPayload(rawBody: string, secret = APP_SECRET): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}

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

describe("Mino M3 Facebook Messenger Webhook, Idempotency, Outbox & Disconnect", () => {
  let dbCtx: TestDbContext;
  let app: FastifyInstance;
  const capturedLogs: string[] = [];

  // Controllable mock Graph API behavior
  let graphBehavior: "ok" | "http_503" | "token_revoked_190" = "ok";
  const sentOutboundCalls: Array<{
    url: string;
    authHeader: string | null;
    recipientPsid: string;
    text: string;
  }> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    const parsedBody = JSON.parse(String(init?.body ?? "{}")) as {
      recipient?: { id?: string };
      message?: { text?: string };
    };

    sentOutboundCalls.push({
      url,
      authHeader: headers.get("authorization"),
      recipientPsid: parsedBody.recipient?.id ?? "",
      text: parsedBody.message?.text ?? ""
    });

    if (graphBehavior === "http_503") {
      return new Response(JSON.stringify({ error: { message: "Temporary outage" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (graphBehavior === "token_revoked_190") {
      return new Response(
        JSON.stringify({
          error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 }
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return new Response(
      JSON.stringify({
        recipient_id: parsedBody.recipient?.id,
        message_id: `m_out_${sentOutboundCalls.length}`
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  };

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
      SESSION_SECRET: "m3-test-session-secret-with-more-than-32-bytes-entropy",
      LOG_LEVEL: "info",
      MESSENGER_VERIFY_TOKEN: VERIFY_TOKEN,
      MESSENGER_APP_SECRET: APP_SECRET,
      MESSENGER_PAGE_ACCESS_TOKEN: PAGE_ACCESS_TOKEN
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
      fetchFn: mockFetch,
      enableOutboxWorker: false
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (dbCtx) await dbCtx.cleanup();
  });

  it("verifies challenge & HMAC signature, processes webhooks idempotently, retries failed outbox items, handles token revocation, and allows shop to disconnect", async () => {
    // 1. Webhook GET challenge verification
    const badChallenge = await app.inject({
      method: "GET",
      url: "/api/v1/webhooks/messenger?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CHALLENGE_123"
    });
    expect(badChallenge.statusCode).toBe(403);

    const okChallenge = await app.inject({
      method: "GET",
      url: `/api/v1/webhooks/messenger?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=CHALLENGE_123`
    });
    expect(okChallenge.statusCode).toBe(200);
    expect(okChallenge.body).toBe("CHALLENGE_123");

    // 2. Rejects unsigned or tampered POST webhook payloads with 403
    const rawEvent1 = JSON.stringify({
      object: "page",
      entry: [
        {
          id: PAGE_ID,
          time: 1795695000000,
          messaging: [
            {
              sender: { id: CUSTOMER_PSID },
              recipient: { id: PAGE_ID },
              timestamp: 1795695000000,
              message: {
                mid: "m_in_001",
                text: "Cho mình hỏi giá Nến thơm vanilla"
              }
            }
          ]
        }
      ]
    });

    const missingSig = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/messenger",
      headers: { "content-type": "application/json" },
      payload: rawEvent1
    });
    expect(missingSig.statusCode).toBe(403);

    const wrongSig = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/messenger",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signWebhookPayload(rawEvent1 + "tampered")
      },
      payload: rawEvent1
    });
    expect(wrongSig.statusCode).toBe(403);

    // 3. Admin logs in and connects Messenger Fanpage integration
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/session",
      headers: { origin: APP_ORIGIN },
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    });
    expect(loginRes.statusCode).toBe(200);
    const adminCookie = extractCookiePair(loginRes.headers["set-cookie"], "mino_session");
    const csrf = loginRes.json().data.csrfToken as string;

    const connectRes = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/integrations/messenger",
      headers: {
        cookie: adminCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": csrf
      },
      payload: {
        externalAccountId: PAGE_ID,
        displayName: "Fanpage Cửa hàng của Mino"
      }
    });
    expect(connectRes.statusCode).toBe(200);
    expect(connectRes.json().data.status).toBe("active");

    // GET /admin/integrations exposes boolean secret flags ONLY, never secret values
    const getIntRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/integrations",
      headers: { cookie: adminCookie }
    });
    expect(getIntRes.statusCode).toBe(200);
    expect(getIntRes.json().data.secretConfigured).toEqual({
      verifyToken: true,
      appSecret: true,
      pageAccessToken: true
    });
    expect(JSON.stringify(getIntRes.json())).not.toContain(PAGE_ACCESS_TOKEN);
    expect(JSON.stringify(getIntRes.json())).not.toContain(APP_SECRET);

    // 4. Valid signed webhook arrives -> creates Messenger session, replies via Graph API, marks sent
    graphBehavior = "ok";
    const validWebhook1 = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/messenger",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signWebhookPayload(rawEvent1)
      },
      payload: rawEvent1
    });
    expect(validWebhook1.statusCode).toBe(200);
    expect(sentOutboundCalls).toHaveLength(1);
    expect(sentOutboundCalls[0]?.recipientPsid).toBe(CUSTOMER_PSID);
    expect(sentOutboundCalls[0]?.authHeader).toBe(`Bearer ${PAGE_ACCESS_TOKEN}`);
    expect(sentOutboundCalls[0]?.text).toContain("185.000đ");

    // 5. Duplicate webhook delivery (same mid "m_in_001") -> 200 OK, ZERO duplicate messages or outbound calls!
    const duplicateWebhook1 = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/messenger",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signWebhookPayload(rawEvent1)
      },
      payload: rawEvent1
    });
    expect(duplicateWebhook1.statusCode).toBe(200);
    expect(sentOutboundCalls).toHaveLength(1);

    // 6. Echo webhook (is_echo: true) -> ignored safely without triggering bot loop
    const echoPayload = JSON.stringify({
      object: "page",
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            {
              sender: { id: PAGE_ID },
              recipient: { id: CUSTOMER_PSID },
              message: { mid: "m_echo_001", text: "Echoed bot text", is_echo: true }
            }
          ]
        }
      ]
    });
    const echoRes = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/messenger",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signWebhookPayload(echoPayload)
      },
      payload: echoPayload
    });
    expect(echoRes.statusCode).toBe(200);
    expect(sentOutboundCalls).toHaveLength(1);

    // 7. Admin views Messenger conversation in shared Inbox; simulate Graph API 503 outage on admin reply -> saved in Outbox as failed -> retry succeeds!
    const convListRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/conversations",
      headers: { cookie: adminCookie }
    });
    expect(convListRes.statusCode).toBe(200);
    const messengerConv = (
      convListRes.json().data as Array<{ id: string; channel: string }>
    ).find((c) => c.channel === "messenger");
    expect(messengerConv).toBeDefined();
    const convId = messengerConv!.id;

    graphBehavior = "http_503";
    const adminReplyOutage = await app.inject({
      method: "POST",
      url: `/api/v1/admin/conversations/${convId}/messages`,
      headers: {
        cookie: adminCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": csrf,
        "idempotency-key": "m3-admin-reply-001"
      },
      payload: { body: "Chào anh/chị, shop gửi thông tin ưu đãi Messenger ạ!" }
    });
    expect(adminReplyOutage.statusCode).toBe(201);
    expect(adminReplyOutage.json().data.message.deliveryStatus).toBe("failed");
    expect(adminReplyOutage.json().data.message.deliveryErrorCode).toBe("PROVIDER_HTTP_503");

    // Admin inspects failed outbox list
    const outboxList = await app.inject({
      method: "GET",
      url: "/api/v1/admin/outbound-messages?status=failed",
      headers: { cookie: adminCookie }
    });
    expect(outboxList.statusCode).toBe(200);
    expect(outboxList.json().data).toHaveLength(1);

    // Graph API recovers -> Admin triggers manual retry -> message delivered!
    graphBehavior = "ok";
    const retryRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/outbound-messages/retry",
      headers: {
        cookie: adminCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": csrf
      },
      payload: {}
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json().data).toEqual({
      retriedCount: 1,
      sentCount: 1,
      failedCount: 0
    });

    // 8. Simulate revoked token (HTTP 401 / OAuth code 190) -> marks integration status = "error"
    graphBehavior = "token_revoked_190";
    const replyRevoked = await app.inject({
      method: "POST",
      url: `/api/v1/admin/conversations/${convId}/messages`,
      headers: {
        cookie: adminCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": csrf,
        "idempotency-key": "m3-admin-reply-002"
      },
      payload: { body: "Tin thử khi token bị thu hồi" }
    });
    expect(replyRevoked.statusCode).toBe(201);
    expect(replyRevoked.json().data.message.deliveryStatus).toBe("failed");
    expect(replyRevoked.json().data.message.deliveryErrorCode).toBe(
      "TOKEN_INVALID_OR_REVOKED"
    );

    const intAfterRevoke = await app.inject({
      method: "GET",
      url: "/api/v1/admin/integrations",
      headers: { cookie: adminCookie }
    });
    expect(intAfterRevoke.json().data.messenger.status).toBe("error");
    expect(intAfterRevoke.json().data.messenger.lastErrorCode).toBe(
      "TOKEN_INVALID_OR_REVOKED"
    );

    // 9. Admin disconnects Messenger integration -> inbound webhooks ignored & outbound replies blocked with 409
    const disconnectRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/integrations/messenger/disconnect",
      headers: {
        cookie: adminCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": csrf
      }
    });
    expect(disconnectRes.statusCode).toBe(200);
    expect(disconnectRes.json().data.status).toBe("disconnected");

    const countBefore = sentOutboundCalls.length;
    const rawEventWhileDisconnected = JSON.stringify({
      object: "page",
      entry: [
        {
          id: PAGE_ID,
          messaging: [
            {
              sender: { id: CUSTOMER_PSID },
              recipient: { id: PAGE_ID },
              message: { mid: "m_in_after_disconnect", text: "Alo shop" }
            }
          ]
        }
      ]
    });
    const webhookAfterDisconnect = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/messenger",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signWebhookPayload(rawEventWhileDisconnected)
      },
      payload: rawEventWhileDisconnected
    });
    expect(webhookAfterDisconnect.statusCode).toBe(200);
    expect(sentOutboundCalls).toHaveLength(countBefore);

    const replyWhileDisconnected = await app.inject({
      method: "POST",
      url: `/api/v1/admin/conversations/${convId}/messages`,
      headers: {
        cookie: adminCookie,
        origin: APP_ORIGIN,
        "x-csrf-token": csrf,
        "idempotency-key": "m3-admin-reply-003"
      },
      payload: { body: "Gửi khi đã ngắt kết nối" }
    });
    expect(replyWhileDisconnected.statusCode).toBe(409);

    // 10. Ensure secrets never leaked into logs
    const logs = capturedLogs.join("\n");
    expect(logs).not.toContain(PAGE_ACCESS_TOKEN);
    expect(logs).not.toContain(APP_SECRET);
    expect(logs).not.toContain(VERIFY_TOKEN);
  });
});
