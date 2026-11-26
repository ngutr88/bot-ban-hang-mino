# Hướng dẫn phát triển

## Yêu cầu môi trường

- **Node.js** `>= 24` (khuyến nghị nhánh LTS hiện hành).
- **PostgreSQL 18** (chạy qua `docker compose up -d db` hoặc dịch vụ PostgreSQL cài sẵn trên máy).
- Trình duyệt hiện đại (Chrome, Edge hoặc Firefox).

## Cấu trúc mã nguồn (M1)

| Đường dẫn | Vai trò |
|---|---|
| `public/` | 4 trang giao diện tĩnh (`index.html`, `caidat.html`, `admin.html`, `huong-dan.html`) được Fastify phục vụ cùng origin |
| `src/app.ts`, `src/server.ts` | Khởi tạo Fastify server, cấu hình validation Ajv, error handler chuẩn, security headers và routes |
| `src/config/env.ts` | Đọc và kiểm tra biến môi trường lúc khởi động |
| `src/modules/auth/` | Mã hóa mật khẩu Argon2id, phiên cookie `mino_session` (`HttpOnly`), kiểm tra `Origin` và `X-CSRF-Token` |
| `src/modules/shop/` | API cấu hình cửa hàng public/admin |
| `src/modules/products/` | API danh mục sản phẩm (lọc `active` cho khách, CRUD + phân trang cursor cho admin) |
| `src/modules/bot-rules/` | API kịch bản từ khóa theo thứ tự ưu tiên |
| `src/modules/orders/` | Tạo đơn COD chống trùng (`Idempotency-Key`), lưu snapshot giá và chuyển trạng thái theo state machine |
| `src/cli/create-admin.ts` | CLI tương tác tạo tài khoản chủ shop |
| `prisma/` | `schema.prisma`, lịch sử SQL migration (`prisma/migrations/`) và `seed.ts` |
| `tests/` | Unit tests và integration/E2E tests trên PostgreSQL thật |

## Quy trình chạy local

1. Sao chép file biến môi trường:
   ```powershell
   Copy-Item .env.example .env
   ```
   Cập nhật `DATABASE_URL` và tạo `SESSION_SECRET` ngẫu nhiên dài ít nhất 32 ký tự.
2. Cài đặt gói phụ thuộc:
   ```powershell
   npm install
   ```
3. Khởi động PostgreSQL local và chạy migration + seed dữ liệu mẫu:
   ```powershell
   docker compose up -d db
   npm run db:migrate:dev
   npm run db:seed
   ```
4. Tạo tài khoản chủ shop qua CLI tương tác (không có mật khẩu mặc định):
   ```powershell
   npm run admin:create
   ```
5. Khởi chạy server phát triển:
   ```powershell
   npm run dev
   ```
   Mở `http://localhost:3000`.

## Các lệnh script chính

| Lệnh | Mục đích |
|---|---|
| `npm run dev` | Chạy server ở chế độ watch (`tsx watch src/server.ts`) |
| `npm run build` | Biên dịch TypeScript sang `dist/` |
| `npm start` | Chạy bản build production (`node dist/server.js`) |
| `npm run typecheck` | Kiểm tra kiểu TypeScript (`tsc --noEmit`) |
| `npm run lint` | Kiểm tra quy tắc mã nguồn với ESLint |
| `npm test` | Chạy toàn bộ unit + integration/E2E tests bằng Vitest |
| `npm run db:generate` | Sinh lại Prisma Client |
| `npm run db:migrate:dev` | Chạy migration trong môi trường phát triển |
| `npm run db:migrate:deploy` | Áp dụng các migration đã commit trên staging/production |
| `npm run db:seed` | Nạp dữ liệu mẫu idempotent (tự từ chối nếu `NODE_ENV=production`) |
| `npm run admin:create` | Tạo tài khoản chủ shop mới qua prompt |

## Quy tắc đóng góp

- Giữ giao diện tiếng Việt, trung thực với chức năng đang hỗ trợ; không để bot tự khẳng định tồn kho khi chưa có nguồn tồn kho thật.
- Mọi thay đổi schema phải tạo migration mới trong `prisma/migrations/`; không sửa migration đã chạy ở staging/production.
- Không đưa secrets, token hoặc thông tin cá nhân của khách thật vào Git, frontend hay log ứng dụng.
- Cập nhật `docs/API_CONTRACT.md` và kiểm thử trong `tests/` đồng bộ khi sửa đổi endpoint.
