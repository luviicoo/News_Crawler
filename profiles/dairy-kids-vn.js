'use strict';

/**
 * Profile: sữa trẻ em Việt Nam.
 *
 * Phạm vi là mọi tin nhắc brand (sản phẩm, CSR, khiếu nại, kinh doanh, tài trợ
 * thể thao), chỉ loại tin cổ phiếu thuần và pháp nhân trùng tên. Xem
 * profiles/_template.js để biết ý nghĩa từng trường.
 *
 * Alias/query dùng ASCII để tránh lỗi codepage khi Playwright hoặc console
 * Windows thao tác với ô tìm kiếm Google.
 */

// "LOF", "Kun" và "IDP" đều là từ ngắn, trùng tên người (Kun Agüero) hoặc tổ
// chức khác (IDP Education), nên chỉ tính khi có ngữ cảnh sữa.
function hasLofMention(value, { normalizeText }) {
  const text = normalizeText(value);
  if (/\b(?:lof viet nam|lof vietnam|tap doan lof|cong ty lof|lothamilk|dalat milk|dalatmilk|sua kun)\b/.test(text)) return true;
  return /\b(?:lof|kun|idp)\b.{0,40}\bsua\b|\bsua\b.{0,40}\b(?:lof|kun|idp)\b/.test(text);
}

