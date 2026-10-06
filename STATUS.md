# Tình trạng tool kéo báo

Cập nhật 06/10/2026. Hướng dẫn lệnh và cấu hình tại [README.md](README.md).

## Luồng chạy chính đã sửa

- Google News RSS tìm từng từ khóa theo tháng và bổ sung từng báo/năm, độc lập với số kết quả feed. Vẫn giữ truy vấn toàn khoảng để không bỏ kết quả do thứ hạng khác nhau.
- Feed từ 100 kết quả chia tiếp xuống từng ngày; giữ kết quả cha/con và ghi những ngày vẫn chạm giới hạn.
- Google Web bổ sung theo tháng và từng báo/năm ngay cả khi RSS có kết quả; phân trang và báo khi chạm giới hạn.
- Tải và đọc thân bài trước khi phân loại; giữ tin ngành nhắc nhiều hãng cho từng hãng có mặt trong nội dung. Không nhận chỉ vì tên hãng có trong URL hoặc tin liên quan.
- Chống trùng bằng URL chuẩn hóa, canonical cùng tiêu đề và hreflang; lưu liên kết định danh cùng bài đã nhận để khôi phục khi chạy tiếp.
- Nhật ký `.state.jsonl` lưu URL tìm được và kết quả xử lý; CSV có thể được dựng lại từ nhật ký sau khi dừng. Khóa PID ngăn hai tiến trình ghi chung checkpoint.
- Chạy lại cùng lệnh chỉ thử phần chưa xong/lỗi. `--refresh` mới tìm lại các truy vấn đã xong để phát hiện bài mới được lập chỉ mục.
- Báo cáo `.coverage.json` có toàn bộ truy vấn, số bài mỗi năm và các truy vấn/bài chưa hoàn tất. Không đổi CAPTCHA hoặc lỗi selector thành kết quả rỗng thành công.
- CSV là mặc định; tìm kiếm/tải/chụp đều chạy ẩn, cửa sổ riêng chỉ mở khi cần giải CAPTCHA.

## Giới hạn cần hiểu

- Google News và Google Web không phải kho lưu trữ đầy đủ của từng báo. Chưa có bộ RSS/sitemap/archive riêng của mỗi nguồn. Hoàn tất kế hoạch không bảo đảm mọi bài từng xuất bản đều đã được lập chỉ mục.
- Google Web có thể bị CAPTCHA. Tool chờ xác thực thủ công và giữ truy vấn chưa xong để chạy tiếp; không tự giải CAPTCHA. Tăng `--web-pages` để xử lý truy vấn còn chạm giới hạn.
- Bài chết link, bị chặn hoặc thiếu ngày đăng nằm trong báo cáo chưa xác minh, không được tự gán ngày và đưa vào CSV.
- Bộ phân loại vẫn có thể sai; lấy vùng nội dung phụ thuộc cấu trúc HTML từng báo. `hybrid`/`gemini` cần API key; thiếu key/API lỗi dùng dự phòng.
- Hai bản ngôn ngữ khác slug mà không khai báo hreflang vẫn có thể còn trùng. Bài đăng ở các báo khác nhau được giữ riêng theo chủ ý. ID được giữ trong cùng checkpoint; hai lượt kéo độc lập có thể chọn URL đại diện khác nhau.
- Checkpoint mới không tự kế thừa CSV của các lượt rà thủ công trước đây. File Prudential đã rà có 1.403 bài được giữ riêng.

## Xác minh

- Kiểm thử kế hoạch, đọc thân bài, retry/resume, dừng, khóa, khôi phục CSV và CAPTCHA trong `test/`.
- Chạy thử mạng trên Prudential/VnExpress tháng 01/2018: RSS tìm và tải được một bài nhắc Prudential trong thân bài. Google Web gặp CAPTCHA; truy vấn được ghi là lỗi chưa hoàn tất trong báo cáo, không báo đủ dữ liệu.
- Đọc kết quả kiểm thử mới nhất bằng `npm test`; test mạng phía trên là lượt chạy riêng, không phải cam kết Google luôn truy cập được.
