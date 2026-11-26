# Yêu cầu sản phẩm — Mino MVP

**Trạng thái:** đề xuất để triển khai. Đây là mục tiêu cần xây, không phải mô tả chức năng đã có trong repository.

## 1. Tóm tắt

Mino là công cụ bán hàng tối giản cho một shop: khách xem sản phẩm và tạo đơn COD; chủ shop đăng nhập để sửa sản phẩm/câu trả lời bot, xem đơn ở máy khác và cập nhật trạng thái. Sau khi luồng đơn ổn định, sản phẩm bổ sung inbox chat dùng chung và từng kênh ngoài.

## 2. Vấn đề cần giải quyết

Bản hiện tại chạy trong trình duyệt và ghi đơn vào `localStorage` của người gửi. Shop không nhận được dữ liệu của khách ở thiết bị khác, không có tài khoản quản trị và không có lưu trữ bền vững. MVP cần chuyển nguồn dữ liệu chính sang máy chủ và xác nhận đơn chỉ sau khi lưu thành công.

## 3. Người dùng

| Người dùng | Nhu cầu |
|---|---|
| Khách mua hàng | Xem giá đúng, hỏi câu cơ bản, gửi đơn COD nhanh, biết đơn đã được ghi nhận hay chưa |
| Chủ shop | Đăng nhập, sửa catalog/câu trả lời, nhận và tra cứu đơn, cập nhật tình trạng xử lý |
| Nhân viên | Chưa thuộc MVP; dự kiến ở giai đoạn nhiều người dùng/shop |

## 4. Giả định mặc định

Các giả định này giúp bắt đầu mà không cần chờ một nền tảng lớn; chủ dự án cần xác nhận trước khi triển khai production:

- Một shop và một tài khoản chủ shop trong MVP.
- Giao diện tiếng Việt; tiền VND; múi giờ hiển thị `Asia/Ho_Chi_Minh`; timestamps lưu UTC.
- Website là kênh bán hàng đầu tiên; phương thức thanh toán là COD.
- Chưa thu tiền online, chưa tính phí vận chuyển tự động, chưa đồng bộ tồn kho/vận chuyển.
- Bot vẫn theo luật từ khóa/câu trả lời cấu hình; chưa gọi AI.
- Không quản lý tồn kho trong M1; không được báo “còn hàng” như sự thật nếu shop chưa tích hợp dữ liệu tồn kho.
- Inbox chat và Messenger/Zalo không nằm trong lần phát hành đầu; xem mốc M2/M3 trong kế hoạch.
- Khách không cần tạo tài khoản để đặt đơn.

## 5. Mục tiêu và cách đo

### Mục tiêu MVP

1. Đơn hợp lệ được lưu trên server và hiện trong trang quản trị ở một trình duyệt khác.
2. Gửi lại cùng yêu cầu do timeout không tạo đơn trùng.
3. Giá/tổng đơn được tính từ dữ liệu server, không tin giá do trình duyệt gửi.
4. API quản trị từ chối người chưa đăng nhập.
5. Chủ shop tìm đơn, xem thông tin giao hàng và cập nhật trạng thái.

### Chỉ số nghiệm thu

- 100% ca nghiệm thu hợp lệ tạo một đơn duy nhất và đơn xuất hiện sau khi tải lại trang quản trị.
- Mọi trạng thái đơn có lịch sử người thực hiện và thời điểm.
- Yêu cầu không hợp lệ bị từ chối mà không tạo bản ghi đơn.
- Không có token, mật khẩu, số điện thoại hoặc địa chỉ đầy đủ trong log ứng dụng thông thường.

## 6. Phạm vi MVP (M1)

### Dành cho khách

- Xem sản phẩm đang bán, giá VND và thông tin shop.
- Chatbot trả lời câu đã cấu hình theo luật; câu không khớp dùng fallback. Bot không được bịa giá/tồn kho.
- Tạo đơn COD gồm một hoặc nhiều sản phẩm, số lượng, tên người nhận, số điện thoại, địa chỉ và ghi chú tùy chọn.
- Hiển thị mã đơn sau phản hồi thành công của server; có thông báo có thể thử gửi lại nếu mạng lỗi.
- Phí vận chuyển được shop xác nhận sau khi nhận đơn; UI nói rõ tổng cuối cùng chưa gồm phí ship và shop sẽ liên hệ xác nhận.

### Dành cho chủ shop

- Đăng nhập/đăng xuất bằng tài khoản được tạo qua lệnh quản trị, không có tự đăng ký công khai.
- Tạo/sửa/ẩn sản phẩm; chỉnh câu hỏi, từ khóa, câu trả lời và câu fallback.
- Danh sách đơn mới nhất, lọc trạng thái, xem chi tiết và cập nhật trạng thái.
- Chỉ một tài khoản chủ shop; mọi endpoint admin đều yêu cầu phiên hợp lệ.

### Dữ liệu và vận hành

