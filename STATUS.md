# Tình trạng tool PR article scraper

Cập nhật 05/10/2026. Tool hiện **đã làm được** gì và **chưa làm được** gì, kèm lý do. Hướng dẫn cài đặt và chạy xem [README.md](README.md).

## Tóm tắt

| Mảng | Đã làm được | Chưa làm được |
| --- | --- | --- |
| Tìm bài | Google News RSS cho 9 thương hiệu, lọc theo khoảng ngày; dự phòng bằng Google Search trên trình duyệt | Nguồn thứ ba (RSS/sitemap riêng từng báo) |
| CAPTCHA | Tránh CAPTCHA nhờ RSS; chờ người giải ở chế độ có cửa sổ; tự ngưng tìm bằng trình duyệt khi bị chặn nhiều lần | Tự giải CAPTCHA; tự chạy lại query bị bỏ |
| Selector Google | Selector để trong file JSON; cảnh báo và lưu HTML khi nghi selector hỏng | Tự sửa selector; cảnh báo số bài giảm mạnh theo tuần |
| Trùng bài / ID | Gộp `/vn/`↔`/en/`, AMP, mobile, hreflang, canonical cùng tiêu đề, hậu tố ID vietnam.vn; cột `article_id` | Gộp khi không có bằng chứng từ link; ID cố định tuyệt đối qua nhiều lần chạy |
| Phân loại, ngày đăng, đầu ra | Phân loại thương hiệu/sắc thái; lấy ngày đăng; ảnh chụp; CSV mở được bằng Excel | Phân loại dựa trên nội dung bài; giữ bài không lấy được ngày đăng |

---

## Phần 1. Đã làm được

### Tìm bài
- Tìm bài cho 9 thương hiệu: Sun Life, Chubb Life, FWD, Dai-ichi Life, AIA, Bảo Việt Nhân Thọ, Prudential, Manulife, Generali. Tên, bí danh và câu truy vấn sửa trong `src/config/brands.js`.
- Đường chính là **Google News RSS**: không có CAPTCHA, không phụ thuộc giao diện Google. Gặp lỗi tạm thời (429/5xx) thì thử lại 2 lần (sau 5 giây, rồi 15 giây). Nhận ra khi Google trả trang chặn thay vì dữ liệu.
- Nếu RSS lỗi hoặc trả 0 bài, chuyển sang **Google Search trên trình duyệt**. Trình duyệt chạy chế độ chống phát hiện bot (stealth), giữ cookie giữa các lần chạy, gõ từ khóa như người thật và nghỉ ngẫu nhiên giữa các thao tác.
- Lọc theo khoảng ngày (giờ Việt Nam). Mặc định lấy 7 ngày gần nhất, hoặc đặt bằng `--date-from` / `--date-to`.

### CAPTCHA
- Chế độ có cửa sổ: gặp CAPTCHA thì chờ tối đa `CAPTCHA_PAUSE_MS` (mặc định 30 giây) để người giải, và chạy tiếp ngay khi giải xong.
- Chế độ ẩn (headless): bỏ query đó, không treo.
- Sau `CAPTCHA_MAX_PER_RUN` lần (mặc định 2) không giải được, tool ngừng tìm bằng trình duyệt cho phần còn lại của lần chạy. RSS vẫn chạy.
- Các query bị bỏ được liệt kê ở dòng `[HEALTH]` cuối lần chạy.

### Selector Google
- Selector nằm trong `src/config/googleSelectors.json`. Google đổi giao diện thì sửa file này, không cần sửa code.
- Khi trang có kết quả mà lấy được 0 bài, tool log `[SELECTOR]` và lưu HTML trang vào `logs/selector-debug/` để đối chiếu.
- Tool phân biệt hai trường hợp: Google thật sự không có kết quả, và selector hỏng.

### Chống trùng bài
- Chống trùng theo từng thương hiệu. Một bài nhắc nhiều thương hiệu sẽ xuất hiện ở mỗi thương hiệu đó.
- Các link sau được coi là **cùng một bài** (luật trong `src/config/urlIdentity.js`):
  - Khác ngôn ngữ trong link: `/vn/` ↔ `/en/`, `/vi-vn/`, `?lang=en`…
  - Bản AMP, bản mobile `m.`, có hoặc không có `www.`, có tham số theo dõi (`utm_*`, `fbclid`…).
  - Bản tiếng Anh khác slug nhưng trang có khai báo hreflang (link trang tự khai báo tới các bản ngôn ngữ khác).
  - Canonical trỏ về bài đã có, **và** cùng tiêu đề.
  - vietnam.vn: có hoặc không có số ID ở cuối link (`-298454`, từ 5 chữ số trở lên).
