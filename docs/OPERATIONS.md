# Vận hành và phát hành Mino

**Trạng thái:** quy trình đích cho M1; chưa có backend để chạy các lệnh trong phần triển khai.

## 1. Môi trường

| Environment | Dữ liệu | Secrets | Mục đích |
|---|---|---|---|
| Local | PostgreSQL local, seed giả | `.env` local, không commit | Phát triển |
| Staging | DB riêng, dữ liệu giả | Secrets riêng staging | Kiểm tra release/migration/E2E |
| Production | DB thật, backup bật | Secret manager hoặc environment của host | Shop sử dụng |

Không dùng chung database hoặc cookie secret giữa staging và production. Không copy PII production về local.

## 2. Cấu hình dự kiến

`.env.example` chỉ có placeholder, không có credential thật:

```dotenv
NODE_ENV=development
PORT=3000
APP_BASE_URL=http://localhost:3000
DATABASE_URL=postgresql://mino:change-me@localhost:5432/mino_dev
SESSION_SECRET=replace-with-random-secret-at-least-32-bytes
LOG_LEVEL=info
TRUST_PROXY=0
```

- `SESSION_SECRET` phải tạo riêng từng environment, đủ entropy và được rotate theo quy trình.
- `DATABASE_URL` production dùng TLS/credential theo nhà cung cấp; user DB chỉ có quyền cần thiết.
- Bật encryption at rest cho database/backups nếu provider hỗ trợ; xác nhận TLS từ app tới database.
- Không thêm access token Messenger/Zalo đến khi M3; khi thêm, lưu ở secret manager/backend.
- Host đứng sau proxy chỉ bật `TRUST_PROXY` cho proxy tin cậy; không bật vô điều kiện.

## 3. Quy trình local (sau khi scaffold M1)

Các lệnh dưới đây là **tên script dự kiến**, chưa tồn tại trong repo hiện tại:

```powershell
Copy-Item .env.example .env
docker compose up -d db
npm install
npm run db:migrate:dev
npm run db:seed
npm run dev
```

Ứng dụng dự kiến ở `http://localhost:3000`. Tạo chủ shop bằng lệnh tương tác `npm run admin:create`; không seed tài khoản/mật khẩu chung. Dừng DB bằng `docker compose down`; không dùng `-v` nếu muốn giữ dữ liệu local.

## 4. Phát hành staging/production

1. Review PR: API contract, migration SQL, auth scope, log/PII, secrets.
2. Tạo backup/snapshot trước migration có thay đổi dữ liệu.
3. Build artifact bất biến, pin runtime/dependencies bằng lockfile.
4. Deploy migration đã commit bằng command dành cho production của phiên bản Prisma đã pin; không chạy lệnh reset/dev trên DB production.
5. Deploy app; kiểm tra `/health/live` và `/health/ready`.
6. Chạy smoke flow bằng dữ liệu giả: đăng nhập, catalog, tạo đơn, xem đơn, đổi status, logout.
7. Kiểm tra logs/error rate và DB connection; chỉ mở traffic khi smoke pass.
8. Ghi release ID, migration IDs, backup reference và người phát hành.

Thay schema theo hướng tương thích ngược: add field/table → deploy code đọc/ghi → backfill có kiểm soát → bỏ field cũ trong release sau. Không gộp rename/drop không reversible vào lần deploy đầu.

## 5. Backup và khôi phục

### Chính sách khởi điểm đề xuất

- Backup tự động ít nhất mỗi ngày; giữ 7 bản ngày và 4 bản tuần, mã hóa khi lưu.
- Bật point-in-time recovery nếu nhà cung cấp hỗ trợ và chi phí phù hợp.
- Giới hạn quyền đọc backup; backup production không tải về máy cá nhân.
- Test restore trước go-live và theo lịch tối thiểu mỗi quý; ghi lại thời gian phục hồi, lỗi và người xác nhận.
- Chủ shop/chủ dự án cần chốt RPO/RTO: tối đa mất bao nhiêu dữ liệu và chấp nhận hệ thống dừng bao lâu.

### Khôi phục

1. Tuyên bố incident và dừng ghi mới nếu DB đang lỗi/không nhất quán.
2. Xác định snapshot/PITR point phù hợp; tạo instance khôi phục riêng.
3. Kiểm tra schema, số đơn gần nhất, totals và liên kết item/event.
4. Chuyển app sang DB đã xác minh; không ghi đè nguồn cũ cho đến khi chủ vận hành duyệt.
5. Ghi thời điểm dữ liệu mất (nếu có), nguyên nhân và hành động phòng ngừa.

## 6. Health, log và cảnh báo

- Health: live/readiness; readiness phải báo unhealthy nếu DB không truy cập được.
- Structured logs có `requestId`, route template, status, duration và error code.
- Không log request body của order/login, phone, address, password, cookie, session ID hoặc provider token.
- Cảnh báo: app không ready, tỷ lệ 5xx tăng, DB storage/connection gần giới hạn, backup thất bại, login brute force, migration lỗi.
- Theo dõi số đơn được tạo/đổi trạng thái ở dạng aggregate; không cần theo dõi message body.

## 7. Runbook lỗi thường gặp

### Khách báo “đã đặt” nhưng admin không thấy

1. Tìm theo order number/request ID trong log đã làm sạch.
2. Kiểm tra response/API và record trong DB; UI chỉ được báo thành công sau commit.
3. Nếu khách retry, cùng idempotency key phải trả cùng order; không tạo tay đơn trùng trước khi đối soát.
4. Nếu DB không có đơn, hướng dẫn gửi lại và ghi nhận incident.

### Admin bị đăng xuất liên tục

Kiểm tra cookie Secure/HTTPS, đồng hồ máy chủ, session expiry, proxy `trust` và cấu hình cùng origin. Không khắc phục bằng cách bỏ HttpOnly/SameSite hoặc đưa token vào localStorage.

### Migration/deploy thất bại

Không chạy reset/drop để “sửa nhanh”. Chụp log đã lọc secrets, giữ app phiên bản cũ, kiểm tra migration status và backup; chỉ tiếp tục khi biết schema hiện tại và rollback/forward-fix rõ.

### Backup thất bại

Kiểm tra cảnh báo/provider storage và quyền service account; khởi tạo backup mới, xác nhận restore point; không nhận dữ liệu production nếu không có backup hợp lệ.

## 8. Go-live checklist

- [ ] Domain HTTPS và cùng origin cho UI/API.
- [ ] Admin được tạo riêng, mật khẩu mạnh, không có signup mặc định.
- [ ] Public order rate limit và idempotency hoạt động.
- [ ] DB migration chạy trên staging; backup/restore đã thử.
- [ ] PII không xuất hiện trong log hoặc public response.
- [ ] Security checklist qua; quyền admin đã thử từ anonymous browser.
- [ ] Chính sách lưu/xóa dữ liệu và thông tin liên hệ shop đã duyệt.
- [ ] Có người nhận cảnh báo và biết runbook.
- [ ] Tạo đơn COD giả, xử lý hết trạng thái và xác nhận khách nhận mã đơn.
