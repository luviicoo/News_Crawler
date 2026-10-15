# Tình trạng tool kéo báo

Cập nhật 15/10/2026. Hướng dẫn lệnh và cấu hình tại [README.md](README.md).

## So với PR-article-scraper cũ

| | Bản cũ | Hiện tại (crawl-news) |
| --- | --- | --- |
| Dữ liệu | Link, ngày, tiêu đề, hãng, sentiment | Toàn văn, tác giả, chuyên mục, tag, sapo, dấu hiệu PR, bài đăng lại, nguồn |
| Lưu trữ | CSV + checkpoint `.state.jsonl` riêng từng lượt | Store SQLite chung (`articles`, `article_contents`, `crawl_runs`…), CSV xuất từ store |
| Phạm vi | Bài nhắc hãng | Thêm tin ngành: 14 truy vấn ngành mỗi profile, nhận cả bài không nhắc hãng nào |
| Tải bài | Chromium cho mọi bài, mở trang Google News để lấy link thật | Giải mã link Google News và tải bài bằng HTTP; Chromium chỉ dự phòng |
| Phân loại | Lúc crawl, cho từng hãng tìm thấy URL | Phase 2 (enrich) riêng; crawl giữ mọi bài đọc được |
| Trùng lặp | Mở lại URL đã đọc cho hãng khác (dùng lại kết quả) | Mỗi URL tải một lần cho mọi hãng và profile |
| Chụp ảnh | Có | Đã bỏ |

## Luồng chạy chính

- Google News RSS tìm từng truy vấn theo tháng, bổ sung từng báo/năm và truy vấn ngành. Feed từ 100 kết quả chia tiếp xuống từng ngày.
- Google Web bổ sung theo tháng và báo/năm, phân trang và báo khi chạm giới hạn.
- Kết quả tìm kiếm và trạng thái truy vấn ghi cùng transaction. Chạy lại cùng lệnh chỉ làm phần chưa xong/lỗi; `--refresh` tìm lại truy vấn đã xong.
- Chống trùng bằng URL chuẩn hoá, canonical cùng tiêu đề và hreflang trên toàn store.
- Enrich phân loại bằng tiêu đề và thân bài (rules của profile + Gemini). Bài nhắc nhiều hãng ghi một lần với nhãn ngành.
- Log `[HEALTH]` báo truy vấn/bài chưa hoàn tất và truy vấn nhiễu. CAPTCHA hoặc lỗi selector không bị coi là "0 bài, đã xong".

## Giới hạn cần hiểu

- Google News và Google Web không phải kho lưu trữ đầy đủ của từng báo. Hoàn tất kế hoạch không bảo đảm mọi bài từng xuất bản đều đã được lập chỉ mục.
- Giải mã link Google News bằng HTTP dùng API nội bộ của Google (`batchexecute`). Nếu Google đổi API, tool mở link bằng trình duyệt. Khi Google chặn (HTTP 429), trình duyệt cũng không mở được vì dùng cùng API, nên link Google News được hoãn 10 phút (gấp đôi mỗi lần còn bị chặn, tối đa 60 phút) trong khi tìm kiếm và các link khác vẫn chạy; giải mã cách nhau `GN_DECODE_DELAY_MS` để hạn chế bị chặn.
- Đo thực tế (14–15/10/2026, một IP): giải mã 3 link/giây bị chặn sau 13 phút, 1 link/giây bị chặn sau khoảng 50 phút; mỗi lần chặn kéo dài nhiều giờ. Mặc định hiện là 2 giây/link, chưa chạy đủ lâu để biết có tránh được chặn. IP VPN (datacenter) bị chặn nhanh hơn và gặp CAPTCHA ở báo nhiều hơn.
- Trang cần JavaScript hoặc có chống bot vẫn phải mở bằng trình duyệt.
- Google Web có thể bị CAPTCHA. Tool chờ xác thực thủ công và giữ truy vấn chưa xong để chạy tiếp; không tự giải CAPTCHA.
- Google Web cho brand có tên quốc tế (Milo) trả về chủ yếu trang bán hàng nước ngoài, và đòi CAPTCHA khoảng 10–15 phút/lần. Cửa sổ CAPTCHA của trang báo chỉ mở cho `captchaDomains` của profile (mỗi báo một lần mỗi lượt); trang khác bị bỏ qua.
- Trình duyệt sập giữa lượt thì lượt dừng (tiến độ vẫn lưu); cần chạy lại cùng lệnh.
- Bài chết link, bị chặn hoặc thiếu ngày đăng được ghi là chưa xác minh, không tự gán ngày.
- Dấu hiệu PR dựa trên nhãn/URL phổ biến của báo Việt Nam. Bài PR không ghi nhãn sẽ không được nhận ra; báo dùng nhãn riêng cần khai báo `prSignals` trong profile.
- Tác giả/chuyên mục/tag/sapo phụ thuộc HTML từng báo; có báo không có các trường này.
- Bộ phân loại vẫn có thể sai. Sentiment bằng rule dựa trên từ điển của profile: bài mỉa mai, giọng gián tiếp hoặc thiếu từ trong từ điển có thể bị chấm sai; bài lẫn lộn mới được Gemini xem lại. `hybrid`/`gemini` cần API key; thiếu key hoặc API lỗi thì dùng xử lý dự phòng.
- Bài import từ bản cũ không có toàn văn cho đến khi enrich tải lại. Bài bản cũ đã loại không có nội dung và không được tải lại.

## Xác minh

- `npm test` kiểm tra kế hoạch, store, resume, dừng, khoá, tải HTTP và dự phòng trình duyệt, giải mã link Google News (dữ liệu mẫu), metadata/PR, enrich, export, import.
- Chạy thử mạng ngày 14/10/2026, Prudential, 01–11/10/2026, chỉ RSS: lưu 78 bài, 76 bài tải bằng HTTP và 2 bài phải dùng trình duyệt. 4 trang mở bằng trình duyệt vẫn không đọc được (trang danh mục hoặc trang cần JavaScript). Export trùng 23/26 bài với CSV cũ cùng khoảng ngày; 3 bài thiếu là bản đăng ở báo khác mà lượt cũ tìm qua Google Web, lượt thử này không chạy Web.
- Import checkpoint dairy cũ (10.160 bài) vào store rồi export ra 10.159 dòng. Dòng thiếu là tin tuyển dụng (vieclam24h.vn), nay bị chặn theo chủ ý.
