# Kế hoạch triển khai Mino

Đây là kế hoạch theo thứ tự phụ thuộc. Mỗi milestone kết thúc bằng tiêu chí nghiệm thu; không chuyển dữ liệu khách thật vào hệ thống trước khi qua cổng phát hành M1.

## Đường đi tổng thể

```text
M0 Chốt quyết định → M1 Nền tảng + đơn COD dùng chung → Release M1
                  → M2 Web chat/inbox → M3 Một kênh ngoài → M4 Nhiều shop/AI có kiểm soát
```

## Quyết định mặc định để bắt đầu

- Một shop, một chủ shop, tiếng Việt, VND, website trước, COD.
- Node.js 26 LTS + TypeScript + Fastify; Fastify route schemas để kiểm tra input/output.
- PostgreSQL 18; Prisma ORM/migrations; thiết kế theo PostgreSQL, không dùng SQLite làm môi trường production.
- Một ứng dụng API phục vụ giao diện tĩnh và `/api` cùng origin để giảm CORS/cookie phức tạp.
- Không có signup công khai; tài khoản chủ shop được tạo bằng CLI có xác thực.
- Không thêm AI, payment, queue hoặc kênh ngoài cho M1.

## M0 — Chốt và chuẩn bị (trước khi code)

- [ ] Xác nhận/đổi các giả định ở `PRODUCT_REQUIREMENTS.md`.
- [ ] Chọn domain/host và vùng đặt database; chỉ chọn sau khi biết ngân sách.
- [ ] Quyết định ai có quyền xem đơn, ai chịu trách nhiệm vận hành/backup.
- [ ] Giữ dữ liệu mẫu hiện tại, không migrate `localStorage` của khách: dữ liệu đó phân tán và không có nguồn tập trung đáng tin.
- [ ] Tạo nhánh feature; giữ `main` deployable; yêu cầu review thay đổi schema/API.

**Cổng M0:** phạm vi M1 được chấp thuận: web + COD + một admin; Messenger/Zalo, AI và thanh toán hoãn.

## M1 — MVP nhận đơn thật

> **Trạng thái mã nguồn (`feat/m1-mvp`):** Đã hoàn thành triển khai mã nguồn, migration, giao diện và bộ kiểm thử tự động cho M1.1 → M1.6 và phần kiểm thử tự động của M1.7. Các mục hạ tầng/vận hành thực tế (chọn domain, cấu hình HTTPS/backup trên host staging & production) tiếp tục thực hiện khi dựng môi trường triển khai theo `OPERATIONS.md`.

### M1.1 — Scaffold và môi trường local

- [x] Tạo Node project, TypeScript strict, format/lint/typecheck/build/start scripts.
- [x] Tạo Fastify app, config từ environment, error handler chuẩn, request ID và `/health/live`, `/health/ready`.
- [x] Tạo cấu trúc `public/`, `src/modules/`, `prisma/`, `docs/`; giữ bản HTML hiện tại trong `public/`.
- [x] Thêm `.env.example`, `.gitignore` cho secrets/build/logs; không commit `.env`.
- [x] Tạo PostgreSQL local bằng Docker Compose hoặc cài local; tách database dev và staging.
- [x] Đảm bảo API và HTML cùng origin; cấu hình proxy/server để `/api/*` không bị gửi về file tĩnh.

**Nghiệm thu:** clone mới → cài dependencies → tạo `.env` → khởi động DB → migrate/seed → mở storefront và trang health. Không cần cấu hình tài khoản ngoài.

### M1.2 — Schema, migrations và dữ liệu mẫu

- [x] Tạo `shops`, `admin_users`, `admin_sessions`, `products`, `bot_rules`, `orders`, `order_items`, `order_events`.
- [x] Dùng UUID, timestamps UTC, tiền `BIGINT` VND; thêm foreign keys, unique constraints và check constraints.
- [x] Đặt `shop_id` trong các bảng nghiệp vụ, dù chỉ seed một shop; tất cả repository queries nhận shop scope.
- [x] Serialize PostgreSQL/Prisma `BigInt` thành chuỗi số nguyên trong API; không để `BigInt` lọt vào `JSON.stringify`.
- [x] Tạo migration đầu tiên và seed dữ liệu demo xác định được; seed không chạy tự động trên production.
- [x] Tạo command migrate dev / deploy theo Prisma version đã cài; chỉ dùng migration đã commit trên staging/prod.

