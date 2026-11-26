import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../../config/env.js";

export interface SendMessengerResult {
  ok: boolean;
  providerMessageId: string | null;
  errorCode: string | null;
  retryable: boolean;
  tokenRevoked: boolean;
}

export function verifyMessengerSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string | null
): boolean {
  if (!appSecret || !signatureHeader) {
    return false;
  }
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) {
    return false;
  }
  const providedHex = signatureHeader.slice(prefix.length).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(providedHex)) {
    return false;
  }

  const expectedBuf = createHmac("sha256", appSecret).update(rawBody).digest();
  const providedBuf = Buffer.from(providedHex, "hex");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

export function verifyMessengerChallenge(
  query: {
    "hub.mode"?: string;
    "hub.verify_token"?: string;
    "hub.challenge"?: string;
  },
  configuredVerifyToken: string | null
): string | null {
  if (
    !configuredVerifyToken ||
    query["hub.mode"] !== "subscribe" ||
    typeof query["hub.verify_token"] !== "string" ||
    typeof query["hub.challenge"] !== "string" ||
    query["hub.challenge"].length === 0
  ) {
    return null;
  }

  const a = Buffer.from(query["hub.verify_token"], "utf8");
  const b = Buffer.from(configuredVerifyToken, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  return query["hub.challenge"];
}

export interface MessengerAdapter {
  sendTextMessage(params: {
    pageExternalId: string;
    recipientPsid: string;
    text: string;
  }): Promise<SendMessengerResult>;
}

export function createMessengerAdapter(
  config: AppConfig,
  fetchImpl: typeof fetch = globalThis.fetch
): MessengerAdapter {
  return {
    async sendTextMessage({ pageExternalId, recipientPsid, text }) {
      const token = config.messengerPageAccessToken;
      if (!token) {
        return {
          ok: false,
          providerMessageId: null,
          errorCode: "MISSING_PAGE_ACCESS_TOKEN",
          retryable: false,
          tokenRevoked: false
        };
      }

      const url = `${config.messengerGraphApiBaseUrl}/${encodeURIComponent(
        pageExternalId
      )}/messages`;

      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            messaging_type: "RESPONSE",
            recipient: { id: recipientPsid },
            message: { text }
          }),
          signal: AbortSignal.timeout(config.messengerSendTimeoutMs)
        });

        const payload = (await res.json().catch(() => null)) as {
          message_id?: string;
          error?: { code?: number; type?: string };
        } | null;

        if (res.ok) {
          return {
            ok: true,
            providerMessageId:
              typeof payload?.message_id === "string" ? payload.message_id : null,
            errorCode: null,
            retryable: false,
            tokenRevoked: false
          };
        }

        const fbCode = payload?.error?.code;

        if (res.status === 401 || fbCode === 190) {
          return {
            ok: false,
            providerMessageId: null,
            errorCode: "TOKEN_INVALID_OR_REVOKED",
            retryable: false,
            tokenRevoked: true
          };
        }

        if (res.status === 429 || fbCode === 4 || fbCode === 32 || fbCode === 613) {
          return {
            ok: false,
            providerMessageId: null,
            errorCode: "PROVIDER_RATE_LIMITED",
            retryable: true,
            tokenRevoked: false
          };
        }

        if (res.status >= 500) {
          return {
            ok: false,
            providerMessageId: null,
            errorCode: `PROVIDER_HTTP_${res.status}`,
            retryable: true,
            tokenRevoked: false
          };
        }

        return {
          ok: false,
          providerMessageId: null,
          errorCode: fbCode ? `GRAPH_ERROR_${fbCode}` : `PROVIDER_HTTP_${res.status}`,
          retryable: false,
          tokenRevoked: false
        };
      } catch (err: unknown) {
        const isTimeout =
          err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError");
        return {
          ok: false,
          providerMessageId: null,
          errorCode: isTimeout ? "SEND_TIMEOUT" : "NETWORK_ERROR",
          retryable: true,
          tokenRevoked: false
        };
      }
    }
  };
}
