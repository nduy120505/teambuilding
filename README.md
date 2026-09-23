# Teambuilding FIT

Website hỗ trợ sự kiện teambuilding: bản đồ chặng thi theo từng đội, điểm số real-time, đổi điểm lấy quà, và vòng chung kết kiểu "Đường lên đỉnh Olympia" (bấm chuông giành quyền trả lời, cảnh báo khi thoát màn hình thi).

## 1. Công nghệ

- Backend: Node.js + Express + Socket.io (realtime) + SQLite (dùng module `node:sqlite` có sẵn trong Node.js — **không cần cài thêm gì, không cần Visual Studio Build Tools**, chỉ cần Node.js bản mới)
- Frontend: HTML/CSS/JS thuần, không cần build

**Yêu cầu**: Node.js **20.x** (LTS mới nhất) hoặc mới hơn. Kiểm tra bằng `node -v`.
> Trước đây bản đầu tiên có dùng thư viện `better-sqlite3`, nhưng thư viện này cần biên dịch native (yêu cầu cài Visual Studio Build Tools trên Windows) nên đã được thay bằng module SQLite tích hợp sẵn trong Node để tránh lỗi cài đặt. Khi chạy sẽ thấy 1 dòng cảnh báo `ExperimentalWarning: SQLite is an experimental feature` — đây là bình thường, không phải lỗi.

## 2. Cài đặt & chạy thử

```bash
npm install
npm start
```

Website có **2 trang đăng nhập độc lập**, không chia sẻ giao diện với nhau:

- **Đội chơi**: `http://localhost:3000/` — chỉ có ô đăng nhập mã đội, không thấy gì liên quan đến quản trị.
- **Ban tổ chức**: `http://localhost:3000/admin/` — trang đăng nhập quản trị riêng, dẫn vào bảng điều khiển tại `/admin/dashboard.html` sau khi đăng nhập.

Khi deploy thật, nên gửi 2 đường link này cho 2 nhóm người khác nhau (đội chơi chỉ nhận link `/`, ban tổ chức dùng riêng link `/admin/`) — mỗi trang có 1 link nhỏ ở cuối để chuyển qua trang còn lại nếu cần, nhưng về giao diện và luồng sử dụng thì hoàn toàn tách biệt.

Lần đầu chạy, hệ thống tự tạo database và dữ liệu mẫu:

- Admin: `admin` / `admin123`
- Đội mẫu: `DOI01`..`DOI04` / mật khẩu `123456`

**Đổi ngay các mật khẩu này trước khi dùng cho sự kiện thật** (sửa trong trang Quản trị > Đội & Điểm, và có thể tạo tài khoản admin mới trực tiếp trong database nếu cần).

Muốn xoá hết dữ liệu và tạo lại từ đầu:

```bash
npm run seed
```

## 3. Cấu trúc tính năng

