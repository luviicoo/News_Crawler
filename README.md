# News Crawler (crawl-news)

Thu thập bài báo về các thương hiệu theo dõi (mặc định: 9 hãng bảo hiểm nhân thọ Việt Nam) và tin ngành. Tool lưu toàn văn kèm metadata vào một store SQLite dùng chung, phân loại hãng/sentiment bằng rules + Gemini, rồi xuất CSV tương thích Excel. Viết bằng Node.js (CommonJS), dùng HTTP và Playwright Chromium để tải bài.

Repository: [luviicoo/News_Crawler](https://github.com/luviicoo/News_Crawler). Đây là dự án độc lập; toàn bộ mã nguồn, cấu hình và kiểm thử nằm trong repository này.

## Cài đặt trên Windows

Yêu cầu **Node.js 22.13 trở lên** (store dùng `node:sqlite` có sẵn trong Node). Trong PowerShell:

```powershell
git clone https://github.com/luviicoo/News_Crawler.git
cd News_Crawler
npm.cmd ci
npx.cmd playwright install chromium
if (-not (Test-Path -LiteralPath .env)) {
  Copy-Item -LiteralPath .env.example -Destination .env
}
```

Chỉ sao chép file mẫu khi chưa có `.env` để tránh ghi đè cấu hình. Dùng `npm.cmd` và `npx.cmd` nếu PowerShell chặn script `.ps1`. Chạy các lệnh từ thư mục gốc chứa `package.json`.

## Luồng xử lý

```
crawl (Phase 1)  →  store SQLite (output/news.db)  →  enrich (Phase 2)  →  export CSV
```

| Lệnh | Việc làm |
| --- | --- |
| `npm.cmd start` | Chạy cả 3 bước: crawl → enrich → export (giống lệnh cũ, vẫn ra CSV) |
| `npm.cmd run crawl` | Phase 1: tìm bài, tải toàn văn và metadata vào store. Không phân loại |
| `npm.cmd run enrich` | Phase 2: phân loại hãng/sentiment/tin ngành, đánh dấu bài đăng lại |
| `npm.cmd run export` | Xuất CSV từ store theo profile, hãng, khoảng ngày |
| `npm.cmd run import -- <file>` | Nhập checkpoint `.state.jsonl` hoặc CSV của bản cũ vào store |
| `npm.cmd run status` | Thống kê store: số bài, bài có toàn văn, bài PR, nhãn, các lượt chạy gần nhất |

```powershell
# Khoảng ngày gồm cả ngày đầu và ngày cuối
npm.cmd start -- --date-from 2026-09-01 --date-to 2026-09-13

# Một hãng
npm.cmd start -- --brand Prudential --date-from 2018-01-01 --date-to 2026-09-30

# Chỉ tìm và tải, phân loại sau
npm.cmd run crawl -- --date-from 2026-09-01 --date-to 2026-09-30
npm.cmd run enrich
npm.cmd run export -- --date-from 2026-09-01 --date-to 2026-09-30
```

Mặc định lấy 7 ngày tính cả hôm nay theo giờ Việt Nam (UTC+7). Có thể đặt `DATE_FROM` và `DATE_TO` trong `.env`; tham số dòng lệnh được ưu tiên. Ngày đầu lớn hơn ngày cuối thì tool tự đổi thứ tự.

Brand, ngành, báo và mọi rule nhận diện nằm trong **profile** (`profiles/*.js`), không nằm trong code. Profile mặc định `insurance-vn` gồm Sun Life, Chubb Life, FWD, Dai-ichi Life, AIA, Bảo Việt Nhân Thọ, Prudential, Manulife và Generali. Profile `dairy-kids-vn` (ngành sữa trẻ em) gồm Milo, Vinamilk, TH true MILK, LOF (Kun), Nutifood, FrieslandCampina, Abbott, Nestlé NAN, Mead Johnson, Nutricare và Vitadairy. Chọn profile bằng `--profile <tên>` hoặc `PROFILE`.

### Phase 1: crawl

RSS ở đây là **RSS tìm kiếm của Google News** (`https://news.google.com/rss/search?q=...&hl=vi&gl=VN&ceid=VN:vi`), không phải RSS riêng của từng báo.

1. Lập kế hoạch: từng truy vấn của hãng cho cả khoảng ngày và từng tháng; truy vấn hãng + `site:` cho từng báo, từng năm; **truy vấn ngành** (`topic.queries` của profile, 14 truy vấn mỗi profile) cho cả khoảng và từng tháng. Truy vấn ngành chỉ chạy khi lấy mọi hãng.
2. Chạy RSS. Feed từ 100 bài được chia đôi tới mức một ngày. Google Web chạy bổ sung theo tháng và báo/năm (trừ `--daily`, `--rss-only`).
3. Kết quả tìm kiếm được ghi vào store **cùng transaction** với trạng thái truy vấn, nên dừng giữa chừng không mất URL đã tìm thấy.
4. **Mỗi URL chỉ tải một lần** cho mọi hãng và mọi profile:
   - Link Google News được đổi sang link thật bằng HTTP (không mở trình duyệt), cách nhau `GN_DECODE_DELAY_MS`. Khi Google chặn (HTTP 429), link Google News chờ hết thời gian chờ, trong khi tìm kiếm và các link khác vẫn chạy.
   - Thứ tự tải: link không cần giải mã trước, rồi link Google News có tiêu đề RSS nhắc hãng/chủ đề của profile, cuối cùng là phần còn lại. Bị chặn hoặc dừng giữa chừng thì phần mất là link ít khả năng được nhận nhất.
   - Bài được tải bằng HTTP và đọc HTML tĩnh. Chỉ mở Chromium ẩn khi HTTP lỗi, gặp trang chống bot/CAPTCHA, thiếu tiêu đề, thân bài cần JavaScript hoặc thiếu ngày đăng.
   - Chromium chỉ khởi động khi cần và được khởi động lại sau mỗi `BROWSER_RECYCLE_ARTICLES` bài đọc bằng trình duyệt.
5. Mỗi bài đọc được đều được lưu, kể cả bài sau này bị loại: link thật, canonical/hreflang, tiêu đề, **toàn văn**, ngày đăng, tác giả, chuyên mục, tag, sapo, **dấu hiệu bài PR** (nhãn "Thông tin doanh nghiệp", "Nội dung tài trợ", URL `/tai-tro/`…), dòng ghi nguồn ("Theo …"). Văn bản được chuẩn hoá tiếng Việt (NFC, bỏ ký tự vô hình, giải entity HTML còn sót).
6. Gộp trùng bằng URL chuẩn hoá, AMP/mobile/ngôn ngữ, hreflang và canonical cùng tiêu đề, trên toàn store. `article_id` ổn định (`art_` + 12 ký tự hex).
7. Bỏ qua mạng xã hội, trang tuyển dụng, trang danh mục/tag và PDF.

### Phase 2: enrich

Chạy trên bài của profile chưa phân loại (hoặc tất cả với `--reclassify`):

1. Bài import từ bản cũ chưa có toàn văn được tải lại. Bài tải lại thất bại được đánh dấu `unavailable` và giữ nhãn cũ.
2. Tìm hãng được nhắc trong tiêu đề **và thân bài** theo rule của profile, rồi phân loại từng hãng bằng rules + Gemini (`CLASSIFIER_MODE`). Ở chế độ `hybrid`, rules quyết mọi thứ rõ ràng và Gemini chỉ được hỏi khi:
   - sentiment lẫn lộn (từ điển `sentiment` của profile cho điểm cả hai chiều);
   - tin ngành chỉ có 1–2 cụm `topic.strongKeywords` ở thân bài, không có ở tiêu đề;
   - bài chỉ nhắc hãng một lần, sâu trong bài, không có cụm từ ngành nào (danh sách link, tin tổng hợp).

   Prompt chỉ gửi đầu bài (`GEMINI_MAX_CONTENT_CHARS`) hoặc các câu liên quan. Câu trả lời được lưu ở bảng `llm_cache`: phân loại lại hoặc bài đăng lại cùng nội dung không gọi Gemini lần nữa. Cuối bước enrich, log `Gemini:` cho biết số lượt gọi có phí và số lượt dùng lại.
3. Gán nhãn:
   - Bài nhắc từ 2 hãng trở lên được nhận một lần với nhãn ngành (ví dụ `Ngành bảo hiểm`).
   - Bài nhắc 1 hãng mang nhãn hãng đó.
   - Bài không nhắc hãng nào nhưng do truy vấn ngành tìm thấy và đúng chủ đề (rule chủ đề, Gemini xác nhận ở chế độ hybrid/gemini) mang nhãn ngành, cột `mentioned_brands` để trống.
   - Bài còn lại bị loại nhưng vẫn nằm trong store.
4. Đánh dấu **bài đăng lại**: cùng tiêu đề (từ 30 ký tự) hoặc cùng nội dung ở báo khác thì trỏ về bản đăng sớm nhất. Bài đăng ở hai báo vẫn tính là hai lần xuất hiện.
5. Log `[HEALTH] WARN noisy query` chỉ ra truy vấn cần thu hẹp trong profile: từ 20 bài bị loại trở lên và tỷ lệ nhận dưới 5%.

Phân loại lại toàn bộ sau khi sửa rule của profile: `npm.cmd run enrich -- --reclassify`.

## Cập nhật hằng ngày

```powershell
# 3 ngày gần nhất (mặc định), chỉ RSS, ghi cộng dồn vào output/daily_all_brands.csv
npm.cmd start -- --daily --dedupe-with output/all_brands_20180101_20260930.csv

# Một hãng, 2 ngày gần nhất
npm.cmd start -- --brand Prudential --daily --days 2
```

- `--daily` lấy `--days` ngày gần nhất (1–30, mặc định 3; hoặc `DAILY_DAYS`), không chạy Web, không nhận `--date-from/--date-to`.
- CSV daily là một file cố định, cộng dồn qua các ngày. Các dòng đã có (kể cả file 10 cột của bản cũ) được giữ nguyên, chỉ bài mới được thêm.
- `--dedupe-with` (hoặc `DEDUPE_WITH`) nhận CSV (hoặc `.state.jsonl` cũ), phân cách bằng dấu phẩy. Bài có `article_id` trong các file này không được thêm vào CSV daily.
- Trang có tiêu đề nhưng không có thân bài (danh mục, hồ sơ…) được xếp `not-article` ngay. Bài lỗi được thử lại tối đa `ARTICLE_MAX_ATTEMPTS` lần (mặc định 3) qua các ngày.

## Chạy tiếp và kiểm tra độ phủ

Chạy lại **cùng lệnh** sẽ bỏ qua truy vấn đã xong và URL đã tải, chỉ làm phần còn lỗi hoặc chưa xong. `Ctrl+C` dừng việc mở tác vụ mới, chờ tác vụ đang chạy và giữ tiến độ. Khoá tiến trình (`news.db.<profile>.lock`) ngăn hai lượt cùng profile chạy song song trên một store.

```powershell
# Xem kế hoạch, không truy cập mạng hoặc tạo file
npm.cmd start -- --brand Prudential --date-from 2018-01-01 --date-to 2026-09-30 --plan-only

# Chủ động tìm lại các truy vấn đã xong (bài đã có không bị tải lại)
npm.cmd start -- --brand Prudential --date-from 2018-01-01 --date-to 2026-09-30 --refresh

# Tăng số trang cho các truy vấn Web còn chạm giới hạn
npm.cmd start -- --brand Prudential --date-from 2018-01-01 --date-to 2026-09-30 --web-pages 10
```

Mã thoát `2` báo còn thiếu bước độ phủ hoặc còn bài chưa xác minh; `130` là đã dừng theo yêu cầu. Lượt `--rss-only` luôn báo độ phủ chưa đầy đủ. RSS và Web đều phụ thuộc bài được Google lập chỉ mục, nên hoàn tất kế hoạch không chứng minh đã có mọi bài từng được xuất bản.

## Nhập dữ liệu của bản cũ

```powershell
npm.cmd run import -- output/dairy_kids_all_brands_20180101_20260930.csv --profile dairy-kids-vn
npm.cmd run import -- output/prudential_pr_20180101_20260930_reviewed.csv
```

- Checkpoint `.state.jsonl`:
  - Truy vấn đã chạy được nhập với cùng id kế hoạch, nên crawl lịch sử cùng khoảng ngày không tìm lại.
  - URL đã tìm được nhập vào store; URL bản cũ đã loại (`legacy-rejected`) không được tải lại.
  - Bài đã nhận được nhập kèm nhãn và sentiment cũ, export ra được ngay.
- CSV: chỉ nhập bài và nhãn.
- Toàn văn của bài cũ được tải lại dần ở bước enrich. Nhập lại cùng file không tạo bản trùng.

## Cấu hình

`.env` luôn được đọc tại gốc dự án, kể cả khi gọi từ thư mục khác.

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `DATE_FROM`, `DATE_TO` | 7 ngày gần nhất | Khoảng ngày theo giờ Việt Nam |
| `PROFILE` | `insurance-vn` | Tên file trong `profiles/` hoặc đường dẫn; CLI `--profile` ưu tiên |
| `BRAND` | Mọi brand của profile | Một brand theo tên hoặc alias; CLI `--brand` ưu tiên |
| `STORE_PATH` | `output/news.db` | Store SQLite dùng chung; CLI `--store` ưu tiên |
| `PUBLISHER_DOMAINS` | `publishers` của profile | Danh sách domain phân cách bằng dấu phẩy |
| `WEB_MAX_PAGES` | `5` | Số trang tối đa cho mỗi truy vấn Web; CLI `--web-pages` ưu tiên |
| `RSS_TIMEOUT_MS` | `30000` | Thời gian chờ một yêu cầu RSS |
| `HTTP_CONCURRENCY` | `8` | Số bài tải bằng HTTP cùng lúc |
| `HTTP_PER_DOMAIN` | `2` | Số yêu cầu cùng lúc tới một báo |
| `ARTICLE_CONCURRENCY` | `3` | Số tab trình duyệt cho bài HTTP không đọc được |
| `GN_DECODE_CONCURRENCY` | `2` | Số link Google News giải mã cùng lúc |
| `GN_DECODE_DELAY_MS` | `2000` | Khoảng cách tối thiểu giữa hai lần giải mã link Google News, mili giây (±25% ngẫu nhiên). Ở 1000 (1 link/giây), Google chặn sau khoảng 50 phút. Sau HTTP 429 khoảng cách tăng gấp đôi (tối đa 10 giây), sau 200 lần thành công liên tiếp giảm dần về mức này |
| `GN_DECODE_COOLDOWN_MS` | `600000` | Thời gian chờ khi Google chặn giải mã (HTTP 429); tăng gấp đôi nếu vẫn bị chặn, tối đa 60 phút. Trạng thái chặn lưu ở `output/news.db.gn-decode.json` để lượt sau không gọi lại Google khi còn bị chặn |
| `ENRICH_CONCURRENCY` | `4` | Số bài phân loại cùng lúc (số lệnh gọi Gemini song song) |
| `PAGE_TIMEOUT` | `30000` | Thời gian chờ tải bài (HTTP và trình duyệt), mili giây |
| `SEARCH_DELAY_MIN`, `SEARCH_DELAY_MAX` | `3000`, `6000` | Nghỉ trước mỗi truy vấn Web, mili giây |
| `RSS_DELAY_MIN`, `RSS_DELAY_MAX` | `1000`, `2000` | Nghỉ trước mỗi truy vấn RSS, mili giây |
| `ARTICLE_DELAY_MIN`, `ARTICLE_DELAY_MAX` | `500`, `1500` | Nghỉ sau mỗi bài đọc bằng trình duyệt, mili giây |
| `DAILY_DAYS` | `3` | Số ngày gần nhất cho `--daily`; CLI `--days` ưu tiên |
| `DEDUPE_WITH` | Trống | CSV lịch sử để không thêm lại bài vào CSV daily |
| `ARTICLE_MAX_ATTEMPTS` | `3` | Số lần thử một bài lỗi ở chế độ `--daily` |
| `BROWSER_RECYCLE_ARTICLES` | `300` | Khởi động lại trình duyệt sau N bài đọc bằng trình duyệt; `0` để tắt |
| `CAPTCHA_PAUSE_MS` | `120000` | Thời gian chờ xác thực CAPTCHA thủ công; `0` để bỏ qua |
| `CAPTCHA_MAX_PER_RUN` | `2` | Số CAPTCHA không giải được trước khi tắt tìm Web cho phần còn lại của lượt chạy |
| `OUTPUT_DIR` | `output` | Thư mục đầu ra, tương đối từ gốc dự án |
| `CLASSIFIER_MODE` | `rules` | `rules`, `hybrid` hoặc `gemini` |
| `CLASSIFIER_REVIEW_FALLBACK` | `reject` | `reject` hoặc `accept` khi Gemini lỗi |
| `GEMINI_API_KEY` | Trống | Khoá Gemini; cũng hỗ trợ `GOOGLE_API_KEY` |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Mô hình; cũng hỗ trợ `GOOGLE_AI_MODEL` |
| `GEMINI_TIMEOUT_MS` | `15000` | Thời gian chờ Gemini, mili giây |
| `GEMINI_MAX_CONTENT_CHARS` | `6000` | Số ký tự đầu bài gửi Gemini; `0` để gửi toàn văn |
| `GEMINI_THINKING_BUDGET` | `0` | Token "suy nghĩ" của model flash; `0` tắt (nhanh và rẻ hơn), để trống dùng mặc định của model. Model pro bỏ qua |
| `GEMINI_MAX_RETRIES` | `4` | Số lần thử lại khi Gemini báo giới hạn (429), quá tải (500/503) hoặc hết thời gian; chờ theo yêu cầu của Gemini hoặc 2, 4, 8, 16 giây |

`.env.example` chọn `hybrid`: rules trước, Gemini cho trường hợp cần xét thêm và cho tin ngành không nhắc hãng. Thiếu khoá hoặc API lỗi thì dùng xử lý dự phòng.

## Tạo profile cho ngành/brand mới

Mỗi dự án theo dõi (một ngành hoặc một nhóm brand) là một file trong `profiles/`. Engine không chứa tên brand hay ngành nào, nên thêm ngành mới không cần sửa code.

1. Sao chép `profiles/_template.js` thành `profiles/<ten>.js`. Mỗi trường trong file mẫu đều có chú thích.
2. Khai báo các trường chính:
   - `industryLabel`, `publishers`;
   - `topic`: từ khoá ngành, từ khoá loại trừ, mô tả cho Gemini, `queries` (truy vấn tin ngành);
   - `brands`: `aliases`, `queries`, `siteQuery`;
   - tuỳ chọn `prSignals`: dấu hiệu bài PR riêng;
   - nên có `topic.strongKeywords` và `sentiment` (từ điển chung ở `profiles/_shared/sentiment-vi.js`) để rules tự quyết phần lớn bài, giảm lượt gọi Gemini.
3. Thêm rule cho brand dễ nhầm, theo thứ tự `excludePhrases` → `lookalikes` → `requirePattern` → `mentionMatcher`.
4. Kiểm tra trước khi chạy: `npm start -- --profile <ten> --daily --plan-only`.
5. Chạy: `npm start -- --profile <ten> --daily`. Output tách riêng theo `outputPrefix` (mặc định là tên profile).

## Đầu ra

**Store** `output/news.db` (SQLite, không đưa vào Git):

| Bảng | Nội dung |
| --- | --- |
| `crawl_runs` | Mỗi lượt crawl/enrich/import: profile, khoảng ngày, trạng thái, thống kê (số bài HTTP/trình duyệt…) |
| `search_queries` | Truy vấn của kế hoạch và trạng thái |
| `discovered_urls`, `query_hits` | URL tìm được, trạng thái tải, truy vấn nào tìm thấy |
| `articles` | Link thật, canonical, tiêu đề, sapo, tác giả, chuyên mục, tag, ngày đăng, dấu hiệu PR, đăng lại |
| `article_contents` | Toàn văn (tối đa 64.000 ký tự, cờ `truncated` khi bài dài hơn) |
| `article_labels`, `article_brands` | Kết quả enrich theo profile và theo từng hãng |
| `llm_cache` | Câu trả lời của Gemini theo model + prompt, để không trả phí lại |

Xem nhanh bằng `npm.cmd run status` hoặc mở bằng công cụ SQLite bất kỳ (DB Browser for SQLite…).

**CSV** UTF-8 có BOM, ví dụ `output/prudential_viet_nam_20180101_20260930.csv`. 10 cột đầu giữ như bản cũ:

| Cột | Nội dung |
| --- | --- |
| `brand` | Thương hiệu, hoặc nhãn ngành nếu bài nhắc từ 2 hãng / là tin ngành |
| `mentioned_brands` | Các hãng được nhắc, phân cách bằng `; ` (trống với tin ngành không nhắc hãng) |
| `article_title`, `article_url` | Tiêu đề, URL thật |
| `publisher_domain`, `publisher_homepage` | Báo |
| `publish_date` | Giờ Việt Nam: `HH:mm:ss DD/MM/YYYY` |
| `sentiment`, `classification_source` | Sắc thái và nguồn phân loại (`rules`, `gemini`…) |
| `article_id` | ID ổn định của bài |
| `author`, `section`, `tags`, `sapo` | Tác giả, chuyên mục, tag (`; `), sapo |
| `is_pr`, `pr_signals` | `yes` khi có dấu hiệu bài PR/tài trợ, và các dấu hiệu tìm thấy |
| `republished_of` | `article_id` bản đăng sớm nhất nếu đây là bài đăng lại |
| `source_credit` | Dòng ghi nguồn cuối bài |
| `content`, `content_2` | Toàn văn. Mỗi ô tối đa 32.000 ký tự (dưới giới hạn 32.767 của Excel); phần còn lại sang `content_2`, cắt ở khoảng trắng |

CSV luôn dựng lại được từ store bằng `npm.cmd run export`.

## Cấu trúc thư mục

```text
profiles/                     Profile: brand, báo, truy vấn ngành, rule nhận diện
src/
  index.js                    CLI: all | crawl | enrich | export | import | status
  config/                     Nạp/kiểm tra profile, selector Google, luật cùng bài
  crawler/plan.js             Kế hoạch theo tháng, báo/năm, truy vấn ngành
  crawler/run.js              Phase 1: tìm kiếm, tải mỗi URL một lần, lưu store
  crawler/google.js           Tìm kiếm RSS và Google Web
  crawler/googleNewsDecode.js Đổi link Google News sang link thật bằng HTTP
  crawler/fetcher.js          Tải bài: HTTP trước, trình duyệt dự phòng
  crawler/httpFetch.js        Tải HTML, page giả lập trên linkedom
  crawler/article.js          Trích xuất tiêu đề, thân bài, ngày, metadata; nhánh trình duyệt
  crawler/browser.js          Chromium và phiên Google
  crawler/browserSession.js   Khởi động khi cần, khởi động lại định kỳ
  crawler/sources.js          Nguồn bị chặn, trang danh mục
  enrich/enrich.js            Phase 2: phân loại, tin ngành, đăng lại, truy vấn nhiễu
  store/db.js                 Store SQLite, khoá tiến trình
  store/importLegacy.js       Nhập checkpoint/CSV của bản cũ
  parser/                     Ngày, URL, chống trùng, tín hiệu PR, chuẩn hoá tiếng Việt
  output/                     Ghi/đọc CSV, export, log
  utils/articleClassifier.js  Bộ phân loại chung (rule từ profile) và Gemini
test/*.test.js                Kiểm thử
```

## Kiểm thử và xử lý lỗi

```powershell
npm.cmd test
```

Test chạy không cần mạng: store, resume, khoá tiến trình, tải HTTP với HTML mẫu, dự phòng sang trình duyệt, giải mã link Google News từ dữ liệu mẫu, metadata/PR, enrich, export, import. Kiểm thử DOM dùng Chromium thật với HTML mẫu.

- Thiếu Chromium: chạy `npx.cmd playwright install chromium`.
- Lỗi `node:sqlite`: nâng Node.js lên 22.13 trở lên.
- CAPTCHA: tool tự mở một cửa sổ để bạn xác thực, đóng khi thành công và tiếp tục chạy ẩn. Đóng cửa sổ hoặc hết `CAPTCHA_PAUSE_MS` thì tool bỏ qua truy vấn/bài đó và liệt kê ở dòng `[HEALTH]`.
- CAPTCHA của báo được xử lý theo từng báo: mỗi báo chỉ mở một cửa sổ, bài khác của báo đó chờ kết quả, báo khác vẫn chạy. Xác thực xong thì các bài sau của báo đó đọc bằng cookie vừa có. Không xác thực thì báo đó bị bỏ qua đến hết lượt (không mở cửa sổ nữa); bài của báo giữ trạng thái cũ và được đọc ở lượt sau. Dòng `[HEALTH]` cuối lượt liệt kê các báo bị bỏ qua.
- Kết quả ít hoặc rỗng: kiểm tra khoảng ngày, log phân loại, nguồn bị chặn. Nếu log có `[SELECTOR]`, sửa `src/config/googleSelectors.json` dựa trên HTML lưu ở `logs/selector-debug/`.
- Hai URL của cùng bài vẫn bị tính 2 lần: thêm luật vào `src/config/urlIdentity.js`.
- Excel hiển thị sai tiếng Việt: nhập qua **Data → From Text/CSV**, chọn UTF-8.

Tool đã làm được gì, chưa làm được gì và lý do: xem [STATUS.md](STATUS.md).

## Dọn thư mục

| Thành phần | Cách xử lý |
| --- | --- |
| `output/news.db` (+ `-wal`, `-shm`) | Store; không đưa vào Git. Xoá là mất toàn văn và tiến độ (CSV vẫn còn) |
| `output/*.csv` | CSV xuất ra; được lưu trong Git để chia sẻ |
| `logs/` | Log các lần chạy; được lưu trong Git để đối chiếu |
| `.google-state.json` | Cookies/localStorage; xoá sẽ đặt lại phiên Google |
| `node_modules/` | Chỉ xoá khi muốn cài lại bằng `npm.cmd ci` |

Không đưa `.env` hoặc phiên Google vào Git.
