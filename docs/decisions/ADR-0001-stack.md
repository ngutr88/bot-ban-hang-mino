# ADR-0001: Stack và phạm vi triển khai đầu tiên

- **Trạng thái:** đề xuất; xác nhận ở M0 trước khi scaffold.
- **Ngày:** 2026-11-26.
- **Người quyết định:** chủ dự án.

## Bối cảnh

Repository hiện là bốn trang HTML/JS tĩnh. Đơn lưu trong trình duyệt người gửi, admin không có auth và dữ liệu không dùng chung. MVP cần lưu đơn tập trung và bảo vệ thao tác quản trị nhưng nên giữ giao diện hiện có.

## Quyết định đề xuất

1. Sản phẩm đầu phục vụ **một shop, một chủ shop, website, COD**.
2. Giữ giao diện HTML/CSS/JS; chuyển dữ liệu authoritative sang API/database.
3. Node.js 26 LTS + TypeScript strict + Fastify cho server.
4. PostgreSQL 18 cho dữ liệu nghiệp vụ; Prisma ORM/migration files được commit.
5. Một modular monolith phục vụ UI tĩnh và `/api/v1` cùng origin.
6. Admin đăng nhập bằng account được tạo qua CLI; cookie phiên phía server, không signup công khai.
7. Chưa làm payment, CRM/inbox đa thiết bị, Messenger/Zalo, AI, multi-tenant, queue hoặc microservices trong M1.

## Lý do

- TypeScript giúp tiếp tục dùng hệ sinh thái JS hiện tại, nhưng validation vẫn phải chạy ở server.
- Fastify route schema phù hợp để ràng buộc input/output; không nhận schema do user cung cấp. [Tài liệu validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- PostgreSQL transaction/constraints phù hợp với order + order items cần commit cùng nhau. Bản 18 còn được hỗ trợ tới 2030 theo [versioning policy](https://www.postgresql.org/support/versioning/). PostgreSQL 19 vừa phát hành ngày 19-11-2026 theo [FAQ chính thức](https://www.postgresql.org/about/press/faq/); mặc định 18 để tránh phụ thuộc việc host đã hỗ trợ major mới hay chưa. Nếu host đã hỗ trợ 19 ổn định, chốt lại ở M0.
- Node.js 26 là nhánh LTS theo [release schedule chính thức](https://nodejs.org/en/about/previous-releases) tại ngày ADR.
- Cùng origin giảm cấu hình CORS và cookie so với tách frontend/API ngay từ đầu.
- M1 giữ đủ nhỏ để xác minh nhận đơn và bảo mật trước khi trả chi phí/độ phức tạp cho integrations/AI.

## Hệ quả

- Cần vận hành Node app và PostgreSQL; static hosting đơn thuần không đủ.
- Phải có migration, backup/restore, HTTPS, secrets và theo dõi lỗi trước production.
- Nếu cần nhiều shop/nhân viên hoặc kênh ngoài, cần thêm schema và kiểm thử cô lập trước khi mở.
- Prisma/Node/PostgreSQL versions phải pin bằng lockfile và kiểm tra host compatibility lúc dựng môi trường.

## Khi nào xem xét lại

- Chọn lại hosting/runtime nếu người vận hành không thể quản lý Node/PostgreSQL.
- Chọn dịch vụ auth managed nếu chủ shop không muốn vận hành mật khẩu/session.
- Chọn SQLite chỉ cho local/demo; không thay PostgreSQL production khi cần dùng đồng thời/backup.
- Tách worker/queue khi webhook delivery/retry hoặc tải nền có chỉ số chứng minh cần thiết.
- Đổi database khi có yêu cầu địa điểm dữ liệu, chi phí hoặc provider cụ thể.