- Kiểm tra trùng hai lần: trước khi mở bài, và sau khi mở bài (dựa trên link thật thay vì link trung gian của Google News). Bài trùng không bị chụp ảnh và được ghi log `[SKIP_SAME_ARTICLE]`.
- Mỗi bài có `article_id`. Cùng một link (sau khi chuẩn hóa) có cùng ID ở mọi lần chạy.

### Phân loại
- Loại tin không liên quan, xác định đúng thương hiệu (có thể chuyển bài sang thương hiệu khác), gắn sắc thái.
- Có 3 chế độ: `rules` (chỉ dùng quy tắc), `hybrid` (quy tắc, thêm Gemini cho ca khó), `gemini`.
- Đã xử lý các ca dễ nhầm: tài trợ thể thao, Prudential nước ngoài (Prudential Financial, Prudential plc), Bảo Việt phi nhân thọ, bài nhắc nhiều thương hiệu.
- Chặn một số nguồn không phải báo (Facebook, vài trang tổng hợp).

### Thông tin bài và đầu ra
- Mở từng bài để lấy link thật, tiêu đề và ngày đăng. Ngày đăng được lấy theo nhiều cách: thẻ `<time>`, meta, JSON-LD, ngày trong link, chữ trên trang.
- Chụp ảnh 800×800 phần đầu bài vào `output/screenshots/`.
- CSV UTF-8 có BOM (mở bằng Excel đúng tiếng Việt), ghi từng dòng nên vẫn giữ được kết quả nếu dừng giữa chừng. Các cột: `brand, article_title, article_url, publisher_domain, publisher_homepage, publish_date, sentiment, classification_source, article_id`.
- Có script riêng chụp ảnh từ danh sách bài có sẵn (`npm run capture:pr-images`).

### Theo dõi sức khỏe mỗi lần chạy
Cuối mỗi lần chạy, các dòng `[HEALTH]` ghi:
- Số bài đã gộp trùng.
- Số query dùng RSS và số query phải dùng trình duyệt.
- Cảnh báo `WARN`: thương hiệu có 0 bài, nghi selector hỏng, query bị bỏ vì CAPTCHA.

### Kiểm thử
- `npm test`: 10 test (ngày, link, chống trùng, ID, phân loại, CSV, file cấu hình selector). Tất cả pass.
- Đã chạy thử trên Chromium thật:
  - Gộp `/vn/`–`/en/` bằng hreflang, dùng server giả lập.
  - Lấy bài, chẩn đoán selector hỏng và nhận diện CAPTCHA, trên trang HTML giả lập.
  - 1 query RSS thật trả 14 bài.

---

## Phần 2. Chưa làm được và lý do

### CAPTCHA

**1. Chưa tự giải CAPTCHA** bằng dịch vụ như 2Captcha hay CapSolver.
- Dịch vụ tính phí theo lượt. Kế hoạch hiện tại không dùng dịch vụ trả phí, nên cần người phụ trách quyết định ngân sách và cấp API key.
- Tự động vượt CAPTCHA của Google vi phạm điều khoản sử dụng của Google.
- CAPTCHA trên `google.com/sorry` gắn với IP. Giải xong, IP đó vẫn có thể bị chặn tiếp, nên đổi IP/proxy hiệu quả hơn giải từng lần.
- Không có key thì không kiểm thử được.

Nếu sau này quyết định dùng, điểm gắn vào là hàm `ensureNoCaptcha()` trong `src/crawler/google.js`.

**2. Query bị bỏ vì CAPTCHA không tự chạy lại.** Ngay sau khi bị chặn, IP vẫn đang bị Google đánh dấu, chạy lại ngay chỉ làm tình trạng chặn kéo dài hơn. Danh sách query bị bỏ có trong `[HEALTH]` để chạy lại thủ công sau.

**3. Chưa có nguồn thứ ba khi cả RSS lẫn trình duyệt đều bị chặn.** Nguồn thứ ba là RSS/sitemap riêng của từng báo, như repo chính `Social-Media_Competitor-Insurance` đang làm. Thêm vào là thay đổi lớn về cách tìm bài, chưa làm ở đây.

### Selector Google

**4. Không tự viết selector mới.** Tool chỉ báo lỗi và lưu HTML. Người bảo trì vẫn phải sửa file JSON, vì không suy ra được selector đúng một cách tin cậy nếu không có người xác nhận.

