# News Crawler

Thu thập bài báo về 9 thương hiệu bảo hiểm Việt Nam bằng Node.js (CommonJS) và Playwright Chromium, lọc theo ngày, phân loại và xuất CSV tương thích Excel.

Repository: [luviicoo/News_Crawler](https://github.com/luviicoo/News_Crawler). Đây là dự án độc lập, cài đặt và chạy bằng Node.js; toàn bộ mã nguồn, cấu hình và kiểm thử nằm trong repository này.

## Cài đặt trên Windows

Yêu cầu Node.js 18 trở lên. Trong PowerShell:

```powershell
git clone https://github.com/luviicoo/News_Crawler.git
cd News_Crawler
npm.cmd ci
npx.cmd playwright install chromium
if (-not (Test-Path -LiteralPath .env)) {
  Copy-Item -LiteralPath .env.example -Destination .env
}
```

Chỉ sao chép file mẫu khi chưa có `.env` để tránh ghi đè cấu hình. Dùng `npm.cmd` và `npx.cmd` nếu PowerShell chặn script `.ps1`.

Chạy các lệnh npm từ thư mục gốc chứa `package.json`. Có thể đặt bản clone ở bất kỳ thư mục nào. `.env`, phiên Google và đầu ra crawler mặc định đều nằm trong bản clone đó.

## Chạy crawler

```powershell
# Mở cửa sổ trình duyệt
npm.cmd start

# Chạy ẩn trình duyệt
npm.cmd run start:headless

# Khoảng ngày gồm cả ngày đầu và ngày cuối
npm.cmd run start:headless -- --date-from 2026-09-01 --date-to 2026-09-13
```

Mặc định lấy 7 ngày tính cả hôm nay theo giờ Việt Nam (UTC+7). Có thể đặt `DATE_FROM` và `DATE_TO` trong `.env`; tham số dòng lệnh được ưu tiên. Cung cấp cả hai ngày theo định dạng `YYYY-MM-DD`. Nếu thiếu một đầu khoảng, chương trình dùng khoảng mặc định; nếu ngày đầu lớn hơn ngày cuối, chương trình tự đổi thứ tự.

Các thương hiệu: Sun Life, Chubb Life, FWD, Dai-ichi Life, AIA, Bảo Việt Nhân Thọ, Prudential, Manulife và Generali. Sửa tên, bí danh và truy vấn tại `src/config/brands.js`.

## Luồng xử lý

1. Tìm qua Google News RSS; nếu RSS lỗi hoặc không có kết quả, chuyển sang tìm bằng trình duyệt.
2. Phân loại thẻ kết quả để loại tin không liên quan, xác định thương hiệu và sắc thái.
3. Chuẩn hóa URL và loại trùng theo từng thương hiệu trong lần chạy. Bài nhắc nhiều thương hiệu có thể xuất hiện cho nhiều thương hiệu. Key so trùng bỏ qua ngôn ngữ (`/vn/` ↔ `/en/`), AMP, bản mobile, tham số tracking; luật nằm ở `src/config/urlIdentity.js`.
4. Tải chi tiết bài với số tác vụ đồng thời giới hạn; lấy tiêu đề, URL cuối và ngày đăng từ metadata, JSON-LD, URL hoặc văn bản trang.
5. Loại bài không xác định được ngày hoặc nằm ngoài khoảng ngày; bỏ nguồn trong danh sách chặn của `src/index.js`.
6. Loại trùng lần hai sau khi mở bài (`src/parser/articleIdentity.js`): so URL cuối, link hreflang (bản ngôn ngữ khác, kể cả khác slug) và canonical/og:url (chỉ gộp khi cùng tiêu đề). Bài trùng ghi log `[SKIP_SAME_ARTICLE]`, không chụp ảnh.
7. Chụp phần đầu trang của bài hợp lệ và ghi từng dòng CSV kèm `article_id`.
8. Cuối run in các dòng `[HEALTH]`: số bài đã gộp, brand 0 bài, query bị CAPTCHA, nghi selector Google hỏng.

Phân loại diễn ra trước khi tải chi tiết bài và chủ yếu dựa trên dữ liệu tìm kiếm trong luồng crawler hiện tại. Lỗi chụp ảnh được ghi log và không nhất thiết làm mất dòng CSV.

## Cấu hình

`.env` luôn được đọc tại gốc scraper, kể cả khi gọi từ thư mục khác.

| Biến | Mặc định trong mã | Ý nghĩa |
| --- | --- | --- |
| `HEADLESS` | `false` | Đặt `true` để ẩn trình duyệt; `--headless` cũng bật chế độ này |
| `DATE_FROM`, `DATE_TO` | 7 ngày gần nhất | Khoảng ngày theo giờ Việt Nam |
| `ARTICLE_CONCURRENCY` | `3` | Số bài tải đồng thời trong mỗi truy vấn |
| `PAGE_TIMEOUT` | `30000` | Thời gian chờ điều hướng, mili giây |
| `SEARCH_DELAY_MIN`, `SEARCH_DELAY_MAX` | `3000`, `6000` | Khoảng nghỉ trước mỗi truy vấn, mili giây |
| `ARTICLE_DELAY_MIN`, `ARTICLE_DELAY_MAX` | `500`, `1500` | Khoảng nghỉ tải bài, mili giây |
| `CAPTCHA_PAUSE_MS` | `30000` | Thời gian tối đa chờ người giải CAPTCHA (chế độ có cửa sổ); chạy tiếp ngay khi giải xong |
| `CAPTCHA_MAX_PER_RUN` | `2` | Số CAPTCHA không giải được trước khi tắt tìm bằng trình duyệt cho phần còn lại của run (RSS vẫn chạy) |
| `OUTPUT_DIR` | `output` | Thư mục đầu ra, tương đối từ gốc scraper |
| `CLASSIFIER_MODE` | `rules` | `rules`, `hybrid` hoặc `gemini` |
| `CLASSIFIER_REVIEW_FALLBACK` | `reject` | `reject` hoặc `accept`; `accept` vẫn yêu cầu tín hiệu thương hiệu mục tiêu |
| `GEMINI_API_KEY` | Trống | Khóa Gemini; cũng hỗ trợ `GOOGLE_API_KEY` |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Mô hình; cũng hỗ trợ `GOOGLE_AI_MODEL` |
| `GEMINI_TIMEOUT_MS` | `15000` | Thời gian chờ Gemini, mili giây |
| `PR_IMAGE_CAPTURE_CONCURRENCY` | `3` | Số tác vụ của script chụp ảnh riêng, giới hạn 1–6 |

File `.env.example` chọn `hybrid` và `gemini-2.5-pro`, khác mặc định trong mã. `rules` chỉ dùng quy tắc; `hybrid` gọi Gemini cho trường hợp cần xét thêm; `gemini` gọi mô hình cho bài vượt qua bộ lọc sơ bộ. Nếu thiếu khóa hoặc API lỗi, chương trình dùng xử lý dự phòng. Đặt `CLASSIFIER_MODE=rules` để chạy chỉ bằng quy tắc.

## Đầu ra

CSV lưu tại `output/articles_YYYYMMDD_HHmmss.csv` (hoặc `OUTPUT_DIR`), mã hóa UTF-8 có BOM. Tên file dùng thời gian của máy chạy.

| Cột | Nội dung |
| --- | --- |
| `brand` | Thương hiệu được phân loại |
| `article_title` | Tiêu đề bài báo |
| `article_url` | URL sau khi xử lý chuyển hướng |
| `publisher_domain` | Domain nguồn báo |
| `publisher_homepage` | Trang chủ nguồn báo |
| `publish_date` | Giờ Việt Nam: `HH:mm:ss DD/MM/YYYY` |
| `sentiment` | Sắc thái do bộ phân loại trả về |
| `classification_source` | Nguồn phân loại, ví dụ `rules` |
| `article_id` | ID ổn định của bài (`art_` + 12 ký tự hex), tính từ URL đã chuẩn hóa; cùng bài ở `/vn/` và `/en/` có cùng ID qua các lần chạy |

Ảnh PNG lưu trong `output/screenshots/`, chụp khung nhìn 800 × 800 pixel ở đầu trang. Tên ảnh kết hợp thương hiệu, domain, ngày và mã băm URL. CSV ghi tăng dần để giữ phần kết quả đã ghi khi tiến trình bị ngắt.

## Chụp ảnh từ danh sách bài có sẵn

`src/capture_pr_images.js` là công cụ chụp ảnh riêng, nhận file JSON chứa một mảng:

```json
[
  {
    "link": "https://example.com/article",
    "player": "AIA Viet Nam",
    "publisherDomain": "example.com",
    "screenshotDir": "output/screenshots"
  }
]
```

```powershell
npm.cmd run capture:pr-images -- .\articles.json
```

Script chạy headless. Đường dẫn JSON và `screenshotDir` tương đối tính từ thư mục làm việc khi chạy lệnh. Nên dùng đường dẫn tuyệt đối khi gọi từ ứng dụng khác.

## Cấu trúc thư mục

```text
src/
  index.js                    Điều phối crawler, lọc ngày
  capture_pr_images.js        Chụp ảnh từ danh sách JSON
  config/brands.js            Thương hiệu, bí danh, truy vấn
  config/urlIdentity.js       Luật nhận dạng cùng bài (ngôn ngữ, AMP, hậu tố ID)
  config/googleSelectors.json Selector Google Search, mẫu CAPTCHA
  crawler/browser.js          Chromium và phiên Google
  crawler/google.js           Tìm kiếm RSS và trình duyệt
  crawler/article.js          Tải bài, lấy tiêu đề/ngày đăng
  parser/dateParser.js        Phân tích và định dạng ngày
  parser/urlParser.js         Chuyển hướng, chuẩn hóa, key bài, loại trùng
  parser/articleIdentity.js   Loại trùng sau khi mở bài, cấp article_id
  output/artifacts.js         CSV và ảnh chụp
  output/logger.js            Log ra console
  utils/articleClassifier.js  Quy tắc và Gemini
test/core.test.js             Kiểm thử chức năng hiện tại
```

## Kiểm thử và xử lý lỗi

```powershell
npm.cmd test
```

Test kiểm tra ngày, URL, loại trùng, tiếng Việt, phân loại bằng quy tắc và CSV. Test không tìm kiếm Google hoặc gọi Gemini, không xác nhận tích hợp mạng.

- Thiếu Chromium: chạy `npx.cmd playwright install chromium`.
- CAPTCHA: chạy có cửa sổ trình duyệt để xử lý và tăng khoảng nghỉ. Query bị bỏ vì CAPTCHA được liệt kê ở dòng `[HEALTH]` cuối run.
- Kết quả ít hoặc rỗng: kiểm tra khoảng ngày, log phân loại, nguồn bị chặn. Nếu log có `[SELECTOR]`, sửa `src/config/googleSelectors.json` dựa trên HTML lưu ở `logs/selector-debug/`.
- Hai URL của cùng bài vẫn bị tính 2 lần: thêm luật vào `src/config/urlIdentity.js`.

Tool đã làm được gì, chưa làm được gì và lý do: xem [STATUS.md](STATUS.md).
- Excel hiển thị sai tiếng Việt: nhập qua **Data → From Text/CSV**, chọn UTF-8.

## Dọn thư mục

| Thành phần | Cách xử lý |
| --- | --- |
| `output/` | CSV, báo cáo và ảnh từ các lần chạy; được lưu trong Git để chia sẻ và theo dõi lịch sử |
| `logs/` | Log các lần chạy; được lưu trong Git để đối chiếu kết quả |
| `.google-state.json` | Cookies/localStorage; xóa sẽ đặt lại phiên Google |
| `node_modules/` | Thư viện đang dùng; chỉ xóa khi muốn cài lại bằng `npm.cmd ci` |
| `test/core.test.js` | Bộ test còn dùng bởi `npm.cmd test`; giữ để kiểm tra chức năng |
| `REPO_LOCATION.md` | Thông tin repository và quy ước đường dẫn của dự án |

Giữ `src/`, `package.json`, `package-lock.json`, `.env.example` và `.gitignore` để cài đặt và chạy chương trình. Không đưa `.env` hoặc phiên Google vào Git.
