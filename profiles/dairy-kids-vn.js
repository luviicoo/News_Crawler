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

const baseSentiment = require('./_shared/sentiment-vi');

// "LOF", "Kun" và "IDP" đều là từ ngắn, trùng tên người (Kun Agüero) hoặc tổ
// chức khác (IDP Education), nên chỉ tính khi có ngữ cảnh sữa. "Ba Vì" là địa
// danh và "sữa Ba Vì" không kèm "Lof" là Công ty CP Sữa Ba Vì, nên chỉ tính "Lof Ba Vì".
function hasLofMention(value, { normalizeText }) {
  const text = normalizeText(value);
  if (/\b(?:lof viet nam|lof vietnam|tap doan lof|cong ty lof|lothamilk|sua kun|lof ba vi)\b/.test(text)) return true;
  return /\b(?:lof|kun|idp)\b.{0,40}\bsua\b|\bsua\b.{0,40}\b(?:lof|kun|idp)\b/.test(text);
}

// Công ty CP Sữa Ba Vì: "sữa (tươi/chua) Ba Vì" không kèm "Lof" (Lof Ba Vì là LOF)
// và không phải "bò sữa Ba Vì" (vùng chăn nuôi).
function hasBaViMilkMention(value, { normalizeText }) {
  const text = normalizeText(value).replace(/\blof ba vi\b/g, ' ');
  if (/\b(?:cong ty (?:co phan )?sua ba vi|ctcp sua ba vi)\b/.test(text)) return true;
  return /(?<!\bbo )\bsua (?:tuoi (?:tiet trung |thanh trung )?|chua (?:an |uong )?)?ba vi\b/.test(text);
}