**Nghiệm thu:** database rỗng dựng lại được từ migration; seed chạy lặp an toàn hoặc từ chối có thông báo rõ; xóa/migrate không làm mất dữ liệu production ngoài quy trình.

### M1.3 — Auth và admin session

- [x] Tạo CLI tạo admin (prompt email/mật khẩu, hash bằng thuật toán thư viện auth đã chọn); không có mật khẩu mặc định.
- [x] Login kiểm tra thông tin, rate limit thất bại, trả generic error không tiết lộ email tồn tại.
- [x] Tạo session ID ngẫu nhiên; chỉ lưu hash server-side; cookie `HttpOnly`, `Secure` production, `SameSite=Lax`, `Path=/`, thời hạn rõ.
- [x] Logout revoke session; mọi handler admin gọi `requireAdmin` + `requireShopScope`.
- [x] Bảo vệ các request thay đổi bằng kiểm tra `Origin` và CSRF token hoặc cơ chế tương đương đã review.

**Nghiệm thu:** anonymous admin API bị 401; cookie bị thiếu/sai/hết hạn bị từ chối; logout thu hồi ngay; không có credential/token trong localStorage.

### M1.4 — Catalog và cấu hình shop

- [x] API public chỉ trả trường được phép công khai và sản phẩm `active`.
- [x] API admin CRUD sản phẩm/luật bot/câu fallback; validate trường bắt buộc và giới hạn độ dài.
- [x] Form `caidat.html` đọc/ghi qua API sau khi admin đăng nhập; không còn là nguồn dữ liệu chính ở localStorage.
- [x] Trang khách tải catalog/cấu hình public; bot sử dụng rule server cung cấp.
- [x] Sửa câu trả lời hard-code trong `index.html` đang khẳng định sản phẩm “còn hàng”; khi chưa có tồn kho, chỉ xác nhận sản phẩm đang được niêm yết và báo giá.
- [x] Quy định hành vi từ khóa trùng: priority nhỏ hơn chạy trước; cùng priority dùng thứ tự ID ổn định; fallback nếu không khớp.

**Nghiệm thu:** tạo/sửa/ẩn sản phẩm trên admin; trang khách chỉ thấy sản phẩm hoạt động; reload/trình duyệt khác giữ dữ liệu.

### M1.5 — Tạo và quản lý đơn

- [x] Public `POST /orders` nhận product IDs/quantities, thông tin người nhận, địa chỉ, ghi chú.
- [x] Server lấy tên/giá từ DB; tính subtotal khi đặt bằng số nguyên; kiểm tra sản phẩm vẫn hoạt động.
- [x] Đơn mới có phí ship/tổng cuối chưa xác định; trang cảm ơn nói rõ shop sẽ gọi xác nhận. Khi xác nhận đơn, admin nhập phí ship; server tính total.
- [x] Nhận `Idempotency-Key`; lưu fingerprint payload; key cũ + payload cũ trả lại cùng kết quả; key cũ + payload khác trả 409.
- [x] Tạo order và items snapshot trong một transaction; tạo order number duy nhất.
- [x] Admin list/detail/filter/cursor pagination; không trả mọi đơn cùng lúc. Màn hình hiển thị subtotal, phí ship đã xác nhận (nếu có), total cuối (nếu có).
- [x] Status transition có allowlist; `order_events` ghi trạng thái cũ/mới, actor, time và note; transaction gộp cập nhật + audit.
- [x] Frontend chỉ hiển thị thành công sau response 201/200; timeout giữ key để retry; không tự xóa form trước khi xác nhận.

**Nghiệm thu:** kiểm tra giá giả mạo, product bị ẩn, quantity 0/âm/quá lớn, thiếu địa chỉ, double-click và timeout retry; chỉ đơn hợp lệ được lưu. Xác nhận `new → confirmed` bắt buộc có phí ship không âm; total tính server-side. Không được sửa phí sau xác nhận qua endpoint status thường.

### M1.6 — Nối giao diện hiện có

- [x] Chuyển trang khách từ đọc catalog mặc định sang `fetch` API; hiển thị loading/error/empty state.
- [x] Chuyển admin từ seed data/localStorage sang endpoints có auth; bỏ số liệu KPI/conversation seed khỏi dữ liệu thật hoặc đặt nhãn demo.
- [x] Bỏ các nút chưa triển khai hoặc hiện trạng thái “chưa hỗ trợ”; không giả vờ gửi tin/tệp thật.
- [x] Xử lý session hết hạn: thông báo và quay về màn đăng nhập, không mất nội dung đang nhập.
- [x] Rà soát mobile, label form, focus/keyboard, escape dữ liệu người dùng trước khi render.