### Bản đồ & lộ trình riêng từng đội (`/team.html` tab "Bản đồ")
- Có **4 trò cố định** dùng chung cho cả sự kiện: 2 trò **đối kháng**, 1 trò **đơn**, và **Chung kết**. Quản lý danh mục này trong tab **Bản đồ** > "Danh sách trò" (đặt tên, mô tả, loại trò, vị trí x%/y% trên bản đồ, icon).
- **Lộ trình (thứ tự trò + đối thủ) của mỗi đội xếp RIÊNG, không còn giống nhau giữa các đội.** Trong tab **Bản đồ** > "Lộ trình riêng từng đội": chọn 1 đội, bấm "+ Thêm vào lộ trình", chọn trò và số lượt (round) của đội đó; nếu là trò đối kháng thì tick chọn 1 hoặc nhiều đội đối thủ (chọn nhiều đội = trận tam đấu/nhiều đội cùng lúc), nếu là trò đơn/chung kết thì có thể ghi chú tuỳ ý (VD: "Làn 2"). Khi lưu, tất cả các đội trong trận đối kháng đó đều tự động thấy nhau là đối thủ — không cần xếp 2 lần.
- Mỗi đội chỉ nhìn thấy đúng lộ trình của mình (bản đồ dạng ghim + bảng danh sách theo thứ tự lượt), không thấy lộ trình của đội khác.
- Trạng thái từng mục lộ trình (chưa mở / đang thi / hoàn thành) sửa trực tiếp trong modal "Sửa mục lộ trình" của từng đội.
- **Chỗ để chèn thêm sau**: mục "Phần tử tự do trên bản đồ" trong Quản trị cho phép thêm marker/ghi chú/hình ảnh tuỳ ý vào bất kỳ vị trí nào trên bản đồ, hiển thị cho tất cả đội hoặc riêng 1 đội — không cần sửa code khi cần bổ sung nội dung mới.
- **Đổi ảnh nền bản đồ (không qua giao diện, thao tác trực tiếp bằng file)**: copy ảnh bản đồ của bạn vào thư mục `public/img/`, đặt tên file là `map-background.<đuôi ảnh>` — ví dụ `map-background.png` hoặc `map-background.jpg` (đuôi ảnh nào cũng được: png/jpg/jpeg/webp/gif/svg). Hệ thống tự nhận diện file này và dùng làm nền bản đồ cho tất cả các đội ngay lần tải trang kế tiếp, không cần đăng nhập quản trị hay bấm nút gì. Muốn đổi ảnh khác, chỉ cần ghi đè (thay thế) file này bằng ảnh mới, giữ nguyên tên `map-background.<đuôi ảnh cũ hoặc mới>`. Nếu chưa có file này, hệ thống dùng ảnh mẫu mặc định (`map-placeholder.svg`).
  > Lưu ý: các đội đang mở sẵn trang Bản đồ cần tải lại (F5) trang mới thấy ảnh mới — hệ thống không tự đẩy ảnh mới về các máy đang mở sẵn.

### Ảnh nền trang đăng nhập (cả đội chơi và ban tổ chức)
Giống cơ chế ảnh nền bản đồ ở trên — không qua giao diện, chỉ cần copy file: đặt ảnh vào `public/img/`, đặt tên `login-background.<đuôi ảnh>` (VD: `login-background.jpg`). Cả trang đăng nhập của đội (`/`) và của ban tổ chức (`/admin/`) sẽ tự dùng ảnh này làm nền ngay lần tải trang kế tiếp. Nếu chưa có file này, 2 trang đăng nhập giữ giao diện nền tối mặc định như cũ.

### Điểm số
- Quản trị viên cộng/trừ điểm cho từng đội sau mỗi trò chơi (tab "Đội & Điểm" > nút "±Điểm"), có ghi lý do và tên vòng thi.
- Đội xem điểm hiện tại, lịch sử điểm, và bảng xếp hạng — cập nhật realtime ngay khi admin chấm điểm (không cần tải lại trang).

### Đổi quà
- Quản trị viên quản lý danh mục quà (tên, điểm cần đổi, số lượng kho).
- Đội đổi điểm lấy quà trực tiếp trên trang của mình; điểm bị trừ ngay, yêu cầu chuyển sang trạng thái "Chờ duyệt".
- Quản trị viên duyệt / từ chối (tự động hoàn điểm nếu từ chối) / đánh dấu đã giao quà.

### Vòng chung kết (bấm chuông)
Quy trình vận hành cho MC/quản trị viên:

1. Vào tab **Chung kết** trong trang Quản trị, thêm câu hỏi vào "Ngân hàng câu hỏi" từ trước.
2. Chọn 1 câu hỏi ở ô "Chọn câu hỏi để mở chuông" rồi bấm **"Mở câu hỏi & mở chuông"** — tất cả đội đang ở màn hình chờ (`/final.html`) sẽ thấy câu hỏi và nút chuông sáng lên cùng lúc.
3. Đội nào bấm chuông trước sẽ khoá chuông của các đội còn lại và được ban tổ chức hiển thị tên trên màn hình chung.
4. Sau khi đội trả lời (bằng lời nói/micro), quản trị viên bấm **"Trả lời đúng"** (cộng điểm) hoặc **"Trả lời sai"** (trừ điểm, đồng thời tự mở lại chuông cho các đội khác trả lời tiếp).
5. Dùng **"Reset chuông"** nếu cần mở lại chuông cho cùng câu hỏi mà chưa chấm điểm, và **"Đóng câu hỏi"** khi muốn dừng hẳn mà không chấm.