module.exports = {
  name: 'dairy-kids-vn',
  outputPrefix: 'dairy_kids',
  // Bài nhắc từ 2 brand trở lên được ghi 1 lần dưới nhãn này.
  industryLabel: 'Ngành sữa',

  // Mỗi báo thêm 11 brand x 9 năm truy vấn site: cho cả RSS lẫn Web, nên chỉ
  // giữ báo tổng hợp/kinh tế lớn và báo sức khỏe, mẹ & bé.
  publishers: [
    'vnexpress.net', 'tuoitre.vn', 'thanhnien.vn', 'dantri.com.vn', 'vietnamnet.vn',
    'cafef.vn', 'vneconomy.vn', 'baodautu.vn', 'congthuong.vn', 'nld.com.vn',
    'tienphong.vn', 'suckhoedoisong.vn', 'vietnamplus.vn', 'afamily.vn',
  ],

  topic: {
    description: 'kinh doanh sua va dinh duong tre em tai Viet Nam',
    llmRole: 'Ban la chuyen gia phan tich du lieu social listening cho nganh sua tre em tai Viet Nam.',
    llmExclusions: 'tin chung khoan thuan tuy (gia co phieu, giao dich khoi ngoai), tin giai tri khong lien quan brand, hoac noise',
    // Không dùng "sua" đứng riêng: bỏ dấu thì "sửa" (sửa chữa) trùng "sữa".
    keywords: [
      'sua bot', 'sua tuoi', 'sua cong thuc', 'sua tre em', 'sua chua', 'sua hop', 'sua nuoc',
      'nganh sua', 'san pham sua', 'doanh nghiep sua', 'thi truong sua', 'bo sua', 'trang trai bo',
      'dinh duong', 'tre em', 'tre nho', 'me va be', 'thuc pham bo sung',
      'milo', 'vinamilk', 'th true milk', 'nutifood', 'frieslandcampina', 'co gai ha lan', 'dutch lady',
      'ovaltine', 'abbott', 'similac', 'nestle', 'mead johnson', 'nutricare', 'vitadairy',
    ],
    // Không loại thể thao: Milo, Nutifood, Vinamilk tài trợ thể thao nhiều.
    negativeTitleKeywords: [
      'ca si', 'phim', 'liveshow', 'showbiz',
      'co phieu', 'chung khoan', 'vn index', 'vnindex', 'khoi ngoai',
    ],
    // Tiêu đề nói về hoạt động của brand vẫn giữ dù có từ khóa loại trừ
    // (ví dụ ca sĩ làm đại sứ, lợi nhuận kèm diễn biến cổ phiếu).
    negativeOverride: ({ title }) =>
      /\b(?:dai su|tai tro|ra mat|chien dich|san pham|doanh thu|loi nhuan|lai rong|ket qua kinh doanh)\b/.test(title),
  },

  excludePhrases: ['co phieu vnm', 'ma vnm'],

  brands: [
    {
      brand: 'Milo',
      aliases: ['Nestle MILO', 'sua Milo', 'Milo'],
      queries: ['"Nestle MILO"', '"sữa Milo"'],
      siteQuery: '"Milo"',
      // Tên người trùng "Milo".
      lookalikes: [/\bMilo\s+(?:Đukanović|Dukanovic|Djukanovic|Yiannopoulos|Ventimiglia|Rau|Manheim)(?!\p{L})/giu],
      requirePattern: /\b(?:Milo|MILO)\b/u,
    },
    {
      brand: 'Vinamilk',
      aliases: ['Vinamilk', 'Sua Viet Nam', 'Moc Chau Milk'],
      queries: ['"Vinamilk"', 'vinamilk sua tre em'],
      siteQuery: '"Vinamilk"',
    },
    {
      brand: 'TH true MILK',
      aliases: ['TH true MILK', 'TH truemilk', 'TH true', 'Tap doan TH'],
      queries: ['"TH true MILK"', '"Tập đoàn TH" sữa'],
      siteQuery: '"TH true MILK"',
      // Cùng nhà sáng lập nhưng không phải brand sữa.
      excludePhrases: ['bac a bank', 'ngan hang bac a'],
      requirePattern: /\bTH\b/u,
    },
    {
      brand: 'LOF (Kun)',
      aliases: ['LOF Viet Nam', 'Tap doan LOF', 'sua Kun', 'Lothamilk', 'Dalat Milk'],
      queries: ['"LOF Việt Nam"', '"sữa Kun"'],
      siteQuery: '"sữa Kun"',
      mentionMatcher: hasLofMention,
    },
    {
      brand: 'Nutifood',
      aliases: ['Nutifood', 'NutiFood Viet Nam', 'GrowPLUS'],
      queries: ['"Nutifood"'],
      siteQuery: '"Nutifood"',
    },
    {
      brand: 'FrieslandCampina Viet Nam',
      aliases: ['FrieslandCampina', 'Friesland Campina', 'Co Gai Ha Lan', 'Dutch Lady', 'Friso', 'Ovaltine'],
      queries: ['"FrieslandCampina Việt Nam"', '"Cô Gái Hà Lan"', '"Ovaltine"'],
      siteQuery: '"FrieslandCampina"',
    },
    {
      brand: 'Abbott',
      aliases: ['Abbott', 'Similac', 'PediaSure', 'Abbott Grow'],
      queries: ['"Abbott" sữa', '"Similac"'],
      siteQuery: '"Abbott"',
      // Mảng thiết bị y tế/xét nghiệm của Abbott, không phải dinh dưỡng.
      excludePhrases: [
        'abbott laboratories', 'test nhanh abbott', 'kit xet nghiem abbott', 'xet nghiem abbott',
        'thiet bi abbott', 'may abbott', 'abbott diagnostics',
      ],
    },
    {
      brand: 'Nestle NAN',
      // Không dùng "Nestle" đứng riêng: bài Milo luôn viết "Nestlé MILO".
      aliases: ['Nestle NAN', 'sua NAN', 'NAN Optipro', 'NAN Supreme', 'NAN Infinipro'],
      queries: ['"Nestlé NAN"', '"sữa NAN"'],
      siteQuery: '"Nestlé NAN"',
      // "tai nạn" thành "tai nan" sau khi bỏ dấu; bắt buộc viết hoa NAN.
      requirePattern: /\bNAN\b/u,
    },
    {
      brand: 'Mead Johnson',
      aliases: ['Mead Johnson', 'Enfa', 'Enfagrow', 'Enfamil', 'Enfa A+'],
      queries: ['"Mead Johnson"', '"Enfagrow"'],
      siteQuery: '"Mead Johnson"',
    },
    {
      brand: 'Nutricare',
      aliases: ['Nutricare'],
      queries: ['"Nutricare"'],
      siteQuery: '"Nutricare"',
    },
    {
      brand: 'Vitadairy',
      aliases: ['Vitadairy', 'Vita Dairy'],
      queries: ['"Vitadairy"'],
      siteQuery: '"Vitadairy"',
    },
  ],
};
