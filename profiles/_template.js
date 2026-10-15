'use strict';

/**
 * PROFILE MẪU: sao chép file này thành profiles/<ten-profile>.js rồi sửa.
 * Chạy: npm start -- --profile <ten-profile>    (hoặc đặt PROFILE=<ten-profile> trong .env)
 * Kiểm tra nhanh, không kéo dữ liệu: node src/index.js --profile <ten-profile> --daily --plan-only
 *
 * Engine không chứa rule riêng của ngành/brand nào: mọi thứ khai báo ở đây.
 * Cụm từ/từ khóa có thể viết có dấu hoặc không dấu; engine so khớp sau khi
 * bỏ dấu, chuyển chữ thường và chỉ giữ chữ/số (ví dụ "Bảo hiểm" = "bao hiem").
 * Ví dụ dưới đây (ngành sữa) chỉ để minh họa.
 */
module.exports = {
  // Tên profile, xuất hiện trong log.
  name: 'example-dairy',

  // Tiền tố tên file output, ví dụ output/example_dairy_daily_all_brands.csv.
  // Bỏ trống trường này thì dùng `name`; đặt '' thì không có tiền tố.
  outputPrefix: 'example_dairy',

  // Bài nhắc từ 2 brand trở lên được ghi MỘT dòng với nhãn này ở cột brand.
  industryLabel: 'Ngành sữa',

  // Báo được tìm riêng bằng truy vấn "site:" (mỗi báo x mỗi năm x mỗi brand).
  // Càng nhiều báo thì càng nhiều truy vấn. Ghi đè tạm bằng --publishers.
  publishers: ['vnexpress.net', 'tuoitre.vn', 'thanhnien.vn', 'dantri.com.vn', 'cafef.vn'],

  topic: {
    // Mô tả ngữ cảnh hợp lệ; dùng trong prompt Gemini (hybrid/gemini).
    description: 'kinh doanh san pham sua tai Viet Nam',
    // Vai trò của mô hình trong prompt Gemini (không bắt buộc).
    llmRole: 'Ban la chuyen gia phan tich du lieu social listening cho nganh sua tai Viet Nam.',
    // Những loại tin Gemini phải loại (không bắt buộc).
    llmExclusions: 'tin the thao, giai tri, hoac noise',
    // (Không bắt buộc) Truy vấn tin ngành: bài không cần nhắc brand nào. Chạy
    // Google News RSS cho cả khoảng ngày và từng tháng (không chạy theo báo/năm).
    // Bài chỉ do các truy vấn này tìm thấy được nhận là tin ngành khi qua
    // keywords bên dưới (và Gemini ở chế độ hybrid/gemini).
    queries: ['"ngành sữa"', '"thị trường sữa"'],
    // Bài phải chứa ít nhất 1 từ khóa (tiêu đề hoặc thân bài) mới qua lớp rule.
    // Để [] thì bỏ qua bước này (chỉ dựa vào việc nhắc tên brand).
    keywords: ['sua', 'dinh duong', 'san pham sua', 'nganh sua'],
    // (Không bắt buộc, nên có) Cụm từ ngành rõ nghĩa, viết CÓ DẤU. Tin ngành có cụm
    // này ở tiêu đề được rule nhận ngay; xuất hiện từ minBodyStrongHits lần ở thân
    // bài (có ở đoạn mở đầu) cũng nhận; không có cụm nào thì loại. Chỉ ca lưng
    // chừng mới hỏi Gemini (hybrid). Bài chỉ nhắc brand một lần, sâu trong bài
    // không có cụm nào cũng được hỏi Gemini.
    strongKeywords: ['sữa công thức', 'ngành sữa', 'sữa tươi'],
    minBodyStrongHits: 3,
    // Tiêu đề chứa một trong các từ này thì loại, kể cả khi có tên brand.
    negativeTitleKeywords: ['bong da', 'ca si', 'phim'],
    // (Không bắt buộc) Ngoại lệ cho negativeTitleKeywords. Nhận { text, title, content }
    // đã chuẩn hóa không dấu; trả true để vẫn giữ bài.
    // negativeOverride: ({ text }) => /\bgiai bong da vinamilk\b/.test(text),
  },

  // (Không bắt buộc) Chỉ mở cửa sổ CAPTCHA thủ công cho các tên miền này ('.vn' =
  // mọi tên miền đuôi .vn). Trang khác gặp CAPTCHA bị bỏ qua đến hết lượt. Bỏ trống = mọi trang.
  // captchaDomains: ['.vn'],

  // (Không bắt buộc) Dấu hiệu bài PR/tài trợ riêng của ngành hoặc báo, thêm vào
  // bộ mẫu chung (nhãn "Thông tin doanh nghiệp", "Nội dung tài trợ", URL /tai-tro/...).
  // labels: so khớp không dấu với breadcrumb, chuyên mục, tag, câu đầu/cuối bài.
  // urlPatterns: regex trên đường dẫn URL.
  // prSignals: { labels: ['tin doanh nghiep'], urlPatterns: [/\/doanh-nghiep-viet\//] },

  // Cụm từ chỉ pháp nhân KHÁC không được tính là nhắc brand (công ty mẹ nước
  // ngoài, cổ phiếu...). Bị xóa trước khi dò tên brand; nếu nằm trong tiêu đề
  // thì bài bị loại với mọi brand.
  excludePhrases: ['co phieu vnm'],

  // (Không bắt buộc, nên có) Sentiment bằng rule, viết CÓ DẤU (so khớp giữ dấu).
  // Điểm: tiêu đề x3, đoạn mở đầu x2, câu thân bài nhắc brand x1; critical tính
  // gấp đôi. Một chiều đạt từ 3 điểm và hơn gấp ba chiều kia thì rule quyết;
  // lẫn lộn thì hỏi Gemini (hybrid) hoặc lấy chiều trội (rules). Bỏ trống thì
  // sentiment là neutral. Từ điển chung: profiles/_shared/sentiment-vi.js.
  // sentiment: {
  //   ...require('./_shared/sentiment-vi'),
  //   critical: [...require('./_shared/sentiment-vi').critical, 'sữa giả'],
  // },

  brands: [
    {
      // Tên brand ghi ra CSV; phải duy nhất trong profile.
      brand: 'Vinamilk',
      // Các cách viết tên brand trong bài. Khớp theo nguyên cụm từ (không khớp nửa từ).
      aliases: ['Vinamilk', 'Sua Viet Nam'],
      // Truy vấn Google News RSS (mỗi truy vấn chạy cho cả khoảng ngày và từng tháng).
      queries: ['"Vinamilk"', 'vinamilk tin tuc'],
      // Truy vấn dùng với "site:<báo>". NÊN đặt trong ngoặc kép: từ thường không
      // ngoặc kép khớp gần như mọi bài của một báo lớn. Mặc định = queries[0];
      // tool cảnh báo khi truy vấn này không có ngoặc kép.
      siteQuery: '"Vinamilk"',
      // (Không bắt buộc) pháp nhân trùng tên của riêng brand này. Bị xóa trước khi
      // dò; nằm trong tiêu đề thì loại bài khi đang tìm cho brand này.
      excludePhrases: ['quy vinamilk'],
    },
    {
      brand: 'TH true MILK',
      aliases: ['TH true MILK', 'TH Truemilk', 'TH true'],
      queries: ['"TH true MILK"'],
      // (Không bắt buộc) mẫu regex trên văn bản GỐC (có dấu, phân biệt hoa thường)
      // cần xóa trước khi dò, cho các cụm trông giống tên brand. Phải có cờ g.
      lookalikes: [/\bTH true\s+(?:story|fact)\b/gu],
      // (Không bắt buộc) văn bản gốc phải khớp regex này thì mới tính là nhắc brand
      // (dùng cho tên ngắn/dễ nhầm, ví dụ bắt buộc viết hoa). Không dùng cờ g.
      requirePattern: /\bTH\b/u,
      // (Không bắt buộc, nâng cao) hàm thay hẳn bước dò alias cho brand quá mơ hồ.
      // Nhận văn bản gốc và { normalizeText }; trả true nếu bài nhắc đúng brand.
      // mentionMatcher: (raw, { normalizeText }) => /\bth true milk\b/.test(normalizeText(raw)),
    },
  ],
};