Trang thi của đội (`/final.html`):
- Bắt buộc bấm "Bắt đầu thi" để vào chế độ toàn màn hình trước khi chuông mở.
- Khi người chơi **chuyển tab, thu nhỏ cửa sổ, hoặc thoát toàn màn hình**, hệ thống hiện cảnh báo đỏ toàn màn hình ngay lập tức và gửi realtime bản ghi vi phạm cho ban tổ chức (xem trong tab Chung kết > "Nhật ký vi phạm").
- **Lưu ý quan trọng**: trình duyệt web không cho phép khoá tuyệt đối việc chuyển tab/thoát trang (đây là giới hạn bảo mật của mọi trình duyệt, không riêng hệ thống này). Cơ chế ở đây là **phát hiện + cảnh báo + ghi log** để ban tổ chức xử lý (nhắc nhở, trừ điểm, loại...), không phải khoá cứng 100%.

## 4. Triển khai cho sự kiện thật

Vì có tính năng realtime (Socket.io), trang cần một server chạy liên tục — không phù hợp với hosting tĩnh (Netlify/Vercel static) hay serverless function thông thường.

**Cách 1 — Deploy miễn phí lên Render.com** (khuyên dùng nếu muốn truy cập từ internet, ổn định):
1. Đẩy code này lên 1 Github repository.
2. Trên Render.com: New > Web Service > kết nối repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Thêm biến môi trường `SESSION_SECRET` với 1 chuỗi ngẫu nhiên bất kỳ.
5. Sau khi deploy xong sẽ có link dạng `https://ten-app.onrender.com` — gửi `https://ten-app.onrender.com/` cho các đội, và `https://ten-app.onrender.com/admin/` riêng cho ban tổ chức.

> **⚠️ Lưu ý quan trọng về gói MIỄN PHÍ của Render**: gói free sẽ "ngủ" sau 15 phút không có ai truy cập, và mỗi lần ngủ/thức dậy lại (hoặc mỗi lần deploy lại code), **toàn bộ file `db/teambuilding.db` bị xoá sạch về dữ liệu mẫu ban đầu** — vì gói free không có ổ đĩa lưu trữ lâu dài (persistent disk). Nếu để xảy ra giữa sự kiện thật (VD: giờ nghỉ trưa không ai bấm web >15 phút), điểm số và danh sách đội đã nhập sẽ mất, phải nhập lại từ đầu. Nếu cần dữ liệu không bao giờ mất, nâng lên gói trả phí thấp nhất có hỗ trợ Persistent Disk (gói "Starter", khoảng $7/tháng + phí ổ đĩa theo GB) và gắn 1 ổ đĩa vào đường dẫn `db/` — có thể đăng ký 1 tháng rồi huỷ ngay sau sự kiện.

**Cách 2 — Chạy tại chỗ trong lúc sự kiện** (không cần internet, dùng wifi nội bộ):
1. Chạy `npm start` trên 1 laptop chủ.
2. Các đội và ban tổ chức kết nối cùng mạng wifi/hotspot với laptop đó.
3. Truy cập bằng địa chỉ IP nội bộ của laptop, ví dụ `http://192.168.1.5:3000` (xem IP bằng `ipconfig` trên Windows).
4. Lưu ý: một số trình duyệt di động giới hạn tính năng toàn màn hình khi không chạy HTTPS — nên test trước trên đúng loại thiết bị các đội sẽ dùng.

**Sao lưu dữ liệu**: toàn bộ điểm số, đội chơi, quà tặng được lưu trong file `db/teambuilding.db`. Nên copy file này ra chỗ khác định kỳ trong lúc sự kiện diễn ra để phòng rủi ro.

## 5. Bảo mật trước khi dùng thật

- Đổi mật khẩu admin và mật khẩu từng đội (đặt mật khẩu riêng, không dùng `123456` chung).
- Đặt biến môi trường `SESSION_SECRET` (một chuỗi ngẫu nhiên dài) thay vì dùng giá trị mặc định trong code.
- Nếu deploy public, nên bật HTTPS (Render tự cấp HTTPS miễn phí).