**5. Phát hiện selector hỏng chỉ dựa trên dấu hiệu gián tiếp**: trang có từ 3 link ngoài trở lên mà lấy được 0 bài. Vì vậy:
- Có thể báo nhầm khi Google trả trang lạ.
- Không phát hiện được trường hợp selector lấy nhầm link (ví dụ quảng cáo), vì khi đó số bài vẫn lớn hơn 0.

**6. Chưa cảnh báo "số bài giảm mạnh so với tuần trước".** Mỗi lần chạy xuất một CSV riêng, không lưu số liệu các lần trước nên không có gì để so. Hiện chỉ cảnh báo thương hiệu có 0 bài.

**7. Chưa thử phần trình duyệt trên Google Search thật**, để tránh làm IP của máy bị chặn. Phần này mới thử trên trang giả lập.

### Trùng bài và ID

**8. Không gộp hai link chỉ vì giống tiêu đề hoặc nội dung.** Gộp theo tiêu đề dễ gộp nhầm. Ví dụ thật: `vietnam.vn/...-bao-cao-tai-chinh-2024` và `...-2025` là hai bài khác nhau dù link gần giống hệt.

**9. Bản ngôn ngữ khác slug mà trang không có hreflang thì không gộp được.** Không có link nào nối hai bản, và tiêu đề khác ngôn ngữ nên không so được. Gặp báo như vậy cần thêm luật riêng cho báo đó. So nội dung qua dịch máy thì tốn chi phí và dễ sai, nên chưa làm.

**10. Luật bỏ số ID cuối link chỉ bật cho vietnam.vn.** Ở nhiều báo khác (vnexpress, tuoitre…), số cuối link chính là ID của bài, bật chung sẽ gộp nhầm. Báo mới cần kiểm chứng rồi thêm vào `SLUG_NUMERIC_SUFFIX_DOMAINS` trong `src/config/urlIdentity.js`.

**11. Cùng nội dung đăng ở hai báo khác nhau vẫn tính là 2 bài.** Đây là chủ ý: mỗi báo đăng là một lần xuất hiện PR.

**12. `article_id` chưa cố định tuyệt đối qua nhiều lần chạy.**
- Chống trùng chỉ có tác dụng trong một lần chạy. Hai lần chạy có khoảng ngày chồng nhau sẽ ra bài lặp, nhưng cùng `article_id` nên lọc được khi gộp file.
- Với bản ngôn ngữ khác slug, ID lấy theo link gặp trước trong lần chạy đó, nên có thể khác giữa các lần chạy.
- Muốn ID cố định tuyệt đối cần một cơ sở dữ liệu lưu các link của cùng bài qua nhiều lần chạy, như SQLite ở repo chính. Đây là thay đổi kiến trúc; nên đồng bộ từ repo chính thay vì làm lại.

**13. CSV cũ không được sửa.** `output/prudential_pr_20240101_20260930.csv` do repo chính tạo ra. Kiểm tra bằng luật mới, file này còn 4 cặp trùng:

| Link giữ | Link trùng | Lý do |
| --- | --- | --- |
| `vietnam.vn/prudential-ra-mat-quy-lien-ket-don-vi-prulink-tuong-lai-xanh` | `vietnam.vn/en/prudential-ra-mat-quy-...-tuong-lai-xanh` | `/en/` |
| `vietnam.vn/prudential-viet-nam-giu-vung-vi-the-...-co-trach-nhiem` | `...-co-trach-nhiem-298454` | số ID cuối link |
| `vietnam.vn/prudential-cung-hanh-trinh-5-nam-...-tai-viet-nam` | `...-tai-viet-nam-298289` | số ID cuối link |
| `vietnam.vn/prudential-nhan-rong-mo-hinh-...-lotte-mall-tay-ho` | `...-lotte-mall-tay-ho-300858` | số ID cuối link |

Repo chính cần áp dụng cùng luật để các lần xuất sau không lặp lại.

### Phân loại và thông tin bài

**14. Phân loại chủ yếu dựa trên tiêu đề và thông tin từ kết quả tìm kiếm**, chạy trước khi mở bài. Làm vậy để không phải mở những bài không liên quan, nhưng bài có tiêu đề mơ hồ có thể bị phân loại sai.

**15. Bài không lấy được ngày đăng bị loại**, vì không xác định được bài có nằm trong khoảng ngày hay không. Báo không ghi ngày theo cách nào tool nhận ra sẽ bị mất bài.

**16. Chế độ `hybrid`/`gemini` cần khóa Gemini.** Thiếu khóa hoặc API lỗi thì tool tự dùng quy tắc.
