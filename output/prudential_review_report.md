# Rà dữ liệu Prudential — lượt kiểm tra thứ hai, 06/10/2026

Khoảng yêu cầu: 01/01/2018–30/09/2026. Chạy ẩn, không chụp ảnh.

- Trước lượt rà này: 522 bài. Sau rà: **1,403 bài không trùng**.
- Bổ sung 882 bài; loại 1 dòng cũ chỉ có tín hiệu Prudential từ tin liên quan. Tăng ròng 881 bài.
- 557 bài có Prudential trong tiêu đề; 846 bài nhắc Prudential trong nội dung chính.
- Loại thêm 26 dòng ứng viên đã nhận tạm vì thuộc thực thể khác, tin liên quan hoặc trang tag/hồ sơ. Chi tiết nằm trong prudential_review_excluded.csv.
- Sửa tiêu đề và giờ đăng của một dòng Vietcap sau khi đối chiếu trang bài viết.

## Cách rà và nguyên nhân bỏ sót

1. Chạy 105 khoảng theo tháng, bổ sung 144 truy vấn theo từng báo/năm trên Google News RSS. Có thêm bài khi tìm riêng từng nguồn dù truy vấn thương hiệu chung chưa chạm 100 kết quả. Những feed đạt giới hạn tiếp tục được chia khoảng ngày.
2. Tìm thêm qua 160 truy vấn web theo báo/năm; 8 truy vấn khảo sát ban đầu không thay thế các lượt tìm theo nguồn. Tổng cộng đối chiếu 3.785 URL ứng viên, mở bài và kiểm tra ngày đăng, nội dung chính, URL cuối/canonical.
3. Bộ phân loại một thương hiệu bỏ qua nhiều bài ngành có đồng thời Prudential và hãng khác. Lượt rà này giữ các bài đó khi xác minh được Prudential Việt Nam trong thân bài.
4. Sửa bộ đọc thân bài: ưu tiên vùng nội dung của báo thay vì wrapper articleBody bao cả trang; bỏ các khối tin liên quan, gồm tin-lien-quan và các article lồng nhau.
5. Phân biệt Prudential Việt Nam với Prudential Finance, Prudential Financial, Prudential Center/Tower và thuật ngữ quản lý “prudential”. Bài nói về tập đoàn mẹ hoạt động tại Việt Nam vẫn được giữ khi có ngữ cảnh Việt Nam rõ ràng.

## Phân bố theo năm

| Năm | Trước rà | Sau rà | Có tên trong tiêu đề | Chỉ nhắc trong nội dung |
| --- | ---: | ---: | ---: | ---: |
| 2018 | 14 | 59 | 22 | 37 |
| 2019 | 26 | 86 | 30 | 56 |
| 2020 | 26 | 81 | 43 | 38 |
| 2021 | 32 | 124 | 40 | 84 |
| 2022 | 33 | 123 | 44 | 79 |
| 2023 | 82 | 226 | 73 | 153 |
| 2024 | 57 | 162 | 59 | 103 |
| 2025 | 100 | 245 | 101 | 144 |
| 2026 (đến 30/9) | 152 | 297 | 145 | 152 |
| **Tổng** | **522** | **1403** | **557** | **846** |

Đây là tập bài có nhắc Prudential Việt Nam: bao gồm PR thương hiệu, bài ngành, phản ánh khách hàng và các nhắc đến có thật trong nội dung chính; không phải toàn bộ đều tập trung vào Prudential hoặc là PR tích cực.

## Kiểm tra và giới hạn

- Mã bài và URL không trùng; ngày đăng nằm trong khoảng yêu cầu. Giữ 521/522 dòng cũ; dòng bị loại có lý do trong file excluded.
- Kiểm tra nội dung riêng 870 dòng không có Prudential trong tiêu đề, gồm dòng cũ và ứng viên bổ sung. Không còn dòng chưa xác minh; nội dung đã lấy bằng bộ đọc sửa được tái sử dụng để tránh tải lại.
- 21 kiểm thử qua, gồm hồi quy wrapper chứa tin liên quan và phân biệt các thực thể Prudential. Kiểm tra trực tiếp bài Lao Động về nông sản cho thấy thân bài không còn nhận nhầm Prudential từ tin liên quan.
- Ba nguồn không đọc lại được qua crawler đã được đối chiếu qua trang bài viết: [Vietcap](https://trading.vietcap.com.vn/ai-news/post-detail/manulife-prudential-lo-nang-tu-kinh-doanh-bao-hiem-vi-sao-dai-ichi-life-van-lai-dam-hon-5000-ty), [Công an TP.HCM](https://congan.com.vn/an-ninh-kinh-te/khoi-to-10-doi-tuong-lam-gia-ho-so-bao-hiem-chiem-doat-gan-550-trieu-dong_183714.html), [Bình Phước](https://baobinhphuoc.com.vn/news/249/137190/thong-bao-prudential-thay-doi-dia-chi). Ba truy vấn web và một truy vấn RSS riêng được dùng để rà các đường dẫn chưa xử lý được ở bước cuối.
- 1 URL ứng viên không lấy được bài/ngày đáng tin cậy sau khi thử lại. Không dùng RSS đơn thuần để tạo dòng mới cho các URL này. Danh sách nằm trong prudential_review_summary.json.
- Chỉ mục RSS/web, bài đã gỡ hoặc nguồn không truy cập được vẫn có thể gây thiếu. Chưa thể khẳng định đây là toàn bộ bài đã từng xuất bản.
