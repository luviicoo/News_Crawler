'use strict';

/**
 * Profile: bảo hiểm nhân thọ Việt Nam (profile mặc định).
 *
 * Mọi rule riêng của ngành/brand nằm ở file này; engine trong src/ không biết
 * tên brand nào. Xem profiles/_template.js để biết ý nghĩa từng trường.
 *
 * Alias/query dùng ASCII để tránh lỗi codepage khi Playwright hoặc console
 * Windows thao tác với ô tìm kiếm Google.
 */

// Phân biệt Prudential Việt Nam (bảo hiểm nhân thọ) với các pháp nhân khác
// mang tên Prudential: tập đoàn mẹ, công ty tài chính tiêu dùng, Prudential
// nước ngoài và cụm "macro prudential".
function hasPrudentialVietnamMention(value, { normalizeText }) {
  const text = normalizeText(value);
  const otherEntities = /\bprudential\s+(?:finance|financial|plc|holborn life|tower|center|hong kong|hongkong|malaysia|singapore|indonesia|thailand|india|assessment|regulation|regulatory|authority|supervision)\b|\bmacro\s+prudential\b/g;
  const consumerFinance = /\btai chinh\s+(?:(?:tnhh|mot thanh vien|mtv)\s+)*prudential\b/g;
  const containsOtherEntity = otherEntities.test(text) || consumerFinance.test(text);
  const cleaned = text.replace(otherEntities, '').replace(consumerFinance, '').replace(/\bprudential plc\b/g, '');
  const localParent = /\bprudential plc\b.{0,350}\b(?:viet nam|vietnam)\b|\b(?:viet nam|vietnam)\b.{0,200}\bprudential plc\b/.test(text);
  const localInsurer = /\bprudential (?:viet nam|vietnam)\b|\b(?:bao hiem nhan tho|bhnt)\b.{0,60}\bprudential\b|\bprudential\b.{0,120}\b(?:bao hiem nhan tho|bhnt)\b|\bby prudential\b/.test(cleaned);
  // Once another entity is named, bare shorthand such as "Prudential" later
  // in that story cannot by itself establish a Vietnam-insurer mention.
  if (containsOtherEntity) return localInsurer || localParent;
  return /\bprudential\b/.test(cleaned) || localParent;
}

// Drivetrain labels such as "Cầu trước (FWD)" or "FWD/AWD".
const FWD_DRIVETRAIN = [
  /(?:cầu trước|dẫn động(?: cầu trước)?)\s*\(?\s*FWD\s*\)?/giu,
  /\b(?:FWD|AWD|RWD|4WD)(?:\s*\/\s*(?:FWD|AWD|RWD|4WD))+\b/gu,
];

// FWD Assurance Việt Nam (tiền thân Vietcombank Cardif) là pháp nhân khác
// FWD Việt Nam. Bài không nhắc FWD Assurance (hay tên cũ Vietcombank Cardif/VCLI)
// thì "FWD" là FWD Việt Nam; bài đã nhắc thì "FWD" viết tắt phía sau vẫn chỉ
// FWD Assurance, nên chỉ tính FWD Việt Nam khi bài gọi rõ "FWD Việt Nam".
function hasFwdVietnamMention(value, { normalizeText }) {
  let raw = String(value).normalize('NFC');
  for (const pattern of FWD_DRIVETRAIN) raw = raw.replace(pattern, ' ');
  const containsAssurance = /\bFWD\s+Assurance\b|\bVietcombank[\s-]+Cardif\b/iu.test(raw) || /\bVCLI\b/u.test(raw);
  raw = raw.replace(/\bFWD\s+Assurance\b/giu, ' ');
  if (!/\bFWD\b/u.test(raw)) return false;
  return !containsAssurance || /\bfwd (?:viet nam|vietnam|vn)\b/.test(normalizeText(raw));
}

