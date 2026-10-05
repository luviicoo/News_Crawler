# Kiểm tra lại ba vấn đề PR — 04/10/2026, giờ Việt Nam

Kết luận áp dụng cho repository chính `Social-Media_Competitor-Insurance`. Folder đang mở `PR-article-scraper` là bản standalone giữ làm tham chiếu theo kế hoạch đã chốt; chưa chuyển sang luồng mới. Chép CSV vào output của standalone không đồng nghĩa đồng bộ code.

Hai Windows Scheduled Task `InsurancePR-GoogleNews-Canaries`, `InsurancePR-Weekly` đang trỏ vào script và working directory của repository chính. Node CLI trong repository chính gọi `scripts/run_pr_structured.py`, sau đó `pr_structured.py`. `pr_article_pipeline.py` cũng dùng luồng structured này. Node chỉ mở trang metadata/capture, không quyết định hệ ID riêng.

| Vấn đề | Repo chính | Standalone đang mở |
|---|---|---|
| CAPTCHA/chờ người giải | Không chờ người giải; phát hiện, fallback có giới hạn hoặc bỏ qua kèm lý do. Không tự giải CAPTCHA. | `src/crawler/google.js` còn chờ 30 giây ở headful; headless bỏ query. |
| Selector Google Search | Discovery dùng RSS/Atom/sitemap, không đọc Google Search HTML. | `src/index.js` vẫn gọi `searchGoogleNews`; còn fallback Google Search và DOM selectors. |
| Một bài nhiều URL | Có article_id/SQLite/alias; gộp khi có bằng chứng định danh. | Chống trùng bằng normalized URL trong Set của process; chưa có master/ID bền vững tương đương. |

**(a) CAPTCHA — giải quyết việc cần người canh, chưa bảo đảm lấy được nguồn bị chặn.**

- `pr_sources.py`: tìm bài bằng Google News RSS và RSS/Atom/sitemap của nguồn báo, không Google Search HTML.
- `pr_google_decode.py`, `pr_structured.py`: tận dụng alias/cache hợp lệ, decoder HTTP; nếu thất bại chuyển wrapper sang browser headless. Cache decode chỉ ghi kết quả accepted; lỗi mở/không resolve được bị loại cache. Cache decode thông thường có TTL 30 ngày; alias đã lưu trong master vẫn phải qua bước metadata khi cần.
- `utils/pr_response.py`: kiểm tra CAPTCHA/challenge, HTML giả RSS và XML sai root. `PR-article-scraper/src/utils/challenge.js`: kiểm tra DOM trước nhận metadata. Các trường hợp này không được xuất thành bài hợp lệ.
- `utils/network_retry.py`: timeout/retry hữu hạn cho lỗi mạng/429/5xx; 403/404 không retry như lỗi tạm thời. Giữ failed_sources/failed_queries/skip_reasons trong run và health. Nguồn khác tiếp tục.
- **Chưa làm:** không có tích hợp dịch vụ giải CAPTCHA. Đây là giới hạn đã chốt của kế hoạch: không dùng dịch vụ trả phí. RSS/decoder/headless cũng có thể bị chặn, nên không thể cam kết lấy đủ mọi bài. Đợt Prudential còn 20 URL ứng viên challenge chưa xác minh; không khẳng định tất cả là bài chắc chắn thiếu trong khoảng ngày.

**(b) Selector — bỏ phụ thuộc selector Google, còn bảo trì cấu hình publisher.**

- Luồng discovery mới không import crawler/google.js để search. File google.js trong repo chính chỉ là parser fixture; không tham gia tìm bài live.
- `src/crawler/article.js`, `src/parser/dateParser.js`: ưu tiên JSON-LD → metadata chuẩn → selectors trong `config/publishers.json`. Sửa JSON publisher có hiệu lực ở lần trích xuất tiếp theo. Trường thiếu có thể dùng feed làm dự phòng và được đánh dấu, không giả thành metadata trang.
- `pr_metadata_cache.py`: cache kiểm tra hash cấu hình publisher và identity, TTL 6 giờ; cấu hình đổi làm mất cache hit. Điều này tránh dùng lại metadata lấy bằng selector cũ.
- `health_check.py`, `config/health_thresholds.json`: cảnh báo thương hiệu 0, lượng bài giảm trên 50% khi có baseline đủ 4 tuần, ngày thiếu >10%, tiêu đề thiếu >5%, query/source/decoder/configuration/challenge/identity errors. Thiếu lịch sử ghi `insufficient_complete_weeks`, không suy đoán mức giảm.
- **Chưa làm:** code không tự viết selector mới. Khi báo đổi HTML và đồng thời thiếu JSON-LD/meta, người bảo trì phải cập nhật JSON; nếu nguồn không cung cấp dữ liệu lịch sử hoặc bị chặn, sửa selector không tạo thêm dữ liệu. Vì vậy kết quả 0 không đủ chứng minh lỗi selector. Có cấu hình selector không khớp nhưng feed cứu được dữ liệu, nên health missing fields phải được đọc cùng nguồn metadata.