module.exports = {
  name: 'dairy-kids-vn',
  outputPrefix: 'dairy_kids',
  // Bài nhắc từ 2 brand trở lên được ghi 1 lần dưới nhãn này.
  industryLabel: 'Ngành sữa',

  // Mỗi báo thêm (số brand) x 9 năm truy vấn site: cho cả RSS lẫn Web, nên chỉ
  // giữ báo tổng hợp/kinh tế lớn và báo sức khỏe, mẹ & bé.
  publishers: [
    'vnexpress.net', 'tuoitre.vn', 'thanhnien.vn', 'dantri.com.vn', 'vietnamnet.vn',
    'cafef.vn', 'vneconomy.vn', 'baodautu.vn', 'congthuong.vn', 'nld.com.vn',
    'tienphong.vn', 'suckhoedoisong.vn', 'vietnamplus.vn', 'afamily.vn',
  ],

  // Chỉ mở cửa sổ CAPTCHA cho báo Việt Nam: tìm Google Web trả về nhiều trang bán
  // hàng nước ngoài (Milo bán ở nhiều nước), không đáng làm phiền người dùng.
  captchaDomains: ['.vn', 'brandsvietnam.com', 'thitruongtaichinhtiente.vn'],

  topic: {
    description: 'kinh doanh sua va dinh duong tre em tai Viet Nam',
    llmRole: 'Ban la chuyen gia phan tich du lieu social listening cho nganh sua tre em tai Viet Nam.',
    llmExclusions: 'tin chung khoan thuan tuy (gia co phieu, giao dich khoi ngoai), tin giai tri khong lien quan brand, hoac noise',
    // Truy vấn tin ngành (bài không cần nhắc hãng nào), chạy RSS cả khoảng + từng
    // tháng. Viết có dấu: RSS gửi qua URL nên không gặp lỗi codepage như ô tìm kiếm.
    queries: [
      '"sữa công thức"', '"sữa bột trẻ em"', '"dinh dưỡng trẻ em"', '"ngành sữa"', '"thị trường sữa"',
      '"sữa học đường"', '"giá sữa bột"', '"sữa cho trẻ"', '"Hiệp hội Sữa Việt Nam"', '"sữa giả"',
      '"sữa tươi"', '"suy dinh dưỡng trẻ em"', '"sữa non"', '"thực phẩm dinh dưỡng"',
      // "sữa giả" chạm 100 kết quả/ngày (14–16/04/2025, vụ sữa giả): tách theo báo
      // và theo từ khoá hẹp để mỗi truy vấn còn dưới giới hạn RSS.
      ...['vnexpress.net', 'tuoitre.vn', 'thanhnien.vn', 'dantri.com.vn', 'vietnamnet.vn', 'cafef.vn', 'vneconomy.vn',
        'baodautu.vn', 'congthuong.vn', 'nld.com.vn', 'tienphong.vn', 'suckhoedoisong.vn', 'vietnamplus.vn', 'afamily.vn',
        'laodong.vn', 'znews.vn', 'vtv.vn', 'baochinhphu.vn', 'vov.vn', 'plo.vn', 'cand.com.vn', 'kenh14.vn',
      ].map(site => `"sữa giả" site:${site}`),
      '"sữa giả" Hacofood', '"sữa giả" "Rance Pharma"', '"sữa giả" bệnh viện', '"sữa giả" "tiểu đường"',
      '"sữa giả" "Bộ Y tế"', '"sữa giả" "khởi tố"', '"đường dây sữa giả"',
    ],
    // Không dùng "sua" đứng riêng: bỏ dấu thì "sửa" (sửa chữa) trùng "sữa".
    keywords: [
      'sua bot', 'sua tuoi', 'sua cong thuc', 'sua tre em', 'sua chua', 'sua hop', 'sua nuoc',
      'nganh sua', 'san pham sua', 'doanh nghiep sua', 'thi truong sua', 'bo sua', 'trang trai bo',
      'dinh duong', 'tre em', 'tre nho', 'me va be', 'thuc pham bo sung',
      'milo', 'vinamilk', 'th true milk', 'nutifood', 'frieslandcampina', 'co gai ha lan', 'dutch lady',
      'ovaltine', 'abbott', 'similac', 'nestle', 'mead johnson', 'nutricare', 'vitadairy',
      'yakult', 'meiji', 'moc chau milk', 'dalatmilk', 'friso', 'pediasure', 'yomilk', 'topkid', 'mistori',
      'morinaga', 'vinasoy', 'sua dau nanh', 'enfamil', 'enfagrow', 'colosbaby', 'metacare',
    ],
    // Cụm từ ngành rõ nghĩa (viết có dấu): ở tiêu đề thì rule nhận tin ngành
    // ngay, không cần Gemini; bài không có cụm nào (chỉ "dinh dưỡng", "trẻ em")
    // bị loại. Lưng chừng (1–2 lần ở thân bài) mới hỏi Gemini.
    strongKeywords: [
      'sữa công thức', 'sữa bột', 'sữa tươi', 'sữa tiệt trùng', 'sữa thanh trùng', 'sữa chua', 'sữa non', 'sữa hạt',
      'sữa đậu nành', 'sữa học đường', 'ngành sữa', 'thị trường sữa', 'doanh nghiệp sữa', 'sản phẩm sữa', 'sữa cho trẻ', 'sữa trẻ em',
      'sữa giả', 'giá sữa', 'hiệp hội sữa', 'bò sữa', 'trang trại bò', 'dinh dưỡng trẻ em', 'dinh dưỡng cho trẻ',
      'suy dinh dưỡng', 'thấp còi', 'sữa mẹ', 'dinh dưỡng học đường',
    ],
    minBodyStrongHits: 3,
    // Không loại thể thao: Milo, Nutifood, Vinamilk tài trợ thể thao nhiều.
    // Cổ tức/chứng khoán thuần là tin tài chính, không phải tin ngành.
    negativeTitleKeywords: [
      'ca si', 'phim', 'liveshow', 'showbiz',
      'co phieu', 'chung khoan', 'vn index', 'vnindex', 'khoi ngoai', 'co tuc',
    ],
    // Tiêu đề nói về hoạt động của brand vẫn giữ dù có từ khóa loại trừ
    // (ví dụ ca sĩ làm đại sứ, lợi nhuận kèm diễn biến cổ phiếu).
    negativeOverride: ({ title }) =>
      /\b(?:dai su|tai tro|ra mat|chien dich|san pham|doanh thu|loi nhuan|lai rong|ket qua kinh doanh)\b/.test(title),
  },

  excludePhrases: ['co phieu vnm', 'ma vnm'],

  // Sentiment bằng rule: từ điển chung + từ riêng ngành sữa. Gemini chỉ được hỏi
  // khi bài lẫn lộn cả hai chiều (chế độ hybrid).
  sentiment: {
    ...baseSentiment,
    positive: [
      ...baseSentiment.positive,
      'quỹ sữa', 'vươn cao việt nam', 'tặng sữa', 'trao tặng sữa', 'tầm vóc việt', 'trang trại xanh',
      'trang trại sinh thái', 'xuất khẩu sữa', 'chuẩn quốc tế',
    ],
    negative: [
      ...baseSentiment.negative,
      'sữa kém chất lượng', 'không đạt hàm lượng', 'thiếu hàm lượng', 'ghi nhãn sai', 'sữa nhập lậu', 'sữa không rõ nguồn gốc',
    ],
    critical: [...baseSentiment.critical, 'sữa giả', 'melamine', 'nhiễm khuẩn', 'ngộ độc sữa', 'thu hồi sữa'],
  },

  // products: dòng sản phẩm ghi vào cột mentioned_products. Biến thể (vị, mức đường,
  // dung tích) không ghi riêng: tên biến thể là alias của dòng sản phẩm chính. Brand/sản phẩm chưa có danh sách cụ thể thì
  // đặt tên "<tên> (need to check)" để cột sản phẩm báo cần rà lại.
  brands: [
    {
      brand: 'Nestlé Viet Nam',
      // Chỉ theo dõi MILO và NAN; tin Nestlé khác (cà phê, Maggi...) không thuộc ngành
      // sữa trẻ em nên không dùng "Nestlé" trơn và bắt buộc có MILO/NAN (requirePattern).
      aliases: ['Nestle MILO', 'sua Milo', 'Milo', 'Nestle NAN', 'sua NAN'],
      queries: ['"Nestle MILO"', '"sữa Milo"', '"Nestlé NAN"', '"sữa NAN"'],
      siteQuery: '("Milo" OR "Nestlé NAN")',
      products: [
        { name: 'MILO Sữa Mát A2', aliases: ['Milo sua mat A2', 'Milo sua mat', 'Milo A2'] },
        { name: 'MILO thức uống lúa mạch', aliases: [
          'Milo thuc uong lua mach huong so co la', 'Milo lua mach huong so co la', 'Milo huong so co la',
          'Milo it duong', 'Milo thuc uong lua mach', 'Milo lua mach',
        ] },
        { name: 'MILO lúa mạch cô đặc', aliases: ['Milo thuc uong lua mach co dac', 'Milo lua mach co dac', 'Milo co dac'] },
        { name: 'MILO Bữa Sáng Cân Bằng', aliases: ['Milo thuc uong bua sang can bang', 'Milo bua sang can bang', 'Milo bua sang'] },
        { name: 'NAN Optipro Plus', aliases: ['NAN Optipro Plus'] },
        { name: 'NAN Optipro', aliases: ['NAN Optipro'] },
        { name: 'NAN Supreme', aliases: ['NAN Supreme'] },
        { name: 'NAN Infinipro A2', aliases: ['NAN Infinipro A2', 'NAN Infinipro'] },
        { name: 'NAN Organic', aliases: ['NAN Organic'] },
        { name: 'NAN ExpertPro Lactose Free', aliases: ['NAN ExpertPro Lactose Free', 'NAN Expert Pro Lactose Free', 'NAN Lactose Free'] },
        { name: 'NAN ExpertPro Total Comfort', aliases: ['NAN ExpertPro Total Comfort', 'NAN Expert Pro Total Comfort', 'NAN Total Comfort'] },
      ],
      // Tên người trùng "Milo".
      lookalikes: [/\bMilo\s+(?:Đukanović|Dukanovic|Djukanovic|Yiannopoulos|Ventimiglia|Rau|Manheim)(?!\p{L})/giu],
      // "tai nạn" thành "tai nan" sau khi bỏ dấu; bắt buộc viết hoa NAN.
      requirePattern: /\b(?:Milo|MILO|NAN)\b/u,
    },
    {
      brand: 'Vinamilk',
      // Gồm Mộc Châu Milk (công ty con). Tên pháp nhân "Sữa Việt Nam" phải viết đủ:
      // "sữa Việt Nam" trơn khớp cả "thị trường sữa Việt Nam", "Hiệp hội Sữa Việt Nam".
      aliases: ['Vinamilk', 'Cong ty Co phan Sua Viet Nam', 'CTCP Sua Viet Nam', 'Moc Chau Milk'],
      queries: ['"Vinamilk"', 'vinamilk sua tre em', '"Mộc Châu Milk"'],
      siteQuery: '"Vinamilk"',
      products: [
        { name: 'Sữa tươi tiệt trùng Vinamilk 100%', aliases: [
          'sua tuoi tiet trung Vinamilk', 'sua tuoi Vinamilk 100', 'Vinamilk 100 sua tuoi', 'sua tuoi 100 Vinamilk', 'sua tuoi Vinamilk',
        ] },
        { name: 'Vinamilk Green Farm', aliases: ['Vinamilk Green Farm', 'Green Farm Vinamilk', 'sua tuoi Green Farm', 'sua Green Farm'] },
        { name: 'Vinamilk Organic', aliases: ['Vinamilk Organic', 'sua tuoi Organic Vinamilk', 'sua tuoi Vinamilk Organic'] },
        { name: 'Vinamilk ADM', aliases: ['Vinamilk ADM', 'sua ADM', 'ADM Gold'] },
        { name: 'Dielac Grow Plus', aliases: ['Dielac Grow Plus', 'Dielac GrowPlus', 'Dielac Grow'] },
        { name: 'Hero sữa trái cây', aliases: ['sua trai cay Hero', 'Vinamilk Hero', 'Hero Vinamilk'] },
        { name: 'SuSu sữa trái cây có thạch', aliases: ['SuSu sua trai cay', 'sua trai cay SuSu', 'SuSu co thach'] },
        { name: 'SuSu IQ sữa chua ăn', aliases: ['SuSu IQ', 'sua chua SuSu', 'sua chua an SuSu'] },
        { name: 'SuSu sữa chua uống', aliases: ['SuSu sua chua uong', 'sua chua uong SuSu'] },
        { name: 'SuSu sữa chua uống tiệt trùng', aliases: ['SuSu sua chua uong tiet trung', 'sua chua uong tiet trung SuSu'] },
        { name: 'Sữa chua ăn Vinamilk', aliases: ['sua chua an Vinamilk', 'sua chua Vinamilk'] },
        { name: 'Yomilk sữa chua uống', aliases: ['Yomilk', 'sua chua uong Yomilk'] },
        { name: 'Sữa chua uống Vinamilk', aliases: ['sua chua uong Vinamilk'] },
        // Không dùng "Probi" trơn: trùng hãng men vi sinh Probi (Thụy Điển).
        { name: 'Probi sữa chua uống men sống', aliases: ['Vinamilk Probi', 'Probi Vinamilk', 'sua chua uong Probi', 'sua chua Probi', 'Probi men song'] },
        // Không dùng "sữa Mộc Châu": khớp cả "bò sữa Mộc Châu" trong bài du lịch.
        { name: 'Mộc Châu Milk', aliases: ['Moc Chau Milk'] },
        { name: 'Sữa tươi tiệt trùng Mộc Châu', aliases: ['sua tuoi tiet trung Moc Chau', 'sua tuoi tiet trung Moc Chau Milk'] },
        { name: 'Sữa tươi thanh trùng Mộc Châu', aliases: ['sua tuoi thanh trung Moc Chau', 'sua tuoi thanh trung Moc Chau Milk'] },
        { name: 'Sữa tươi Mộc Châu', aliases: ['sua tuoi Moc Chau', 'Moc Chau Milk sua tuoi'] },
        { name: 'Sữa chua ăn Mộc Châu', aliases: ['sua chua an Moc Chau', 'sua chua Moc Chau'] },
        { name: 'Sữa chua nếp cẩm Mộc Châu', aliases: ['sua chua nep cam Moc Chau', 'Moc Chau sua chua nep cam'] },
        { name: 'Sữa chua uống Mộc Châu', aliases: ['sua chua uong Moc Chau'] },
      ],
    },
    {
      brand: 'TH true MILK',
      // Gồm Dalatmilk.
      aliases: ['TH true MILK', 'TH truemilk', 'TH true', 'Tap doan TH', 'Dalatmilk', 'Dalat Milk'],
      queries: ['"TH true MILK"', '"Tập đoàn TH" sữa', '"Dalatmilk"'],
      siteQuery: '"TH true MILK"',
      // Cùng nhà sáng lập nhưng không phải brand sữa.
      excludePhrases: ['bac a bank', 'ngan hang bac a'],
      // TOPKID/MISTORI/Dalatmilk là dòng riêng của TH, bài có thể không viết "TH".
      requirePattern: /\b(?:TH|TOPKID|TopKid|Topkid|MISTORI|Mistori|Dalatmilk|DalatMilk|Dalat Milk|DALATMILK)\b/u,
      products: [
        { name: 'TH true MILK sữa tươi tiệt trùng', aliases: [
          'sua tuoi tiet trung TH true MILK', 'sua tuoi TH true MILK', 'TH true MILK sua tuoi', 'sua tuoi TH true',
        ] },
        { name: 'TH TOPKID sữa tươi Organic', aliases: ['TOPKID sua tuoi', 'sua tuoi TOPKID', 'TOPKID Organic'] },
        { name: 'TH true FORMULA', aliases: ['TH true FORMULA'] },
        { name: 'TOPKID sữa chua ăn', aliases: ['TOPKID sua chua an', 'sua chua an TOPKID'] },
        { name: 'TOPKID sữa chua uống', aliases: [
          'TOPKID sua chua uong', 'sua chua uong TOPKID', 'TOPKID sua chua uong pho mai',
          'sua chua uong pho mai TOPKID', 'sua chua uong TOPKID pho mai',
        ] },
        { name: 'TOPKID sữa chua kem ngậy', aliases: ['TOPKID sua chua kem', 'sua chua kem TOPKID', 'sua chua kem ngay TOPKID'] },
        { name: 'TOPKID', aliases: ['TOPKID', 'TH TOPKID'] },
        { name: 'MISTORI sữa lúa mạch (CHOCOMALT)', aliases: ['TH true CHOCOMALT', 'CHOCOMALT MISTORI', 'sua lua mach MISTORI'] },
        { name: 'MISTORI sữa trái cây (JUICE milk)', aliases: ['TH true JUICE milk', 'JUICE milk MISTORI', 'sua trai cay MISTORI'] },
        { name: 'MISTORI', aliases: ['MISTORI'] },
        { name: 'Sữa tươi thanh trùng Dalatmilk', aliases: [
          'sua tuoi thanh trung Dalatmilk', 'sua tuoi thanh trung Dalat Milk', 'Dalatmilk sua tuoi thanh trung',
        ] },
        { name: 'Sữa tươi tiệt trùng Dalatmilk', aliases: [
          'sua tuoi tiet trung Dalatmilk', 'sua tuoi tiet trung Dalat Milk', 'Dalatmilk sua tuoi tiet trung',
        ] },
        { name: 'Sữa tươi Dalatmilk', aliases: ['sua tuoi Dalatmilk', 'sua tuoi Dalat Milk', 'Dalatmilk sua tuoi', 'Dalat Milk sua tuoi'] },
        { name: 'Sữa chua ăn Dalatmilk', aliases: [
          'sua chua an Dalatmilk', 'sua chua Dalatmilk', 'sua chua Dalat Milk', 'Dalatmilk sua chua',
        ] },
        { name: 'Dalatmilk', aliases: ['Dalatmilk', 'Dalat Milk'] },
        { name: 'TH true YOGURT', aliases: [
          'TH true YOGURT', 'sua chua TH true MILK', 'sua chua an TH true', 'sua chua uong TH true', 'sua chua TH true',
        ] },
      ],
    },
    {
      brand: 'LOF Kun',
      // Gồm KUN và Lof Ba Vì. "Sữa Ba Vì" không kèm "Lof" là Công ty CP Sữa Ba Vì (brand riêng).
      aliases: ['LOF Viet Nam', 'Tap doan LOF', 'sua Kun', 'Lothamilk', 'Lof Ba Vi'],
      queries: ['"LOF Việt Nam"', '"sữa Kun"', '"Lof Ba Vì"'],
      siteQuery: '"sữa Kun"',
      mentionMatcher: hasLofMention,
      products: [
        { name: 'KUN sữa tươi 100%', aliases: ['KUN 100 sua tuoi', 'KUN sua tuoi', 'sua tuoi KUN'] },
        { name: 'KUN sữa dinh dưỡng', aliases: [
          'KUN sua dinh duong', 'sua dinh duong KUN', 'KUN sua dinh duong huong banh quy', 'KUN huong banh quy',
          'KUN Cookies', 'KUN Cookie',
        ] },
        { name: 'KUN sữa uống dinh dưỡng lên men', aliases: ['KUN sua uong dinh duong len men', 'KUN sua uong len men', 'KUN len men'] },
        { name: 'KUN sữa trái cây', aliases: ['KUN sua trai cay', 'sua trai cay KUN'] },
        { name: 'KUN sữa trái cây có thạch', aliases: ['KUN sua trai cay co thach', 'sua trai cay co thach KUN'] },
        { name: 'KUN sữa lúa mạch', aliases: ['KUN sua lua mach', 'sua lua mach KUN'] },
        { name: 'KUN sữa lúa mạch có thạch', aliases: ['KUN sua lua mach co thach', 'sua lua mach co thach KUN'] },
        { name: 'KUN sữa chua uống', aliases: ['KUN sua chua uong', 'sua chua uong KUN'] },
        { name: 'KUN sữa chua uống có thạch', aliases: ['KUN sua chua uong co thach', 'sua chua uong co thach KUN'] },
        { name: 'KUN', aliases: ['sua Kun', 'thuong hieu Kun', 'nhan hang Kun'] },
        { name: 'Lof Ba Vì sữa tươi', aliases: ['sua tuoi Lof Ba Vi', 'Lof Ba Vi sua tuoi'] },
        { name: 'Lof Ba Vì sữa chua ăn', aliases: ['sua chua an Lof Ba Vi', 'sua chua Lof Ba Vi', 'Lof Ba Vi sua chua an'] },
        { name: 'Lof Ba Vì sữa chua uống', aliases: ['sua chua uong Lof Ba Vi', 'Lof Ba Vi sua chua uong'] },
        { name: 'Lof Ba Vì', aliases: ['Lof Ba Vi'] },
      ],
    },
    {
      brand: 'Nutifood',
      aliases: ['Nutifood', 'NutiFood Viet Nam', 'GrowPLUS'],
      queries: ['"Nutifood"'],
      siteQuery: '"Nutifood"',
      // "Dielac GrowPlus" là sản phẩm Vinamilk, không phải GrowPLUS+ của Nutifood.
      requirePattern: /\b(?:Nutifood|NutiMilk|Nuvi)\b|(?<!Dielac\s*)\bGrow\s*PLUS/iu,
      products: [
        // Các dòng Đỏ, Xanh, Sữa Non, Vị Trái Cây gộp vào GrowPLUS+.
        { name: 'GrowPLUS+', aliases: [
          'GrowPLUS', 'Nutifood Grow Plus', 'Grow Plus Nutifood', 'GrowPLUS vi trai cay', 'GrowPLUS trai cay',
        ] },
        { name: 'Nuvi Grow', aliases: ['Nuvi Grow'] },
        { name: 'NuVi', aliases: ['NuVi', 'Nutifood NuVi'] },
        // Sữa tươi và sữa chua uống men sống gộp vào NutiMilk.
        { name: 'NutiMilk', aliases: ['NutiMilk'] },
      ],
    },
    {
      brand: 'FrieslandCampina Viet Nam',
      // Gồm Dutch Lady (Cô Gái Hà Lan), Friso và Ovaltine.
      aliases: ['FrieslandCampina', 'Friesland Campina', 'Co Gai Ha Lan', 'Dutch Lady', 'Friso', 'Ovaltine'],
      queries: ['"FrieslandCampina Việt Nam"', '"Cô Gái Hà Lan"', '"Friso"', '"Ovaltine"'],
      siteQuery: '"FrieslandCampina"',
      products: [
        { name: 'Dutch Lady sữa tiệt trùng', aliases: [
          'sua tiet trung Dutch Lady', 'Dutch Lady sua tiet trung', 'sua tiet trung Co Gai Ha Lan',
          'sua tuoi Dutch Lady', 'sua tuoi Co Gai Ha Lan', 'sua Co Gai Ha Lan', 'Dutch Lady huong so co la',
          'sua Dutch Lady huong so co la', 'sua tiet trung Dutch Lady huong so co la', 'Co Gai Ha Lan huong so co la',
          'Dutch Lady socola', 'Dutch Lady huong dau', 'sua Dutch Lady huong dau',
          'sua tiet trung Dutch Lady huong dau', 'Co Gai Ha Lan huong dau',
        ] },
        { name: 'Dutch Lady', aliases: ['Dutch Lady', 'Co Gai Ha Lan'] },
        { name: 'Friso Gold Pro', aliases: ['Friso Gold Pro'] },
        { name: 'Friso Gold pha sẵn', aliases: [
          'Friso Gold pha san', 'sua pha san Friso Gold', 'sua uong pha san Friso Gold', 'Friso Gold 110ml', 'Friso Gold 180ml',
          'Friso Gold 110 ml', 'Friso Gold 180 ml',
        ] },
        { name: 'Friso Gold', aliases: ['Friso Gold'] },
        { name: 'Friso', aliases: ['Friso'] },
        { name: 'Ovaltine thức uống lúa mạch', aliases: [
          'Ovaltine thuc uong lua mach vi so co la', 'Ovaltine lua mach vi so co la', 'Ovaltine vi so co la',
          'Ovaltine socola', 'Ovaltine thuc uong lua mach', 'Ovaltine lua mach',
        ] },
        { name: 'Ovaltine dạng bột', aliases: ['Ovaltine dang bot', 'Ovaltine bot', 'bot Ovaltine'] },
        { name: 'Ovaltine lúa mạch đóng hộp', aliases: [
          'Ovaltine thuc uong lua mach dong hop', 'Ovaltine lua mach dong hop', 'Ovaltine dong hop',
        ] },
      ],
    },
    {
      brand: 'Abbott',
      aliases: ['Abbott', 'Similac', 'PediaSure', 'Abbott Grow'],
      products: [
        { name: 'Similac Total Protection', aliases: ['Similac Total Protection'] },
        { name: 'Similac 5G', aliases: ['Similac 5G'] },
        { name: 'Similac Eye-Q Plus', aliases: ['Similac Eye Q Plus', 'Similac EyeQ Plus', 'Similac Eye Q'] },
        { name: 'Similac Neosure', aliases: ['Similac Neosure', 'Neosure'] },
        { name: 'Similac Isomil', aliases: ['Similac Isomil', 'Isomil'] },
        { name: 'Similac Alimentum', aliases: ['Similac Alimentum', 'Alimentum'] },
        { name: 'Similac', aliases: ['Similac'] },
        { name: 'PediaSure 10+', aliases: ['PediaSure 10'] },
        { name: 'PediaSure pha sẵn', aliases: ['PediaSure pha san', 'PediaSure dang nuoc', 'sua nuoc PediaSure', 'PediaSure chai'] },
        { name: 'PediaSure', aliases: [
          'PediaSure', 'PediaSure huong vani', 'PediaSure vani', 'PediaSure huong vanilla', 'PediaSure vanilla',
        ] },
        { name: 'Abbott Grow Gold 2+', aliases: ['Abbott Grow Gold 2'] },
        { name: 'Abbott Grow Gold 3+', aliases: ['Abbott Grow Gold 3'] },
        { name: 'Abbott Grow Gold 6+', aliases: ['Abbott Grow Gold 6'] },
        { name: 'Abbott Grow Gold', aliases: ['Abbott Grow Gold'] },
        { name: 'Abbott Grow', aliases: [
          'Abbott Grow', 'Abbott Grow huong vani', 'Abbott Grow vani', 'Abbott Grow huong so co la',
          'Abbott Grow so co la', 'Abbott Grow socola',
        ] },
      ],
      queries: ['"Abbott" sữa', '"Similac"'],
      siteQuery: '"Abbott"',
      // Mảng thiết bị y tế/xét nghiệm của Abbott, không phải dinh dưỡng.
      excludePhrases: [
        'abbott laboratories', 'test nhanh abbott', 'kit xet nghiem abbott', 'xet nghiem abbott',
        'thiet bi abbott', 'may abbott', 'abbott diagnostics',
      ],
    },
    {
      brand: 'Mead Johnson',
      aliases: ['Mead Johnson', 'Enfa', 'Enfagrow', 'Enfamil', 'Enfa A+'],
      queries: ['"Mead Johnson"', '"Enfagrow"'],
      siteQuery: '"Mead Johnson"',
      products: [
        // "A+" bỏ dấu "+" khi so khớp: "Enfamil A+ NeuroPro" = "enfamil a neuropro".
        { name: 'Enfamil A+ NeuroPro', aliases: ['Enfamil A+ NeuroPro', 'Enfamil NeuroPro'] },
        { name: 'Enfamil A+ Gentle Care', aliases: ['Enfamil A+ Gentle Care', 'Enfamil Gentle Care'] },
        { name: 'Enfamil A+ Lactofree', aliases: ['Enfamil A+ Lactofree', 'Enfamil Lactofree'] },
        { name: 'Enfamil A+', aliases: ['Enfamil A+', 'Enfamil A Plus'] },
        { name: 'Enfamil', aliases: ['Enfamil'] },
        { name: 'Enfagrow A+ NeuroPro', aliases: ['Enfagrow A+ NeuroPro', 'Enfagrow NeuroPro'] },
        { name: 'Enfagrow A+', aliases: ['Enfagrow A+', 'Enfagrow A Plus'] },
        { name: 'Enfagrow', aliases: ['Enfagrow'] },
      ],
    },
    {
      brand: 'Nutricare',
      aliases: ['Nutricare'],
      queries: ['"Nutricare"'],
      siteQuery: '"Nutricare"',
      products: [
        { name: 'Metacare Colos Lactoferrin Plus', aliases: ['Metacare Colos Lactoferrin Plus', 'Metacare Colos Lactoferrin'] },
        { name: 'Metacare Opti', aliases: ['Metacare Opti'] },
        // Các dòng Metacare khác (vd. Metacare Colostrum) tính vào Metacare.
        { name: 'Metacare', aliases: ['Metacare'] },
        // Không dùng "Care 100" trơn: trùng cụm "skin care 100%"...
        { name: 'Care 100 Active', aliases: ['Care 100 Active', 'sua Care 100'] },
        // Vị dâu/cam gộp vào dòng sản phẩm.
        { name: 'Nutricare Smarta Grow Opti', aliases: ['Smarta Grow Opti', 'Nutricare Smarta Grow', 'Smarta Grow'] },
        { name: 'Meta Fresh sữa tươi bổ sung sữa non', aliases: ['Meta Fresh', 'Metafresh'] },
      ],
    },
    {
      brand: 'Vitadairy',
      aliases: ['Vitadairy', 'Vita Dairy'],
      queries: ['"Vitadairy"'],
      siteQuery: '"Vitadairy"',
      products: [
        { name: 'ColosBaby IQ Gold', aliases: ['ColosBaby IQ Gold', 'Colos Baby IQ Gold', 'ColosBaby IQ'] },
        { name: 'ColosBaby Bio Gold', aliases: ['ColosBaby Bio Gold', 'Colos Baby Bio Gold', 'ColosBaby Bio'] },
        { name: 'ColosBaby Lactoferrin', aliases: ['ColosBaby Lactoferrin', 'Colos Baby Lactoferrin'] },
        { name: 'ColosBaby Gold', aliases: ['ColosBaby Gold', 'Colos Baby Gold'] },
        { name: 'ColosBaby', aliases: ['ColosBaby', 'Colos Baby'] },
        { name: 'Colos Opti', aliases: ['Colos Opti'] },
        { name: 'Colos Gain', aliases: ['Colos Gain'] },
        { name: 'Calokid Gold', aliases: ['Calokid Gold', 'Calokid'] },
        // Không dùng "Vitagrow"/"Oggi" trơn: trùng tên sản phẩm ngành khác.
        { name: 'Vitagrow', aliases: ['sua Vitagrow', 'Vitagrow VitaDairy', 'VitaDairy Vitagrow'] },
        { name: 'Oggi Gold Pro', aliases: ['Oggi Gold Pro'] },
        { name: 'Oggi Gold Grow', aliases: ['Oggi Gold Grow'] },
        { name: 'Oggi Gold Smartie', aliases: ['Oggi Gold Smartie', 'Oggi Smartie'] },
        { name: 'Oggi Gold', aliases: ['Oggi Gold'] },
        { name: 'Oggi Sữa Trái Cây', aliases: ['Oggi sua trai cay', 'sua trai cay Oggi'] },
        { name: 'Sữa uống dinh dưỡng VitaDairy', aliases: ['sua uong dinh duong VitaDairy', 'sua nuoc VitaDairy'] },
      ],
    },
    {
      brand: 'Yakult',
      aliases: ['Yakult', 'Yakult Viet Nam'],
      queries: ['"Yakult"', '"Yakult Việt Nam"'],
      siteQuery: '"Yakult"',
      // Đội bóng chày Nhật Bản.
      excludePhrases: ['yakult swallows', 'tokyo yakult'],
      products: [
        { name: 'Yakult', aliases: [
          'Yakult nguyen ban', 'Yakult truyen thong', 'Yakult it duong', 'Yakult Light', 'Yakult huong dao',
          'Yakult vi dao', 'Yakult',
        ] },
      ],
    },
    {
      brand: 'Meiji Viet Nam',
      // Không dùng "Meiji" trơn (kể cả làm tên brand, vì tên brand cũng được dò):
      // trùng thời Minh Trị, Đại học Meiji, Meiji Seika (dược).
      aliases: ['Meiji Viet Nam', 'sua Meiji', 'sua bot Meiji', 'sua cong thuc Meiji', 'Meiji Step', 'Meiji Hohoemi', 'Rakuraku Milk'],
      queries: ['"sữa Meiji"', '"Meiji Step"'],
      siteQuery: '"sữa Meiji"',
      products: [
        { name: 'Meiji Step Rakuraku Milk', aliases: ['Meiji Step Rakuraku Milk', 'Meiji Step Rakuraku', 'Rakuraku Milk', 'Rakuraku'] },
        { name: 'Meiji Step', aliases: ['Meiji Step'] },
        { name: 'Meiji Infant Formula', aliases: ['Meiji Infant Formula', 'Meiji Infant'] },
      ],
    },
    {
      // Công ty Cổ phần Sữa Ba Vì (khác Lof Ba Vì của LOF).
      brand: 'Sua Ba Vi',
      aliases: ['Cong ty Co phan Sua Ba Vi', 'CTCP Sua Ba Vi', 'sua Ba Vi'],
      queries: ['"sữa Ba Vì"', '"Công ty Cổ phần Sữa Ba Vì"'],
      siteQuery: '"sữa Ba Vì"',
      mentionMatcher: hasBaViMilkMention,
      products: [
        { name: 'Sữa tươi Ba Vì', aliases: ['sua tuoi Ba Vi', 'sua tuoi tiet trung Ba Vi', 'sua tuoi thanh trung Ba Vi'] },
        { name: 'Sữa chua ăn Ba Vì', aliases: ['sua chua an Ba Vi', 'sua chua Ba Vi'] },
        { name: 'Sữa chua uống Ba Vì', aliases: ['sua chua uong Ba Vi'] },
      ],
    },
    {
      // Không dùng "Morinaga" trơn (kể cả làm tên brand): trùng hãng bánh kẹo
      // Morinaga (Hi-Chew) và tên người.
      brand: 'Morinaga Milk',
      aliases: ['Morinaga Milk', 'sua Morinaga', 'sua bot Morinaga', 'sua cong thuc Morinaga', 'Morinaga Viet Nam'],
      queries: ['"sữa Morinaga"', '"Hagukumi"'],
      siteQuery: '"sữa Morinaga"',
      products: [
        { name: 'Morinaga Hagukumi', aliases: ['Hagukumi'] },
        { name: 'Morinaga Chilmil', aliases: ['Chilmil'] },
      ],
    },
    {
      // Thức uống đậu nành, không phải sữa động vật.
      brand: 'Vinasoy',
      // Không dùng "Fami" trơn: trùng tên khách sạn, công ty khác.
      aliases: ['Vinasoy', 'sua dau nanh Fami', 'sua Fami'],
      queries: ['"Vinasoy"', '"sữa đậu nành Fami"'],
      siteQuery: '"Vinasoy"',
      products: [
        { name: 'Fami Canxi', aliases: ['Fami Canxi', 'Fami Calcium', 'sua dau nanh Fami Canxi'] },
        { name: 'Fami Go', aliases: ['Fami Go', 'sua dau nanh Fami Go'] },
        { name: 'Fami', aliases: ['sua dau nanh Fami', 'sua Fami', 'Vinasoy Fami', 'Fami Vinasoy'] },
      ],
    },
  ],
};
