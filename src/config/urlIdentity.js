'use strict';

/**
 * Luật nhận dạng "cùng một bài báo" từ URL.
 *
 * Dùng bởi buildArticleKey() trong src/parser/urlParser.js. Sửa file này
 * khi gặp thêm kiểu URL trùng mới, không cần sửa code chống trùng.
 */

// Segment ngôn ngữ trong path: /vn/..., /en/..., /vi-vn/... → bỏ khi so trùng.
const LANGUAGE_SEGMENTS = [
  'vi', 'vn', 'vie', 'vi-vn', 'vi_vn',
  'en', 'eng', 'en-us', 'en-gb', 'en-vn', 'en_us', 'en_vn',
  'zh', 'zh-cn', 'zh-tw', 'cn', 'ja', 'jp', 'ko', 'kr', 'fr', 'de', 'th',
];

// Subdomain ngôn ngữ/phiên bản: en.site.vn, m.site.vn, amp.site.vn → site.vn.
const STRIPPED_SUBDOMAINS = ['www', 'm', 'mobile', 'amp', 'vi', 'vn', 'en'];

// Query param chỉ đổi ngôn ngữ hoặc giao diện, không đổi bài.
const IGNORED_QUERY_PARAMS = [
  'lang', 'language', 'locale', 'hl', 'lng',
  'amp', 'outputtype',
];

// Báo có cùng bài ở 2 URL: có và không có hậu tố "-<id số>" (từ 5 chữ số trở lên,
// để không cắt năm như "bao-cao-tai-chinh-2024").
// Ví dụ vietnam.vn/prudential-...-trach-nhiem và vietnam.vn/prudential-...-trach-nhiem-298454.
// Chỉ bật theo từng domain đã kiểm chứng, vì ở báo khác hậu tố số chính là ID bài.
const SLUG_NUMERIC_SUFFIX_DOMAINS = ['vietnam.vn'];

module.exports = {
  LANGUAGE_SEGMENTS,
  STRIPPED_SUBDOMAINS,
  IGNORED_QUERY_PARAMS,
  SLUG_NUMERIC_SUFFIX_DOMAINS,
};