**(c) ID ổn định — đã triển khai, giới hạn bởi bằng chứng định danh.**

- `pr_identity.py`: chọn canonical cùng publisher, rồi og:url, rồi URL redirect cuối; normalize tracking/AMP/mobile. Ngoại lệ Prudential ưu tiên og:url cùng publisher do đã có proof site lặp canonical sai.
- `pr_master.py`: article_id lưu SQLite, alias ánh xạ nhiều URL vào một article; tái sử dụng ID cũ khi alias đã biết. Hash URL chỉ khởi tạo ID mới khi chưa nhận diện; ID vẫn được giữ khi canonical đổi có bằng chứng. Bảo vệ cả trường hợp hash URL trùng ID được giữ sau khi bác bỏ alias.
- `pr_structured.py`: dedupe sau metadata/master và trước capture/export. Một article có nhiều quan hệ brand; cùng nội dung trên hai publisher giữ hai article, story_id chỉ nhóm câu chuyện. Alias xung đột được báo, không ghi đè.
- Schema master version 2 có migrations, backups và bảng redirect lịch sử ID; không tái tạo database từ đầu.
- **Chưa làm:** không tự gộp hai URL chỉ giống tiêu đề/nội dung khi không có canonical/redirect/alias đáng tin. Không có ID toàn cầu do mọi báo cung cấp. Tự gộp theo nội dung có thể làm mất bài độc lập và trái kế hoạch. Canonical sai của publisher khác vẫn cần proof/review/config sửa riêng; ngoại lệ Prudential không chứng minh mọi publisher đều đúng.
- Đợt Prudential đã sửa canonical sai của ba trang, giữ ID cũ bài tài chính, khôi phục hai bài riêng. Lưu proof/backup trong job; còn 17 cặp tương tự cần review. “543 ID duy nhất” không có nghĩa đã chứng minh không còn trùng nội dung trong 17 cặp này.

**Bằng chứng kiểm tra lại**

- Test mới: 48 Python, 14 Node, đều pass. Có test challenge HTML/DOM, RSS giả HTML, retry, decoder fallback, alias conflict, canonical đổi, publisher boundary, cache invalidation, rerun ID và selector repair.
- Một test E2E dùng HTTP fixture + Chromium thật, selector sai → missing_date/missing_title → chỉ sửa publisher JSON → health healthy. Test này đặt screenshots=False.
- Không chạy lại toàn bộ crawl Internet hoặc bộ E2E có chụp ảnh. Các kiểm tra fixture/mocks không bảo đảm Google/publisher luôn khả dụng.
- Bằng chứng test mới: `logs/review-three-issues/20261004_213644/`.
- Đối chiếu CSV hiện tại: 543 bản ghi, 543 article_id khác nhau; bản ở output standalone khớp CSV repo chính. SQLite integrity=ok, schema version=2.
- Log live Prudential: `logs/backfill/20261004_172713/manifest.json`, `diagnostics.json`. Trạng thái `completed_with_gaps`: 20 challenge, 2 missing_date, 1 open_error chưa xác minh; 124 endpoint discovery lỗi trên 6 nguồn. Health giữ warning, baseline thiếu 4 tuần hợp lệ.
- Lỗi 404 người dùng đưa trước đó là hyperlink dính các cột CSV: URL đúng trả 200, URL ghép cột trả 404. Đã quote toàn bộ trường CSV. Đây là lỗi trình xem nhận URL, độc lập với ba vấn đề crawler này.

**Sử dụng đúng phiên bản**

Chạy Node entry trong repository chính, hoặc Python của `.venv` repository chính:

```powershell
Set-Location -LiteralPath 'C:\Users\Admin\OneDrive - Sidekick Communications Ltd\Documents\Project\Social-Media_Competitor-Insurance'
.\.venv\Scripts\python.exe scripts/run_pr_structured.py --date-from 2026-09-01 --date-to 2026-09-13 --no-screenshots
```

Lệnh trên là hướng dẫn, không được chạy trong lượt review này. Runtime config vẫn tạm tắt ảnh, cảnh báo PR lưu tại máy. Đợt review không chỉnh sửa code crawler hoặc dữ liệu master; chỉ lưu báo cáo và bằng chứng test.
