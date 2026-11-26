# Định hướng và lộ trình Mino

## Mục tiêu sản phẩm

Phát triển Mino từ bản mẫu giao diện thành công cụ gọn nhẹ cho shop nhỏ: giới thiệu sản phẩm, trả lời câu hỏi thường gặp, nhận đơn và giúp chủ shop theo dõi khách trên một hệ thống dữ liệu dùng chung.

Ưu tiên theo thứ tự: **đơn hàng không thất lạc → dữ liệu khách được bảo vệ → chủ shop xử lý được hội thoại → kết nối kênh → tự động hóa nâng cao**. Không nên bắt đầu bằng AI hoặc nhiều kênh trước khi luồng đơn và quyền truy cập đáng tin cậy.

## Hiện trạng

- Bốn trang tĩnh, JavaScript/CSS đặt trực tiếp trong các file HTML.
- Bot dò tên sản phẩm và từ khóa, không gọi mô hình AI.
- Cài đặt, đơn và hội thoại ở `localStorage`; không có API hoặc database.
- `admin.html` có dữ liệu minh họa và giao diện quản lý; chưa có đăng nhập hay đồng bộ cho người dùng khác.
- Facebook/Zalo mới có hướng dẫn và ví dụ; chưa có webhook hay thông tin xác thực được cấu hình.

## Các giai đoạn đề xuất

### Giai đoạn 0 — Chốt phạm vi bản mẫu

**Mục tiêu:** người đọc hiểu chính xác bản hiện tại làm được gì và dữ liệu nằm ở đâu.

- Duy trì các trang để xem thử luồng sản phẩm, hỏi đáp và gửi đơn.
- Đánh dấu rõ dữ liệu mẫu, nút/chức năng minh họa và phần tích hợp chưa hoạt động.
- Không nhập dữ liệu cá nhân thật vào bản chưa có backend và kiểm soát truy cập.

**Hoàn thành khi:** README và hướng dẫn không mô tả localStorage như hộp thư/đơn hàng dùng chung; người mới có thể mở bản xem thử mà không hiểu nhầm đây là hệ thống nhận đơn thật.

### Giai đoạn 1 — MVP dùng được cho một shop

**Mục tiêu:** shop nhận được đơn từ nhiều khách và quản lý chúng trong một trang quản trị riêng.

- Thêm backend API và database dùng chung; lưu sản phẩm/cấu hình và đơn COD ở máy chủ. Inbox chat dùng chung chuyển sang Giai đoạn 2.
- Bảo vệ trang quản trị bằng đăng nhập; chỉ API quản trị mới được xem/cập nhật dữ liệu shop.
- Gửi đơn qua API có kiểm tra đầu vào, trạng thái đơn, thời điểm tạo và mã đơn duy nhất.
- Xây danh sách/lọc đơn; trạng thái xử lý tối thiểu: mới, đã xác nhận, đang chuẩn bị, đang giao, hoàn tất, hủy.
- Có xử lý lỗi khi mất mạng, gửi lại an toàn và thông báo xác nhận rõ ràng cho khách.
- Đưa bí mật cấu hình ra khỏi mã nguồn và trình duyệt.

**Hoàn thành khi:** đơn tạo từ một trình duyệt xuất hiện trong trang quản trị ở trình duyệt khác; người chưa đăng nhập không truy cập được API quản trị; thao tác gửi lại không tạo đơn trùng.

### Giai đoạn 2 — Chăm sóc khách và kênh nhắn tin

**Mục tiêu:** chủ shop xử lý hội thoại thật, không chỉ dữ liệu của cùng trình duyệt.

- Chuẩn hóa giao diện chat thành API chung cho website và từng kênh.
- Lưu người gửi, thời gian, kênh, trạng thái đọc và mã sự kiện ngoài để chống xử lý lặp.
- Tạo adapter webhook/inbox cho từng nhà cung cấp; xác minh chữ ký webhook và lưu bí mật ở backend.
- Bắt đầu với **một** kênh bên ngoài sau khi MVP web ổn định; đo lỗi gửi/nhận và có nhật ký xử lý.
- Thêm tìm kiếm khách, gắn nhãn và ghi chú nội bộ gắn với người có quyền.