- PostgreSQL là nguồn dữ liệu chính; migration được commit trong Git.
- Ghi dấu thời gian, mã đơn, snapshot tên/giá sản phẩm tại lúc đặt và lịch sử đổi trạng thái.
- Một môi trường local và một staging riêng trước production.

## 7. Ngoài phạm vi M1

- Inbox hội thoại dùng chung, chat người thật, CRM/lead pipeline.
- Tích hợp Messenger, Zalo OA, email, SMS hoặc WhatsApp.
- AI sinh câu trả lời, thanh toán online, mã giảm giá, vận chuyển và tồn kho.
- Nhiều shop, nhiều nhân viên, phân vai phức tạp, subscription.
- Báo cáo tài chính/kế toán.

## 8. Yêu cầu chức năng (FR)

| ID | Yêu cầu | Tiêu chí chấp nhận |
|---|---|---|
| FR-01 | Catalog chỉ trả sản phẩm đang bán | Sản phẩm ẩn/lưu trữ không xuất hiện ở trang khách |
| FR-02 | Giá hiển thị và giá đặt lấy từ server | Sửa giá trong trình duyệt không làm thay đổi tổng đơn |
| FR-03 | Tạo đơn COD | Server kiểm tra sản phẩm, số lượng, liên hệ và tạo mã đơn duy nhất |
| FR-04 | Gửi lặp an toàn | Cùng idempotency key và cùng payload trả lại cùng đơn; khác payload bị từ chối |
| FR-05 | Xác nhận đơn trung thực | UI chỉ báo đặt thành công sau HTTP thành công từ API; ghi rõ phí ship/tổng cuối sẽ được shop xác nhận |
| FR-06 | Đăng nhập chủ shop | Không có endpoint tự đăng ký; mật khẩu không lưu dạng rõ |
| FR-07 | Bảo vệ API admin | Không phiên trả 401; sai phạm vi/quyền trả 403; không lộ dữ liệu đơn |
| FR-08 | Quản lý sản phẩm/luật bot | Chỉ chủ shop đã đăng nhập được tạo/sửa/ẩn |
| FR-09 | Tra cứu đơn | Admin lọc theo trạng thái, xem chi tiết, phân trang |
| FR-10 | Cập nhật trạng thái đơn | Chỉ chuyển theo state machine; thao tác được ghi vào lịch sử |
| FR-11 | Dữ liệu bền vững | Refresh hoặc dùng trình duyệt khác vẫn thấy dữ liệu đã lưu |
| FR-12 | Lỗi dễ hiểu | UI hiển thị lỗi có thể xử lý, không hiển thị stack trace hoặc SQL |

## 9. Yêu cầu phi chức năng (NFR)

- Bảo mật: HTTPS; cookie phiên `HttpOnly`, `Secure` ở production, `SameSite`; giới hạn đăng nhập/đặt đơn; xác thực đầu vào tại server.
- Tính toàn vẹn: tạo order và order items trong transaction; snapshot giá/tên; chống trùng bằng idempotency key.
- Khả năng vận hành: health/live và health/ready; log có request ID, không log PII mặc định.
- Khả năng bảo trì: TypeScript strict; schema API có version; migration có thể xem và review.
- Khả năng truy cập: form có label, lỗi gắn trường, dùng được trên màn hình điện thoại và bàn phím.
- Sao lưu: có quy trình backup/restore được thử trước khi nhận đơn thật.
- Mục tiêu tải/uptime sẽ được chốt khi biết số khách/đơn và ngân sách; không đặt SLO giả trước khi có hosting.

## 10. Luồng chính

### Khách đặt đơn

1. Tải catalog từ API.
2. Chọn sản phẩm/số lượng và điền liên hệ.
3. Giao diện gửi các product ID/quantity và idempotency key.
4. API kiểm tra lại giá/trạng thái, tính tổng, lưu đơn + items trong một transaction.
5. API trả mã đơn; nếu timeout, giao diện giữ key và gửi lại cùng payload.

### Chủ shop xử lý đơn

1. Đăng nhập; server tạo phiên cookie.
2. Trang admin tải danh sách qua endpoint có xác thực.
3. Chủ shop mở đơn, gọi xác nhận thông tin/phí ship; khi chọn `confirmed`, nhập phí ship.
4. Server kiểm tra chuyển trạng thái, tính tổng cuối, cập nhật đơn và ghi event audit trong cùng transaction.

## 11. Rủi ro sản phẩm cần chốt

- Ai là người chịu trách nhiệm tiếp nhận đơn ngoài giờ và xác nhận tồn kho?
- Có cần cho phép một đơn gồm nhiều sản phẩm? (Mặc định: có.)
- Phí ship do shop ghi tay hay cần biểu phí? (Mặc định M1: chủ shop nhập phí khi xác nhận đơn; chưa tự tính.)
- Thời hạn giữ đơn và thời gian lưu PII cần theo chính sách shop/quy định áp dụng; không tự đặt trong mã.
- Chọn hosting và khu vực database sau khi xác nhận ngân sách, quyền truy cập và phương án backup.
