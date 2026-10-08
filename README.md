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
# Chạy ẩn; chỉ mở cửa sổ khi cần xác thực CAPTCHA
npm.cmd start

# Lệnh tương đương (giữ tương thích)
npm.cmd run start:headless

# Khoảng ngày gồm cả ngày đầu và ngày cuối
npm.cmd run start:headless -- --date-from 2026-09-01 --date-to 2026-09-13

# Chỉ lấy dữ liệu CSV, không chụp ảnh
npm.cmd start -- --brand Prudential --date-from 2018-01-01 --date-to 2026-09-30 --no-screenshots
```

Mặc định lấy 7 ngày tính cả hôm nay theo giờ Việt Nam (UTC+7). Có thể đặt `DATE_FROM` và `DATE_TO` trong `.env`; tham số dòng lệnh được ưu tiên. Cung cấp cả hai ngày theo định dạng `YYYY-MM-DD`. Nếu nhập thiếu hoặc sai ngày, chương trình báo lỗi; nếu ngày đầu lớn hơn ngày cuối, chương trình tự đổi thứ tự.

Brand, ngành, báo và mọi rule nhận diện nằm trong **profile** (`profiles/*.js`), không nằm trong code. Profile mặc định `insurance-vn` gồm Sun Life, Chubb Life, FWD, Dai-ichi Life, AIA, Bảo Việt Nhân Thọ, Prudential, Manulife và Generali. Profile `dairy-kids-vn` (ngành sữa trẻ em) gồm Milo, Vinamilk, TH true MILK, LOF (Kun), Nutifood, FrieslandCampina (Cô Gái Hà Lan, Ovaltine, Friso), Abbott, Nestlé NAN, Mead Johnson, Nutricare và Vitadairy. Chọn profile khác bằng `--profile <tên>` hoặc `PROFILE`. Xem [Tạo profile cho ngành/brand mới](#tạo-profile-cho-ngànhbrand-mới).

## Luồng xử lý

Trình duyệt tìm kiếm dự phòng, tải bài và chụp ảnh đều chạy ẩn. Khi phát hiện CAPTCHA, tool mở một cửa sổ xác thực riêng, chuyển cookie/localStorage về phiên ẩn sau khi giải xong và đóng cửa sổ; các yêu cầu xác thực đồng thời được xử lý lần lượt.

RSS ở đây là **RSS tìm kiếm của Google News**, không phải RSS riêng của từng báo. Mỗi truy vấn tạo một URL `https://news.google.com/rss/search?q=...&hl=vi&gl=VN&ceid=VN:vi`. Ví dụ tháng 01/2018: `"Prudential" after:2017-12-31 before:2018-02-01`; thêm `site:vnexpress.net` để tìm trong một báo. Khoảng ngày cuối cùng vẫn được kiểm tra theo ngày đăng thật của bài ở UTC+7.

1. Lập toàn bộ kế hoạch trước khi tìm: từng từ khóa cho cả khoảng ngày và từng tháng; thêm từ khóa thương hiệu + `site:` cho từng báo, từng năm. Danh sách báo lấy từ `publishers` của profile, thay tạm được bằng `--publishers` hoặc `PUBLISHER_DOMAINS`.
2. Chạy các truy vấn RSS. Tìm theo tháng/báo luôn được thực hiện, kể cả RSS trả ít hơn 100 kết quả. Feed từ 100 bài được chia đôi tiếp xuống một ngày, giữ cả kết quả của cửa sổ cha và con. Truy vấn RSS (kể cả truy vấn con khi chia đôi) nghỉ `RSS_DELAY_*`, ngắn hơn Web; bài của truy vấn trước được đọc song song khi RSS tìm tiếp. Truy vấn theo báo dùng `siteQuery` có ngoặc kép nếu hãng khai báo (Bảo Việt: không có ngoặc kép, mỗi báo trả hàng nghìn bài không liên quan). Số ngày vẫn chạm giới hạn được báo trong log `[HEALTH]`.
3. Chạy **Google Web** bổ sung theo tháng và báo/năm dù RSS đã có bài. Trình duyệt chạy ẩn; chỉ CAPTCHA mới mở cửa sổ xác thực. Web phân trang tối đa `WEB_MAX_PAGES`; chạm giới hạn, bị chặn hoặc không đọc được giao diện được ghi là chưa hoàn tất.
4. Lưu các URL tìm được vào tiến độ trước khi đánh dấu truy vấn xong. Mở bài, giải chuyển hướng, đọc tiêu đề, thân bài, ngày đăng và liên kết định danh. Không loại bài chỉ vì tiêu đề chưa nhắc thương hiệu. Một URL được hãng khác tìm thấy lại không bị mở lần nữa: kết quả lần đọc trước (hãng có trong bài, ngoài khoảng ngày, không phải bài báo) được dùng lại.
5. Phân loại bằng tiêu đề **và thân bài**. Ưu tiên vùng nội dung của báo, bỏ sidebar/tin liên quan. Bài nhắc từ 2 hãng trở lên (trong tiêu đề/thân bài) được ghi **một lần** với `brand = Ngành bảo hiểm`, danh sách hãng nằm ở cột `mentioned_brands`; không lặp lại cho từng hãng. Prudential Financial/plc, Manulife Financial, Bảo hiểm Bảo Việt... không được tính là nhắc hãng. Loại Prudential Finance, Prudential Financial và tên tòa nhà nhầm với Prudential Việt Nam. Phạm vi là các bài nhắc hãng, gồm tin ngành/CSR/khiếu nại, không chỉ thông cáo tích cực.
6. Loại trùng theo từng hãng (bài ngành dùng chung một phạm vi, nên tìm lại qua hãng khác vẫn tính là trùng) bằng URL chuẩn hóa, AMP/mobile/ngôn ngữ, hreflang và canonical cùng tiêu đề. Lưu cả liên kết định danh để khôi phục bộ chống trùng khi chạy tiếp. Một bài đăng ở hai báo vẫn tính là hai lần xuất hiện.
7. Lưu bài hợp lệ vào nhật ký tiến độ trước khi ghi CSV. Mặc định không chụp ảnh; muốn chụp dùng `--screenshots` hoặc `SCREENSHOTS=true`.
8. In tình trạng độ phủ ra log `[HEALTH]`: số truy vấn chưa xong/chạm giới hạn, bài chưa xác minh và ngày RSS chạm giới hạn. Không đổi CAPTCHA/lỗi tải thành “0 bài, đã xong”. Tool không xuất file báo cáo riêng.

Với Prudential từ 2018 đến 30/09/2026, kế hoạch mặc định gồm **568 truy vấn RSS và 249 truy vấn Web**; RSS có thể phát sinh thêm truy vấn con khi chạm giới hạn. RSS và Web đều phụ thuộc bài được Google lập chỉ mục, nên hoàn tất kế hoạch không chứng minh đã có mọi bài từng được xuất bản.

## Cập nhật hằng ngày

Sau khi đã kéo dữ liệu lịch sử, chạy mỗi ngày:

```powershell
# 3 ngày gần nhất (mặc định), chỉ RSS, ghi cộng dồn vào output/daily_all_brands.csv
npm.cmd start -- --daily --dedupe-with output/all_brands_20180101_20260930.csv

# Một hãng, 2 ngày gần nhất
npm.cmd start -- --brand Prudential --daily --days 2 --dedupe-with output/prudential_viet_nam_20180101_20260930.csv
```

- `--daily` lấy `--days` ngày gần nhất (1–30, mặc định 3; hoặc `DAILY_DAYS`), không chạy Web, không nhận `--date-from/--date-to`.
- CSV và checkpoint là **một bộ cố định** (`daily_<hãng>.csv`), mỗi ngày chỉ thêm bài mới; cửa sổ ngày chồng lên nhau không tạo dòng trùng và không đọc lại bài đã xử lý.
- `--dedupe-with` (hoặc `DEDUPE_WITH`) nhận CSV hoặc `.state.jsonl` của lần kéo lịch sử, phân cách bằng dấu phẩy, để không thêm lại bài đã có.
- Trang tải được, có tiêu đề nhưng không có thân bài (trang danh mục, hồ sơ, thông số xe…) được xếp `not-article` ngay; chế độ lịch sử vẫn thử lại các trang này.
- Bài lỗi được thử lại tối đa `ARTICLE_MAX_ATTEMPTS` lần (mặc định 3) qua các ngày, sau đó bỏ qua; log cuối lượt báo số bài đã bỏ. Mã thoát `0` khi mọi truy vấn và bài trong lượt đã xử lý xong.

## Chạy tiếp và kiểm tra độ phủ

Chạy lại **cùng lệnh** tự đọc checkpoint, khôi phục CSV và chỉ làm truy vấn/bài còn lỗi hoặc chưa xong. Các truy vấn đã hoàn tất không được tìm lại; bài đã nhận không bị thêm lần nữa. `Ctrl+C` dừng việc mở tác vụ mới, chờ tác vụ đang chạy và giữ tiến độ. Khóa tiến trình ngăn hai lượt chạy cùng ghi một checkpoint.

```powershell
# Xem kế hoạch, không truy cập mạng hoặc tạo file
npm.cmd start -- --brand Prudential --date-from 2018-01-01 --date-to 2026-09-30 --plan-only

# Chủ động tìm lại các truy vấn, vẫn giữ bài và chống trùng từ checkpoint
npm.cmd start -- --brand Prudential --date-from 2018-01-01 --date-to 2026-09-30 --refresh

# Tăng số trang cho các truy vấn Web còn chạm giới hạn, tiếp tục checkpoint cũ
npm.cmd start -- --brand Prudential --date-from 2018-01-01 --date-to 2026-09-30 --web-pages 10
```

`--output <file.csv>` chọn CSV và mặc định checkpoint `<file.csv>.state.jsonl`; `--state <file.jsonl>` chọn checkpoint riêng. Đổi hãng/khoảng ngày/danh sách báo/chế độ phân loại phải dùng bộ file khác để không nhầm tiến độ giữa các kế hoạch. Muốn kéo mới từ đầu, chọn tên `--output` mới. `--rss-only` bỏ bước Web và báo độ phủ chưa đầy đủ, cần bộ file khác nếu đã có checkpoint của kế hoạch đầy đủ.

Mã thoát `2` báo còn thiếu bước độ phủ hoặc còn ca chưa xác minh; `130` là đã dừng theo yêu cầu. URL chưa lấy được ngày vẫn nằm trong checkpoint để chạy lại, không tự gán ngày.

## Cấu hình

`.env` luôn được đọc tại gốc scraper, kể cả khi gọi từ thư mục khác.

| Biến | Mặc định trong mã | Ý nghĩa |
| --- | --- | --- |
| `HEADLESS` | `true` | Crawler luôn chạy ẩn, kể cả cấu hình cũ đặt `false`; `--headless` vẫn được chấp nhận |
| `DATE_FROM`, `DATE_TO` | 7 ngày gần nhất | Khoảng ngày theo giờ Việt Nam |
| `PROFILE` | `insurance-vn` | Tên file trong `profiles/` hoặc đường dẫn tới profile; CLI `--profile` ưu tiên |
| `BRAND` | Mọi brand trong profile | Chọn một brand theo tên hoặc alias, ví dụ `Prudential`; CLI `--brand` ưu tiên |
| `SCREENSHOTS` | `false` | Chỉ chụp khi bật rõ ràng |
| `PUBLISHER_DOMAINS` | `publishers` của profile | Danh sách domain phân cách bằng dấu phẩy |
| `WEB_MAX_PAGES` | `5` | Số trang tối đa cho mỗi truy vấn Web, CLI `--web-pages` ưu tiên |
| `RSS_TIMEOUT_MS` | `30000` | Thời gian chờ một yêu cầu RSS |
| `ARTICLE_CONCURRENCY` | `3` | Số bài tải đồng thời trong mỗi truy vấn |
| `PAGE_TIMEOUT` | `30000` | Thời gian chờ điều hướng, mili giây |
| `SEARCH_DELAY_MIN`, `SEARCH_DELAY_MAX` | `3000`, `6000` | Khoảng nghỉ trước mỗi truy vấn Web, mili giây |
| `RSS_DELAY_MIN`, `RSS_DELAY_MAX` | `1000`, `2000` | Khoảng nghỉ trước mỗi truy vấn RSS (cả truy vấn con khi chia đôi), mili giây |
| `DAILY_DAYS` | `3` | Số ngày gần nhất cho `--daily`; CLI `--days` ưu tiên |
| `DEDUPE_WITH` | Trống | Checkpoint/CSV lịch sử để chống trùng khi chạy `--daily` |
| `ARTICLE_MAX_ATTEMPTS` | `3` | Số lần thử một bài lỗi ở chế độ `--daily` trước khi bỏ qua |
| `BROWSER_RECYCLE_ARTICLES` | `300` | Khởi động lại trình duyệt sau mỗi N bài để giải phóng bộ nhớ khi chạy dài; `0` để tắt |
| `ARTICLE_DELAY_MIN`, `ARTICLE_DELAY_MAX` | `500`, `1500` | Khoảng nghỉ tải bài, mili giây |
| `CAPTCHA_PAUSE_MS` | `120000` | Thời gian chờ xác thực trong cửa sổ riêng; đặt `0` để bỏ qua xác thực thủ công |
| `CAPTCHA_MAX_PER_RUN` | `2` | Số CAPTCHA không giải được trước khi tắt tìm bằng trình duyệt cho phần còn lại của run (RSS vẫn chạy) |
| `OUTPUT_DIR` | `output` | Thư mục đầu ra, tương đối từ gốc scraper |
| `CLASSIFIER_MODE` | `rules` | `rules`, `hybrid` hoặc `gemini` |
| `CLASSIFIER_REVIEW_FALLBACK` | `reject` | `reject` hoặc `accept`; `accept` vẫn yêu cầu tín hiệu thương hiệu mục tiêu |
| `GEMINI_API_KEY` | Trống | Khóa Gemini; cũng hỗ trợ `GOOGLE_API_KEY` |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Mô hình; cũng hỗ trợ `GOOGLE_AI_MODEL` |
| `GEMINI_TIMEOUT_MS` | `15000` | Thời gian chờ Gemini, mili giây |
| `PR_IMAGE_CAPTURE_CONCURRENCY` | `3` | Số tác vụ của script chụp ảnh riêng, giới hạn 1–6 |

File `.env.example` chọn `hybrid`. `rules` chỉ dùng quy tắc; `hybrid` gọi Gemini cho trường hợp cần xét thêm; `gemini` gọi mô hình cho bài vượt qua bộ lọc sơ bộ. Nếu thiếu khóa hoặc API lỗi, chương trình dùng xử lý dự phòng. Đặt `CLASSIFIER_MODE=rules` để chạy chỉ bằng quy tắc.

## Tạo profile cho ngành/brand mới

Mỗi dự án theo dõi (một ngành hoặc một nhóm brand) là một file trong `profiles/`. Engine không chứa tên brand hay ngành nào, nên thêm ngành mới không cần sửa code.

1. Sao chép `profiles/_template.js` thành `profiles/<ten>.js`. Mỗi trường trong file mẫu đều có chú thích.
2. Khai báo `industryLabel`, `publishers`, `topic` (từ khóa ngành, từ khóa loại trừ, mô tả cho Gemini) và `brands` (`aliases`, `queries`, `siteQuery`).
3. Thêm rule chi tiết cho brand dễ nhầm. Thử theo thứ tự này:
   - `excludePhrases`: pháp nhân trùng tên;
   - `lookalikes`: cụm trông giống tên brand;
   - `requirePattern`: bắt buộc cách viết gốc;
   - `mentionMatcher`: hàm tùy biến, chỉ dùng khi các trường trên không đủ.
4. Kiểm tra trước khi chạy: `npm start -- --profile <ten> --daily --plan-only`. Profile sai trường sẽ báo lỗi kèm tên brand. Truy vấn `site:` không có ngoặc kép sẽ bị cảnh báo vì dễ kéo về hàng trăm bài không liên quan.
5. Chạy: `npm start -- --profile <ten> --daily`. Output tách riêng theo `outputPrefix` (mặc định là tên profile).

Sau mỗi lượt chạy, log `[HEALTH] WARN noisy query` chỉ ra truy vấn cần thu hẹp trong profile (từ 20 bài bị loại trở lên, tỷ lệ nhận dưới 5%).

## Đầu ra

CSV dùng UTF-8 có BOM. Tên mặc định theo hãng/khoảng ngày, ví dụ `output/prudential_viet_nam_20180101_20260930.csv`, kèm checkpoint `.state.jsonl`. Bộ CSV Prudential đã rà trước đây (`prudential_pr_20180101_20260930_reviewed.csv`) được giữ riêng; không tự nhập nó vào checkpoint mới.

| Cột | Nội dung |
| --- | --- |
| `brand` | Thương hiệu được phân loại, hoặc `Ngành bảo hiểm` nếu bài nhắc từ 2 hãng |
| `mentioned_brands` | Các hãng được nhắc trong bài, phân cách bằng `; ` |
| `article_title` | Tiêu đề bài báo |
| `article_url` | URL sau khi xử lý chuyển hướng |
| `publisher_domain` | Domain nguồn báo |
| `publisher_homepage` | Trang chủ nguồn báo |
| `publish_date` | Giờ Việt Nam: `HH:mm:ss DD/MM/YYYY` |
| `sentiment` | Sắc thái do bộ phân loại trả về |
| `classification_source` | Nguồn phân loại, ví dụ `rules` |
| `article_id` | ID ổn định của bài (`art_` + 12 ký tự hex), tính từ URL đã chuẩn hóa; cùng bài ở `/vn/` và `/en/` có cùng ID qua các lần chạy |

Ảnh PNG lưu trong `output/screenshots/`, chụp khung nhìn 800 × 800 pixel ở đầu trang. Tên ảnh kết hợp thương hiệu, domain, ngày và mã băm URL. CSV ghi tăng dần; nhật ký tiến độ là nguồn khôi phục CSV khi bị ngắt. Giữ `.state.jsonl` nếu muốn chạy tiếp.

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

Script chạy ẩn, chỉ mở cửa sổ khi gặp CAPTCHA cần xác thực. Đường dẫn JSON và `screenshotDir` tương đối tính từ thư mục làm việc khi chạy lệnh. Nên dùng đường dẫn tuyệt đối khi gọi từ ứng dụng khác.

## Cấu trúc thư mục

```text
profiles/
  insurance-vn.js             Profile mặc định: brand bảo hiểm, báo, rule nhận diện
  dairy-kids-vn.js            Profile ngành sữa trẻ em
  _template.js                Profile mẫu có chú thích từng trường
src/
  index.js                    Điều phối crawler, lọc ngày
  capture_pr_images.js        Chụp ảnh từ danh sách JSON
  config/profile.js           Nạp và kiểm tra profile
  config/brands.js            Brand của profile mặc định (tương thích cũ)
  config/urlIdentity.js       Luật nhận dạng cùng bài (ngôn ngữ, AMP, hậu tố ID)
  config/googleSelectors.json Selector Google Search, mẫu CAPTCHA
  crawler/browser.js          Chromium và phiên Google
  crawler/google.js           Tìm kiếm RSS và Google Web
  crawler/plan.js             Kế hoạch theo tháng và báo/năm
  crawler/run.js              Đọc thân bài, phân loại, điều phối và báo độ phủ
  crawler/state.js            Nhật ký tiến độ và khóa tiến trình
  crawler/article.js          Tải bài, lấy tiêu đề/ngày đăng
  parser/dateParser.js        Phân tích và định dạng ngày
  parser/urlParser.js         Chuyển hướng, chuẩn hóa, key bài, loại trùng
  parser/articleIdentity.js   Loại trùng sau khi mở bài, cấp article_id
  output/artifacts.js         CSV và ảnh chụp
  output/logger.js            Log ra console
  utils/articleClassifier.js  Bộ phân loại chung (rule từ profile) và Gemini
test/*.test.js                Kiểm thử (profile.test.js: profile, session, chặn tài nguyên)
```

## Kiểm thử và xử lý lỗi

```powershell
npm.cmd test
```

Test kiểm tra kế hoạch, phân loại thân bài/nhiều hãng, retry/resume, khóa tiến trình, khôi phục CSV, feed chạm giới hạn và CAPTCHA. Kiểm thử DOM dùng Chromium thật với HTML mẫu; test tự động không tìm Google hoặc gọi Gemini.

- Thiếu Chromium: chạy `npx.cmd playwright install chromium`.
- CAPTCHA: tool tự mở một cửa sổ để bạn xác thực rồi đóng khi thành công và tiếp tục chạy ẩn. Nếu đóng cửa sổ hoặc hết `CAPTCHA_PAUSE_MS`, tool bỏ qua query/bài đó. Query bị bỏ được liệt kê ở dòng `[HEALTH]` cuối run. Một số trang ràng buộc xác thực với trình duyệt; nếu phiên không chuyển được về crawler, tool sẽ bỏ qua khi hết thời gian chờ.
- Kết quả ít hoặc rỗng: kiểm tra khoảng ngày, log phân loại, nguồn bị chặn. Nếu log có `[SELECTOR]`, sửa `src/config/googleSelectors.json` dựa trên HTML lưu ở `logs/selector-debug/`.
- Hai URL của cùng bài vẫn bị tính 2 lần: thêm luật vào `src/config/urlIdentity.js`.

Tool đã làm được gì, chưa làm được gì và lý do: xem [STATUS.md](STATUS.md).
- Excel hiển thị sai tiếng Việt: nhập qua **Data → From Text/CSV**, chọn UTF-8.

## Dọn thư mục

| Thành phần | Cách xử lý |
| --- | --- |
| `output/` | CSV, checkpoint và ảnh từ các lần chạy; được lưu trong Git để chia sẻ và theo dõi lịch sử |
| `logs/` | Log các lần chạy; được lưu trong Git để đối chiếu kết quả |
| `.google-state.json` | Cookies/localStorage; xóa sẽ đặt lại phiên Google |
| `node_modules/` | Thư viện đang dùng; chỉ xóa khi muốn cài lại bằng `npm.cmd ci` |
| `test/core.test.js` | Bộ test còn dùng bởi `npm.cmd test`; giữ để kiểm tra chức năng |
| `REPO_LOCATION.md` | Thông tin repository và quy ước đường dẫn của dự án |

Giữ `src/`, `package.json`, `package-lock.json`, `.env.example` và `.gitignore` để cài đặt và chạy chương trình. Không đưa `.env` hoặc phiên Google vào Git.
