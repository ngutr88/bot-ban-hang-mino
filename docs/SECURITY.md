# Bảo mật và dữ liệu khách hàng

## Tình trạng bản hiện tại

Đây là bản mẫu chạy trong trình duyệt, chưa có đăng nhập, phân quyền, backend hoặc database. Form đơn ghi tên, số điện thoại, địa chỉ và ghi chú vào `localStorage` của trình duyệt gửi form. `localStorage` không phải kho dữ liệu bí mật: người dùng máy đó và mã JavaScript cùng origin có thể đọc dữ liệu.

`admin.html` cũng không có xác thực. Nếu publish lên web tĩnh, URL trang quản trị công khai; giao diện ẩn hoặc đường dẫn khó đoán không thay thế đăng nhập. Dữ liệu của mỗi khách không tự chuyển về trang admin của shop.

**Khuyến nghị:** dùng bản hiện tại với dữ liệu giả để trình diễn. Chưa thu thập thông tin liên hệ/địa chỉ thật hoặc coi đây là hệ thống xử lý đơn hàng production.

## Yêu cầu trước khi nhận dữ liệu thật

1. Gửi đơn và tin nhắn tới backend qua HTTPS; chỉ trả xác nhận sau khi backend lưu thành công.
2. Bảo vệ trang và API quản trị bằng đăng nhập; kiểm tra quyền ở server trên từng thao tác và từng bản ghi.
3. Kiểm tra dữ liệu đầu vào, giới hạn kích thước/tần suất, chống gửi đơn lặp và xử lý lỗi an toàn.
4. Chỉ thu thập dữ liệu cần cho giao hàng/chăm sóc; thông báo mục đích, thời hạn lưu và cách yêu cầu chỉnh sửa/xóa.
5. Đặt token Facebook/Zalo và bí mật webhook ở backend hoặc secret manager; không nhúng vào HTML, JavaScript, URL, localStorage hay Git.
6. Xác minh chữ ký webhook, kiểm tra timestamp/replay nếu nhà cung cấp hỗ trợ, và xử lý sự kiện lặp một cách idempotent.
7. Dùng cookie phiên an toàn (HttpOnly, Secure, SameSite) hoặc cơ chế auth phù hợp; không lưu token đăng nhập dài hạn trong localStorage.
8. Sao lưu database có mã hóa và giới hạn quyền truy cập; thử khôi phục định kỳ.
9. Không ghi nội dung tin nhắn, số điện thoại, địa chỉ hoặc token vào log không cần thiết; che dữ liệu khi hỗ trợ/debug.
10. Có quy trình cập nhật dependency, báo cáo sự cố và thu hồi thông tin xác thực bị lộ.

## Khi kết nối nhà cung cấp chat

- Dùng endpoint HTTPS do backend quản lý; xác minh challenge/chữ ký theo tài liệu chính thức của nhà cung cấp.
- Áp dụng quyền API tối thiểu và tách thông tin xác thực theo môi trường.
- Có timeout, retry có giới hạn, nhật ký lỗi không chứa secret và công cụ đối soát tin gửi thất bại.
- Kiểm tra chính sách lưu trữ/chia sẻ dữ liệu của nhà cung cấp trước khi chuyển nội dung chat hoặc thông tin khách.

## Triển khai

- Hosting tĩnh chỉ phục vụ giao diện; nó không tự bảo vệ API hay lưu đơn trên máy chủ.
- Không đưa `admin.html` lên như một công cụ quản trị production khi chưa có cơ chế xác thực phía server.
- Dùng biến môi trường/secret manager cho backend; giới hạn CORS theo origin cần thiết và bật HTTPS.
- Trước mỗi lần phát hành, rà soát cấu hình public, secret trong lịch sử Git, phân quyền, backup và cơ chế xóa dữ liệu.

Tài liệu này là checklist kỹ thuật cho dự án, không thay thế việc đánh giá pháp lý theo thị trường và loại dữ liệu shop xử lý.

## Mô hình đe dọa tối thiểu cho M1

| Tài sản | Rủi ro | Kiểm soát bắt buộc |
|---|---|---|
| Đơn (tên, số điện thoại, địa chỉ) | Bị đọc bởi khách khác, lộ qua log hoặc backup | Admin auth + scope server-side, public response không chứa PII, log tối thiểu, backup có kiểm soát |
| Giá/catalog | Khách sửa request để đặt giá thấp | Server đọc giá từ DB và tính tổng; không nhận price/total có thẩm quyền từ client |
| Tài khoản chủ shop | Brute force, session bị đánh cắp | Password hash qua thư viện uy tín, rate limit, cookie HttpOnly/Secure/SameSite, revoke và hết hạn session |
| Bot content | Stored/reflected XSS từ tên hàng/câu trả lời | Escape theo ngữ cảnh; dùng `textContent` cho nội dung; không nối dữ liệu người dùng vào `innerHTML` |
| Đơn endpoint | Spam, duplicate do retry | Rate limit, validation, body limit, idempotency key, cảnh báo bất thường |
| Database | SQL injection hoặc truy vấn vượt shop scope | ORM/parameterized query, quyền DB tối thiểu, shop scope lấy từ session, FK/check constraints |
| Secrets | Lộ qua Git, browser bundle, logs | Secret manager/environment, review diff, rotate/thu hồi; không đưa vào public config |

## Yêu cầu triển khai session/admin

- Tạo admin qua CLI riêng; không có signup hoặc default password.
- Password hash dùng thuật toán password-hashing hiện hành qua thư viện được duy trì; không tự thiết kế crypto.
- Session ID tạo bằng cryptographically secure random; database giữ hash; cookie không có `Domain` trừ khi cần rõ ràng.
- Mỗi mutation admin kiểm tra cookie, CSRF/origin và quyền shop; 401/403/404 không làm lộ dữ liệu scope khác.
- Login lỗi trả thông báo chung, rate limit và không log password/request body.
- Đăng xuất, đổi password/disable user phải revoke session tương ứng.

## Go-live security gate

- [ ] Admin API từ cửa sổ ẩn danh nhận 401; dữ liệu shop không trả qua public endpoints.
- [ ] Sửa giá hoặc tổng tiền trong request không ảnh hưởng đơn được lưu.
- [ ] Payload HTML/script trong tên hàng, câu trả lời bot, ghi chú và địa chỉ hiển thị dưới dạng text; không chạy script.
- [ ] CSRF/origin request bị từ chối; session cookie có flags production.
- [ ] Login và order endpoint có giới hạn tần suất; body có giới hạn kích thước.
- [ ] Idempotency retry không nhân đôi order; khác payload cùng key bị 409.
- [ ] Không có secret/PII trong bundle frontend, response public, log và Git diff.
- [ ] Restore backup đã thử; có lịch lưu/xóa dữ liệu được chủ shop duyệt.

Danh sách công việc có owner/điểm nghiệm thu nằm ở [kế hoạch triển khai](IMPLEMENTATION_PLAN.md); endpoint/cookie/error contract ở [API contract](API_CONTRACT.md).
