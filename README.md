# 🤖 Mino — Web bán hàng COD + Bot trả lời theo từ khóa (M1 MVP)

Mino là ứng dụng bán hàng trực tuyến gọn nhẹ cho một cửa hàng: khách xem danh sách sản phẩm đang bán, hỏi trợ lý tự động theo từ khóa và gửi đơn COD; chủ shop đăng nhập để cấu hình sản phẩm/kịch bản bot và xử lý đơn hàng tập trung trên cơ sở dữ liệu PostgreSQL.

> 🪪 Mã nguồn mở theo giấy phép **MIT**.

---

## ✨ Tính năng hiện có (M1)

| Trang / Thành phần | Dành cho | Chức năng |
|---|---|---|
| `public/index.html` | 🛒 Khách hàng | Trang bán hàng kết nối API: danh sách sản phẩm đang bán, Web Chat lưu trên server (hỗ trợ cả bot và chủ shop trả lời trực tiếp), đặt đơn COD có chống gửi trùng (`Idempotency-Key`) |
| `public/admin.html` | 📦 Chủ shop | Bảng điều khiển 2 chế độ (yêu cầu đăng nhập): **Đơn hàng COD** và **Hộp thư Chat (Inbox)** có tiếp quản (human takeover), ghi chú nội bộ tách biệt và tự khớp đơn theo SĐT |
| `public/caidat.html` | ⚙️ Chủ shop | Cài đặt cửa hàng (yêu cầu đăng nhập): cập nhật tên/liên hệ shop, thêm/sửa/ẩn sản phẩm và quản lý bảng luật từ khóa của bot |
| `public/huong-dan.html` | 📘 Mọi người | Hướng dẫn khởi tạo môi trường, tạo tài khoản chủ shop và quy trình xử lý đơn COD |
| `src/` + `prisma/` | 🖥️ Backend | Fastify API (`/api/v1`), xác thực phiên cookie `HttpOnly` + CSRF/Origin, Web Chat, tích hợp webhook Facebook Messenger (HMAC-SHA256 + Outbox retry), Prisma ORM và schema/migration PostgreSQL |

> **Phạm vi giai đoạn sau (chưa kích hoạt ở M3):** Các kênh phụ bổ sung (như Zalo OA) và đa cửa hàng / AI có kiểm soát (M4).

---

## 🚀 Chạy môi trường phát triển local

### 1. Yêu cầu
- **Node.js** `>= 24` (khuyến nghị Node.js LTS)
- **PostgreSQL 18** (qua Docker Compose hoặc cài đặt local)

### 2. Khởi tạo nhanh

```powershell
# 1. Tạo file biến môi trường local (không commit lên Git)
Copy-Item .env.example .env
# Chỉnh sửa .env: đặt SESSION_SECRET ngẫu nhiên tối thiểu 32 ký tự và DATABASE_URL phù hợp

# 2. Cài đặt dependencies
npm install

# 3. Khởi động PostgreSQL qua Docker Compose
docker compose up -d db

# 4. Chạy migration và nạp dữ liệu mẫu
npm run db:migrate:dev
npm run db:seed

# 5. Tạo tài khoản quản trị chủ shop (nhập email & mật khẩu >= 12 ký tự)
npm run admin:create

# 6. Chạy ứng dụng
npm run dev
```

> 💡 **Nếu máy chưa bật Docker Desktop:** bạn có thể chạy ngay bằng PostgreSQL nhúng (lưu dữ liệu cục bộ tại `.pglite/dev-db`, tự động chạy migration + seed mẫu) với lệnh `npm run dev:embedded`, và mở một cửa sổ terminal khác chạy `npm run admin:create` để tạo tài khoản chủ shop.

Mở trình duyệt tại `http://localhost:3000`:
- Trang bán hàng: `http://localhost:3000/`
- Cài đặt shop & sản phẩm: `http://localhost:3000/caidat.html`
- Quản lý đơn COD: `http://localhost:3000/admin.html`
- Kiểm tra health: `http://localhost:3000/health/live` và `http://localhost:3000/health/ready`

---

## 🧪 Kiểm thử & Kiểm tra chất lượng mã

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

> Bộ kiểm thử tích hợp (`npm test`) tự động khởi chạy PostgreSQL nhúng (PGlite) để kiểm tra thực tế migration SQL, ràng buộc khóa ngoại/check constraint, giao dịch đơn hàng, phân quyền session/CSRF và luồng E2E ngay cả khi máy chưa bật Docker; hoặc dùng `TEST_DATABASE_URL` nếu muốn trỏ vào PostgreSQL ngoài.

---

## 📚 Tài liệu dự án

- [Yêu cầu sản phẩm (PRD)](docs/PRODUCT_REQUIREMENTS.md)
- [Kế hoạch triển khai theo thứ tự](docs/IMPLEMENTATION_PLAN.md)
- [Định hướng và lộ trình phát triển](docs/ROADMAP.md)
- [Kiến trúc hệ thống](docs/ARCHITECTURE.md)
- [Thiết kế dữ liệu](docs/DATA_MODEL.md)
- [Hợp đồng API](docs/API_CONTRACT.md)
- [Hướng dẫn phát triển và chạy local](docs/DEVELOPMENT.md)
- [Lưu ý bảo mật và dữ liệu khách hàng](docs/SECURITY.md)
- [Vận hành và phát hành](docs/OPERATIONS.md)
- [Quyết định stack (ADR-0001)](docs/decisions/ADR-0001-stack.md)

## 📄 Giấy phép

[MIT](LICENSE)