module.exports = {
  name: 'insurance-vn',
  // Giữ tên file cũ (daily_all_brands.csv) để checkpoint hiện tại chạy tiếp.
  outputPrefix: '',
  // Bài nhắc từ 2 brand trở lên được ghi 1 lần dưới nhãn này.
  industryLabel: 'Ngành bảo hiểm',

  publishers: [
    'vnexpress.net', 'tuoitre.vn', 'thanhnien.vn', 'dantri.com.vn', 'vietnamnet.vn',
    'tinnhanhchungkhoan.vn', 'baodautu.vn', 'cafef.vn', 'plo.vn', 'sggp.org.vn',
    'vneconomy.vn', 'nhandan.vn', 'bnews.vn', 'thoibaotaichinhvietnam.vn',
    'baotintuc.vn', 'laodong.vn',
    // Báo xuất hiện trong output (file Prudential đã rà + daily). site: đã
    // gồm subdomain (news.laodong.vn, etime.danviet.vn, dttc.sggp.org.vn...).
    'znews.vn', 'kenh14.vn', 'cafebiz.vn', '24h.com.vn', 'afamily.vn', 'danviet.vn',
    'congan.com.vn', 'hanoimoi.vn', 'daibieunhandan.vn', 'baoquocte.vn', 'thanhtra.com.vn',
    'phunuvietnam.vn', 'nguoihanoi.vn', 'nguoidothi.net.vn',
    'vietnamfinance.vn', 'tapchikinhtetaichinh.vn', 'taichinhdoanhnghiep.net.vn',
    'theleader.vn', 'nguoiquansat.vn', 'nhipcaudautu.vn', 'vietstock.vn', 'vietnambiz.vn',
    'nhadautu.vn', 'diendandoanhnghiep.vn', 'thuonghieucongluan.com.vn',
    'doanhnghiepthuonghieu.vn', 'vietnambusinessinsider.vn', 'forbes.vn', 'tapchicongthuong.vn',
    'brandsvietnam.com', 'advertisingvietnam.com', 'vietcetera.com', 'vietnamreport.net',
    'baonghean.vn', 'baodongthap.vn', 'baothanhhoa.vn', 'baocamau.vn', 'baodanang.vn', 'voh.com.vn',
    // Báo lớn toàn quốc chưa có trong output.
    'nld.com.vn', 'tienphong.vn', 'vietnamplus.vn', 'vov.vn', 'vtv.vn', 'baochinhphu.vn',
    'kinhtedothi.vn', 'tapchitaichinh.vn', 'baophapluat.vn',
  ],

  topic: {
    description: 'kinh doanh bao hiem thuong mai tai Viet Nam',
    // Truy vấn tin ngành (bài không cần nhắc hãng nào), chạy RSS cả khoảng + từng
    // tháng. Viết có dấu: RSS gửi qua URL nên không gặp lỗi codepage như ô tìm kiếm.
    queries: [
      '"bảo hiểm nhân thọ"', '"thị trường bảo hiểm"', '"doanh nghiệp bảo hiểm nhân thọ"',
      '"Hiệp hội Bảo hiểm Việt Nam"', '"quản lý giám sát bảo hiểm"', '"Luật Kinh doanh bảo hiểm"',
      '"bảo hiểm liên kết đầu tư"', 'bancassurance', '"đại lý bảo hiểm"', '"doanh thu phí bảo hiểm"',
      '"chi trả quyền lợi bảo hiểm"', '"khiếu nại bảo hiểm nhân thọ"', '"bảo hiểm sức khỏe"', 'insurtech',
    ],
    llmRole: 'Ban la chuyen gia phan tich du lieu social listening cho nganh bao hiem tai Viet Nam.',
    llmExclusions: 'tin giai tri, the thao, y te cong, bao hiem xa hoi, bao hiem y te nha nuoc, tro cap that nghiep, hoac noise',
    // Bài phải chứa ít nhất 1 từ khóa (tiêu đề hoặc thân bài).
    keywords: [
      'bao hiem', 'nhan tho', 'phi nhan tho', 'boi thuong', 'hop dong', 'chi tra',
      'quyen loi bao hiem', 'tu van bao hiem', 'dai ly bao hiem', 'doanh nghiep bao hiem',
      'thi truong bao hiem', 'san pham bao hiem', 'insurtech',
      'sun life', 'prudential', 'manulife', 'generali', 'aia viet nam', 'chubb life',
      'dai ichi life', 'bao viet nhan tho', 'fwd', 'cathay life', 'hanwha life', 'fubon life',
      'mirae asset prevoir', 'phu hung life', 'bidv metlife', 'mb life', 'shinhan life',
      'techcom life', 'lp life',
    ],
    // Tiêu đề chứa các từ này thì loại (trừ khi negativeOverride trả true).
    negativeTitleKeywords: [
      'bao hiem xa hoi', 'bhxh', 'bao hiem that nghiep', 'bao hiem y te', 'bhyt',
      'an sinh xa hoi', 'tro cap that nghiep', 'huong dan vien', 'ca si', 'am nhac',
      'liveshow', 'concert', 'giai tri', 'phim', 'bong da', 'trong tai', 'arbritale',
      'serie a', 'fotmob',
    ],
    // An explicitly branded campaign (e.g. "An Concert by Prudential") is
    // company communication, unlike unrelated entertainment search results.
    negativeOverride: ({ text, content }) => /\bby prudential\b/.test(text) ||
      /\bprudential (?:viet nam|vietnam)\b|\bbao hiem nhan tho prudential\b/.test(content),
  },

  // Parent-company, regional, and foreign-market coverage is outside the
  // Vietnam competitor scope even when a Vietnamese publisher translates it.
  excludePhrases: [
    'chubb life hong kong', 'co phieu generali', 'generali tokenized', 'jefferies generali',
    'manulife financial', 'prudential financial', 'prudential plc', 'sun life asia', 'sun life financial',
  ],

  brands: [
    {
      brand: 'Sun Life Viet Nam',
      aliases: ['Sun Life Viet Nam', 'Sun Life Vietnam', 'Sun Life VN', 'Sun Life'],
      queries: ['"Sun Life" "Việt Nam"', '"Sun Life"', 'sun life vn tin tuc'],
      siteQuery: '"Sun Life"',
    },
    {
      brand: 'Chubb Life Viet Nam',
      aliases: ['Chubb Life Viet Nam', 'Chubb Life Vietnam', 'Chubb Life VN', 'Chubb Life'],
      queries: ['"Chubb Life"', '"Chubb Life Viet Nam"'],
      siteQuery: '"Chubb Life"',
    },
    {
      brand: 'FWD Viet Nam',
      aliases: ['FWD Viet Nam', 'FWD Vietnam', 'FWD VN', 'FWD'],
      queries: ['"FWD" "bảo hiểm"', 'fwd vn tin tuc'],
      siteQuery: '"FWD" "bảo hiểm"',
      lookalikes: FWD_DRIVETRAIN,
      mentionMatcher: hasFwdVietnamMention,
    },
    {
      // Pháp nhân riêng (tiền thân Vietcombank Cardif), khác FWD Việt Nam.
      brand: 'FWD Assurance Viet Nam',
      aliases: ['FWD Assurance Viet Nam', 'FWD Assurance Vietnam', 'FWD Assurance', 'Vietcombank Cardif', 'VCLI'],
      queries: ['"FWD Assurance"', '"Vietcombank Cardif"'],
      siteQuery: '("FWD Assurance" OR "Vietcombank Cardif")',
    },
    {
      brand: 'Dai-ichi Life Viet Nam',
      aliases: [
        'Dai-ichi Life Viet Nam', 'Dai-ichi Life Vietnam', 'Dai-ichi Life VN', 'Dai-ichi Life',
        'Daiichi Life Viet Nam', 'Daiichi Life Vietnam', 'Daiichi Life', 'Daiichi Viet Nam',
        'Daiichi Vietnam', 'Daiichi',
      ],
      queries: ['"Dai-ichi Life" OR "Daiichi Life"', 'dai-ichi life vn bao hiem nhan tho', 'daiichi viet nam bao hiem'],
      siteQuery: '("Dai-ichi Life" OR "Daiichi Life")',
    },
    {
      brand: 'AIA Viet Nam',
      aliases: ['AIA Viet Nam', 'AIA Vietnam', 'AIA VN', 'AIA'],
      queries: ['"AIA" "bảo hiểm"', 'aia vn tin tuc'],
      siteQuery: '"AIA" "bảo hiểm"',
    },
    {
      brand: 'Bao Viet Nhan Tho',
      aliases: ['Bao Viet Nhan Tho', 'Bao Viet Life', 'Baoviet Life', 'Bao Viet'],
      queries: ['"Bảo Việt Nhân Thọ"', 'baoviet life tin tuc'],
      // Unquoted common words match nearly every article on a news site.
      siteQuery: '"Bao Viet Nhan Tho"',
      // These businesses share the Bao Viet name but are not Bao Viet Life.
      excludePhrases: [
        'bao hiem bao viet', 'bao viet insurance', 'bao viet securities',
        'chung khoan bao viet', 'cong ty co phan chung khoan bao viet',
      ],
      // "bảo Việt Nam" (said Vietnam) and "báo Việt" (Vietnamese press) only
      // collide once diacritics/case are removed.
      requirePattern: /(?:Bảo Việt|BẢO VIỆT|Bao Viet|BAO VIET|Baoviet|BaoViet|BAOVIET)(?![ \t]+(?:Nam|NAM)\b)/u,
    },
    {
      brand: 'Prudential Viet Nam',
      aliases: ['Prudential Viet Nam', 'Prudential Vietnam', 'Prudential VN', 'Prudential'],
      queries: ['"Prudential"', '"Prudential Việt Nam"', 'prudential viet nam bao hiem', 'prudential vn tin tuc'],
      excludePhrases: ['prudential finance', 'prudential vietnam finance', 'tai chinh prudential'],
      mentionMatcher: hasPrudentialVietnamMention,
    },
    {
      brand: 'Manulife Viet Nam',
      // Aviva Việt Nam đã chuyển nhượng cho Manulife; không dùng "Aviva" trơn
      // vì trùng tập đoàn Aviva (Anh).
      aliases: [
        'Manulife Viet Nam', 'Manulife Vietnam', 'Manulife VN', 'Manulife',
        'Aviva Viet Nam', 'Aviva Vietnam', 'Vietinbank Aviva',
      ],
      queries: ['"Manulife" "Việt Nam"', 'manulife vn tin tuc'],
      siteQuery: '"Manulife"',
    },
    {
      brand: 'Generali Viet Nam',
      aliases: ['Generali Viet Nam', 'Generali Vietnam', 'Generali VN', 'Generali'],
      queries: ['"Generali" "Việt Nam"', 'generali vn tin tuc'],
      siteQuery: '"Generali"',
    },
    {
      brand: 'Mirae Asset Prevoir Viet Nam',
      // Không dùng "Mirae Asset" trơn: trùng Chứng khoán Mirae Asset.
      aliases: [
        'Mirae Asset Prevoir', 'Mirae Asset Prevoir Life', 'Prevoir Viet Nam', 'Prevoir Vietnam',
      ],
      queries: ['"Mirae Asset Prévoir"', 'mirae asset prevoir bao hiem nhan tho'],
      siteQuery: '"Mirae Asset Prévoir"',
    },
    {
      brand: 'Cathay Life Viet Nam',
      // Không dùng "Cathay" trơn: trùng hãng bay Cathay Pacific.
      aliases: ['Cathay Life Viet Nam', 'Cathay Life Vietnam', 'Cathay Life', 'Bao hiem nhan tho Cathay'],
      queries: ['"Cathay Life"', '"Bảo hiểm nhân thọ Cathay"'],
      siteQuery: '"Cathay Life"',
      excludePhrases: ['cathay financial', 'cathay life dai loan', 'cathay life taiwan'],
    },
    {
      brand: 'Hanwha Life Viet Nam',
      aliases: ['Hanwha Life Viet Nam', 'Hanwha Life Vietnam', 'Hanwha Life VN', 'Hanwha Life'],
      queries: ['"Hanwha Life"', '"Hanwha Life Việt Nam"'],
      siteQuery: '"Hanwha Life"',
      // Đội tuyển LMHT Hàn Quốc (HLE) được báo thể thao/game nhắc thường xuyên.
      excludePhrases: ['hanwha life esports', 'hanwha life insurance han quoc'],
    },
    {
      brand: 'Fubon Life Viet Nam',
      aliases: ['Fubon Life Viet Nam', 'Fubon Life Vietnam', 'Fubon Life', 'Bao hiem nhan tho Fubon'],
      queries: ['"Fubon Life"', '"Bảo hiểm nhân thọ Fubon"'],
      siteQuery: '"Fubon Life"',
      excludePhrases: ['fubon financial', 'fubon life dai loan', 'fubon life taiwan'],
    },
    {
      brand: 'Phu Hung Life',
      // Không dùng "Phú Hưng" trơn: trùng Chứng khoán Phú Hưng và Bảo hiểm Phú Hưng (phi nhân thọ).
      aliases: ['Phu Hung Life', 'Bao hiem nhan tho Phu Hung'],
      queries: ['"Phú Hưng Life"', '"Bảo hiểm nhân thọ Phú Hưng"'],
      siteQuery: '"Phú Hưng Life"',
    },
    {
      brand: 'BIDV MetLife',
      // Không dùng "MetLife" trơn: trùng tập đoàn MetLife (Mỹ) và sân MetLife Stadium.
      aliases: ['BIDV MetLife', 'BIDV Metlife', 'MetLife Viet Nam', 'MetLife Vietnam'],
      queries: ['"BIDV MetLife"', 'bidv metlife bao hiem'],
      siteQuery: '"BIDV MetLife"',
    },
    {
      brand: 'MB Life',
      // Tên cũ: MB Ageas Life.
      aliases: ['MB Life', 'MB Ageas Life', 'MB Ageas', 'MBAL'],
      queries: ['"MB Life"', '"MB Ageas Life"'],
      siteQuery: '"MB Life"',
    },
    {
      brand: 'Shinhan Life Viet Nam',
      // Không dùng "Shinhan" trơn: trùng Ngân hàng/Tài chính Shinhan.
      aliases: ['Shinhan Life Viet Nam', 'Shinhan Life Vietnam', 'Shinhan Life VN', 'Shinhan Life'],
      queries: ['"Shinhan Life"', '"Shinhan Life Việt Nam"'],
      siteQuery: '"Shinhan Life"',
    },
    {
      brand: 'Techcom Life',
      aliases: ['Techcom Life', 'TechcomLife', 'Bao hiem nhan tho Techcom'],
      queries: ['"Techcom Life"', '"Bảo hiểm nhân thọ Techcom"'],
      siteQuery: '"Techcom Life"',
    },
    {
      brand: 'LP Life',
      aliases: ['LP Life', 'LPLife', 'Bao hiem nhan tho LP', 'Bao hiem nhan tho LPBank'],
      queries: ['"LP Life"', '"Bảo hiểm nhân thọ LPBank"'],
      siteQuery: '"LP Life"',
    },
  ],
};
