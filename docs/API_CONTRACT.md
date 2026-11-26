# Hợp đồng API — Mino v1

**Trạng thái:** đã triển khai cho M1 trong `src/modules/`. Mọi response JSON thành công trả `{ "data": ..., "requestId": "req_..." }` (kèm `"nextCursor"` trên các endpoint phân trang).

## Quy ước chung

- Base path: `/api/v1`; cùng origin với frontend.
- Request/response JSON UTF-8; timestamp ISO 8601 UTC.
- Tiền VND là chuỗi số nguyên, ví dụ `"125000"`; request đặt đơn không gửi đơn giá/tổng tiền.
- Admin authentication bằng cookie phiên `mino_session` (`HttpOnly`, `Secure` production, `SameSite=Lax`, `Path=/`). Không trả bearer/session token trong JSON.
- Mutating admin request cần `X-CSRF-Token` và `Origin` hợp lệ. `GET /admin/session` trả CSRF token dùng trong bộ nhớ trang.
- Pagination dùng opaque `cursor` và `limit` (default 25, max 100); không offset-scan toàn bảng.
- Thành công trả `data`; lỗi theo cấu trúc bên dưới. Mọi response có `requestId`.

## Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Thông tin gửi lên chưa hợp lệ.",
    "requestId": "req_01...",
    "fields": [{ "field": "items[0].quantity", "reason": "must be at least 1" }]
  }
}
```

Mã chính: `VALIDATION_ERROR` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409), `RATE_LIMITED` (429), `INTERNAL_ERROR` (500). Không trả stack trace, SQL, secret hoặc thông tin xác nhận email tồn tại.

## Public endpoints — M1

### `GET /public/shop`

Trả trường được phép công khai: `name`, `publicPhone?`, `publicAddress?`, `botName`, `fallbackReply`, `currency`. Không trả thông tin quản trị.

### `GET /public/products?cursor=&limit=`

Trả sản phẩm `active` thuộc shop; chỉ gồm `id`, `name`, `description?`, `priceVnd` (chuỗi số nguyên), `emoji?`. Không trả archived/hidden.

### `GET /public/bot-rules`

Trả các rule đang bật gồm `keywords`, `answer`, `priority`; không trả ID nội bộ nhạy cảm hoặc rule đã tắt. `GET /public/shop` trả `fallbackReply`. Nội dung được xử lý như text ở UI; không render HTML từ rule.

### `POST /public/orders`

Headers: `Content-Type: application/json`, `Idempotency-Key: <random UUID>`.

Request:

```json
{
  "recipient": {
    "name": "Nguyen Van A",
    "phone": "0900000000",
    "address": "Quan 1, TP Ho Chi Minh"
  },
  "items": [
    { "productId": "2bc6c6fa-863c-41f9-8b17-60e8f0b71b0d", "quantity": 2 }
  ],
  "note": "Giao giờ hành chính"
}
```

Rules: 1–20 distinct product IDs; quantity 1–1000; name/phone/address required and bounded; note optional, max 1000 chars. Unknown JSON properties rejected. Server looks up active products and computes all amounts.

Response `201 Created`:

```json
{
  "data": {
    "orderNo": "MN-20261126-A1B2C3D4",
    "status": "new",
    "subtotalVnd": "250000",
    "shippingFeeVnd": null,
    "totalVnd": null,
    "createdAt": "2026-11-26T10:00:00.000Z"
  }
}
```

Response intentionally omits address/phone. The order page must say the subtotal excludes shipping and the shop will confirm the shipping fee/final total. Same key + same normalized payload returns the same order result (200 on replay); same key + different payload returns `409 CONFLICT`. Missing key is 400. An inactive product is 409; invalid quantity/format is 400. Rate limit by IP/session with configurable limit.

## Admin session endpoints — M1

### `POST /admin/session`

Request `{ "email": "owner@example.com", "password": "..." }`. On success, set `mino_session` cookie and return `{ "data": { "user": { "id", "email", "shopId" }, "csrfToken", "expiresAt" } }`. Invalid credentials return generic 401. Rate-limit attempts and audit successful login.

### `GET /admin/session`

Requires valid cookie; returns current user, `csrfToken`, `expiresAt`. No PII outside account profile.

### `DELETE /admin/session`

Requires valid cookie + CSRF/origin; revoke session and expire cookie; return 204.

## Admin shop/catalog endpoints — M1

All require admin session and shop scope from session.

| Method/path | Purpose | Input/output |
|---|---|---|
| `GET /admin/shop` | Load shop and bot settings | public fields plus editable bot configuration |
| `PATCH /admin/shop` | Update shop/bot name/fallback | validate allowlisted fields only |
| `GET /admin/products` | List all statuses | cursor, limit, status filter |
| `POST /admin/products` | Create product | name, description, `priceVnd` (chuỗi số nguyên), emoji, status |
| `PATCH /admin/products/{id}` | Update/archive product | partial allowlist; historic order snapshot unchanged |
| `GET /admin/bot-rules` | List keyword rules | stable priority ordering |
| `POST /admin/bot-rules` | Create rule | keywords (1–20), answer, priority, enabled |
| `PATCH /admin/bot-rules/{id}` | Update rule | same validation as create |

For create/update, verify ownership by current shop. IDs from another scope return `404` to avoid cross-shop enumeration.

## Admin order endpoints — M1

| Method/path | Purpose |
|---|---|
| `GET /admin/orders?status=&q=&cursor=&limit=` | Search/filter by order number, recipient name/phone and status; newest first |
| `GET /admin/orders/{id}` | Detail with recipient, item snapshots, totals and status events |
| `PATCH /admin/orders/{id}` | Change status and optional internal note |

Allowed transitions:

```text
new → confirmed | cancelled
confirmed → preparing | cancelled
preparing → shipping | cancelled
shipping → completed
completed, cancelled → terminal
```

Invalid transition returns 409; successful update and `order_events` insert happen atomically. `new → confirmed` must include `shippingFeeVnd` as a non-negative integer string; server sets `shipping_fee_vnd` and `total_vnd = subtotal_vnd + shipping_fee_vnd` in the same transaction. Example: `{ "status": "confirmed", "shippingFeeVnd": "30000", "note": "Đã gọi xác nhận" }`. Other transitions reject `shippingFeeVnd`; changing a confirmed fee requires a separate audited correction flow, which is out of M1. Until confirmation, admin shows “Chưa chốt phí ship”; the customer page must not present subtotal as the final amount.

## Health endpoints

- `GET /health/live`: process is running; no database query.
- `GET /health/ready`: app can reach required database; no credentials or internals in body.
- Do not expose detailed diagnostics publicly; infrastructure may use a protected/internal readiness check.

## M2 endpoints — đã triển khai ở nhánh `feat/m2-chat-inbox`

- `POST /public/chat/sessions` (tạo hoặc nối lại phiên chat qua cookie `mino_visitor_chat` `HttpOnly`), `GET /public/chat/sessions/current/messages?afterCursor=&limit=`, `POST /public/chat/sessions/current/messages` (`Idempotency-Key` bắt buộc).
- `GET /admin/conversations`, `GET /admin/conversations/{id}`, `GET /admin/conversations/{id}/messages`.
- `POST /admin/conversations/{id}/messages` (trả lời khách + tự động chuyển `handlingMode = "human"`), `POST /admin/conversations/{id}/notes` (ghi chú nội bộ lưu tách bảng `chat_notes`), `PATCH /admin/conversations/{id}` (cập nhật trạng thái, bật/tắt bot, thông tin khách, đánh dấu đã đọc).

## M3 endpoints — Facebook Messenger Integration (`feat/m3-messenger-channel`)

- `GET /webhooks/messenger` (xác minh `hub.verify_token` & trả `hub.challenge`), `POST /webhooks/messenger` (xác minh chữ ký `X-Hub-Signature-256` trên raw body, xử lý idempotent qua `webhook_events`).
- `GET /admin/integrations`, `PUT /admin/integrations/messenger`, `POST /admin/integrations/messenger/disconnect`.
- `GET /admin/outbound-messages`, `POST /admin/outbound-messages/retry` (đối soát & gửi lại tin lỗi từ hàng đợi outbox).

## Contract change rule

Update this document and route validation schemas in the same change. Treat removing/renaming fields, changing money representation, changing status values or weakening auth as breaking changes; introduce a new API version or migration plan. Before release, automated contract checks should verify examples/status codes against the running API.