**Hoàn thành khi:** tin đến từ kênh đã chọn tạo hội thoại trong inbox; câu trả lời từ inbox được gửi ngược qua kênh đó; webhook lặp không tạo tin nhắn trùng.

### Giai đoạn 3 — Vận hành nhiều shop

**Mục tiêu:** mở rộng từ một tài khoản/shop sang nhiều shop mà không rò dữ liệu chéo.

- Mô hình tenant/shop và kiểm tra quyền trên mọi truy vấn dữ liệu.
- Vai trò chủ shop/nhân viên, mời và thu hồi quyền, nhật ký thao tác quản trị.
- Quy trình sao lưu, khôi phục, xuất và xóa dữ liệu theo yêu cầu.
- Theo dõi lỗi, thời gian phản hồi API, số đơn và trạng thái webhook; cảnh báo khi kênh ngừng hoạt động.
- Chỉ bổ sung thanh toán, kho hoặc vận chuyển khi có nhu cầu người dùng cụ thể.

**Hoàn thành khi:** có kiểm thử phân quyền giữa hai shop, có diễn tập khôi phục dữ liệu và chủ shop có thể quản lý nhân viên.

### Giai đoạn 4 — Tự động hóa có kiểm soát

**Mục tiêu:** giảm việc lặp lại nhưng không làm bot bịa giá hoặc cam kết với khách.

- Hoàn thiện bộ luật/từ khóa và câu trả lời mẫu trước; ghi nhận câu hỏi bot không xử lý được.
- Nếu có AI, chỉ dùng lớp tạo câu trả lời có giới hạn và dữ liệu sản phẩm lấy từ nguồn tin cậy.
- Chuyển người thật khi bot thiếu dữ liệu, khách yêu cầu hoặc độ tin cậy thấp.
- Đo tỷ lệ giải quyết, tỷ lệ chuyển người thật, lỗi thông tin và chi phí trước khi mở rộng.

**Hoàn thành khi:** giá/tồn kho không do mô hình tự suy đoán; có thể kiểm tra lịch sử câu trả lời và tắt tự động hóa theo shop/kênh.

## Quyết định kỹ thuật ban đầu

- Giữ HTML/CSS/JS hiện tại làm bản mẫu; chưa cần viết lại toàn bộ giao diện.
- Mặc định cho bản triển khai đầu: Node.js 26 LTS + TypeScript + Fastify; PostgreSQL 18; API REST cùng origin với giao diện; một shop, một chủ shop.
- Dùng schema đầu vào có kiểm tra, migration có lịch sử, phiên đăng nhập phía server và lưu đơn bằng transaction.
- Không thêm hàng đợi, realtime, microservices, thanh toán, kênh ngoài hoặc AI trước khi các luồng đơn cơ bản đạt nghiệm thu.
- Hosting/nhà cung cấp database chưa chốt: quyết định sau khi xác định ngân sách, khu vực lưu dữ liệu và ai chịu trách nhiệm vận hành.

Các chi tiết triển khai, phụ thuộc và tiêu chí nghiệm thu nằm trong [kế hoạch triển khai](IMPLEMENTATION_PLAN.md). Các phiên bản runtime/database được chọn theo trạng thái hỗ trợ tại ngày lập kế hoạch; kiểm tra lại trang phát hành chính thức trước khi tạo môi trường mới.

## Ngoài phạm vi cho đến khi có nhu cầu

- Ứng dụng di động riêng, marketplace, chương trình khuyến mãi phức tạp.
- Thanh toán trực tuyến, đồng bộ kho/vận chuyển đa nhà cung cấp.
- Hỗ trợ tất cả nền tảng chat cùng lúc.
- Dùng AI để tự chốt giá, xác nhận tồn kho hoặc cam kết ngày giao.