**Nghiệm thu end-to-end:** khách A tạo đơn trên trình duyệt ẩn danh; admin B đăng nhập từ trình duyệt khác thấy đúng đơn; thay trạng thái; refresh vẫn giữ; khách không nhìn thấy dữ liệu admin.

### M1.7 — Kiểm thử, staging và phát hành

- [x] Unit: tính tiền, status transitions, rule matching, validation.
- [x] Integration với DB thật: migrations, transaction rollback, idempotency, auth scope.
- [x] API contract: status code/error shape/pagination không lệch `API_CONTRACT.md`.
- [x] E2E: luồng đặt COD và luồng admin xử lý.
- [x] Security checks: không auth, CSRF/origin, brute force/rate, XSS payload, PII trong logs.
- [ ] Staging dùng secrets/database riêng; chạy migration trước khi bật ứng dụng mới.
- [ ] Cấu hình HTTPS, backup/restore, health alerts và người nhận cảnh báo.
- [ ] Duyệt checklist go-live trong `OPERATIONS.md` và `SECURITY.md`.

**Cổng phát hành M1:** mọi tiêu chí M1 pass; restore backup đã diễn tập; shop đã thử đơn mẫu; chưa mở traffic thật nếu admin/auth/backup còn lỗi.

## M2 — Web chat và inbox dùng chung

- [ ] Thêm `chat_sessions`, `messages`, `chat_session_events`; giữ payload plain text, giới hạn kích thước.
- [ ] Cấp visitor session token ngẫu nhiên, lưu hash phía server; chỉ cho phép visitor đọc/gửi trong phiên của mình.
- [ ] Gửi message vào API; bot trả lời dùng rule/config cùng nguồn authoritative.
- [ ] Admin xem inbox, lọc trạng thái, trả lời; phản hồi chủ shop hiển thị lại qua polling ngắn ban đầu.
- [ ] Ghi note nội bộ tách biệt với message gửi khách; quyền truy cập admin bắt buộc.
- [ ] Thêm handoff: new/open/waiting_customer/waiting_shop/closed; không thông báo bot khi admin đang takeover.
- [ ] Thêm pagination và retention policy cho message sau khi chủ shop duyệt.

**Cổng M2:** hai trình duyệt khác nhau trao đổi được trong cùng phiên; visitor A không thể truy cập session B; trả lời/ghi chú phân biệt đúng.

## M3 — Một kênh ngoài

- [ ] Trước tiên chọn đúng một kênh dựa trên khách hàng thực tế, không tích hợp đồng thời cả hai.
- [ ] Đọc tài liệu nhà cung cấp hiện hành; rà soát quyền app, điều kiện xét duyệt, giới hạn nhắn tin và chi phí.
- [ ] Thêm adapter riêng, webhook verify challenge/signature, idempotency event, retry/outbox và log không lộ secret.
- [ ] Lưu mapping external account/user ID tới shop/session; quản lý token trong secret manager.
- [ ] Thử app/test account và xử lý revoke token/webhook lỗi trước production.

**Cổng M3:** webhook lặp không tạo duplicate; signature sai bị từ chối; outbound failure có thể retry/đối soát; shop có thể ngắt integration.

## M4 — Nhiều shop / AI (chỉ khi có nhu cầu)

- Nhiều shop: user-membership, vai trò, tenant-isolation checks, mời/thu hồi, audit trail, billing nếu có thương mại.
- AI: benchmark bộ câu hỏi thật đã ẩn danh; retrieval từ catalog/rules; không tự quyết giá/tồn kho; human handoff; theo dõi chi phí và chất lượng.
- Không bật M4 chỉ để “có AI” hoặc “scale”; cần có chỉ số và người chịu trách nhiệm.

## Definition of Done cho từng ticket

- Hành vi/API đã mô tả trong PRD/API contract hoặc tài liệu được cập nhật.
- Schema change có migration mới, không sửa migration đã chạy ở môi trường chia sẻ.
- Validation, auth scope, lỗi và loading/empty state có xử lý.
- Có kiểm thử phù hợp được viết/chạy trong lúc triển khai (đây là yêu cầu kế hoạch cho các thay đổi sau này).
- Không có secrets hoặc PII trong diff/log; có ảnh chụp/ghi chú cách kiểm tra UI.
- README/docs được cập nhật nếu cách chạy, env, API hoặc hành vi thay đổi.
