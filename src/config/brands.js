'use strict';

/**
 * Brand definitions for the insurance crawler.
 *
 * ASCII-safe aliases/queries avoid codepage issues when Playwright or the
 * Windows console interacts with Google search inputs.
 *
 * `siteQuery` is used for per-publisher `site:` searches. It must be quoted:
 * unquoted common words (e.g. bao viet nhan tho) match nearly every article on
 * a Vietnamese news site. It defaults to the first query; only brands whose
 * first query floods publisher searches override it.
 */
const BRANDS = [
  {
    brand: 'Sun Life Viet Nam',
    aliases: ['Sun Life Viet Nam', 'Sun Life Vietnam', 'Sun Life VN', 'Sun Life'],
    queries: ['sun life viet nam', '"Sun Life"', 'sun life vn tin tuc'],
  },
  {
    brand: 'Chubb Life Viet Nam',
    aliases: ['Chubb Life Viet Nam', 'Chubb Life Vietnam', 'Chubb Life VN', 'Chubb Life'],
    queries: ['chubb life viet nam', '"Chubb Life Viet Nam"'],
  },
  {
    brand: 'FWD Viet Nam',
    aliases: ['FWD Viet Nam', 'FWD Vietnam', 'FWD VN', 'FWD'],
    queries: ['fwd viet nam bao hiem', 'fwd vn tin tuc'],
  },
  {
    brand: 'Dai-ichi Life Viet Nam',
    aliases: [
      'Dai-ichi Life Viet Nam',
      'Dai-ichi Life Vietnam',
      'Dai-ichi Life VN',
      'Dai-ichi Life',
      'Daiichi Life Viet Nam',
      'Daiichi Life Vietnam',
      'Daiichi Life',
      'Daiichi Viet Nam',
      'Daiichi Vietnam',
      'Daiichi',
    ],
    queries: [
      'dai-ichi life viet nam',
      'dai-ichi life vn bao hiem nhan tho',
      'daiichi viet nam bao hiem',
    ],
  },
  {
    brand: 'AIA Viet Nam',
    aliases: ['AIA Viet Nam', 'AIA Vietnam', 'AIA VN', 'AIA'],
    queries: ['aia viet nam bao hiem', 'aia vn tin tuc'],
  },
  {
    brand: 'Bao Viet Nhan Tho',
    aliases: ['Bao Viet Nhan Tho', 'Bao Viet Life', 'Baoviet Life', 'Bao Viet'],
    queries: ['bao viet nhan tho', 'baoviet life tin tuc'],
    siteQuery: '"Bao Viet Nhan Tho"',
  },
  {
    brand: 'Prudential Viet Nam',
    aliases: ['Prudential Viet Nam', 'Prudential Vietnam', 'Prudential VN', 'Prudential'],
    queries: ['"Prudential"', '"Prudential Việt Nam"', 'prudential viet nam bao hiem', 'prudential vn tin tuc'],
  },
  {
    brand: 'Manulife Viet Nam',
    aliases: ['Manulife Viet Nam', 'Manulife Vietnam', 'Manulife VN', 'Manulife'],
    queries: ['manulife viet nam bao hiem', 'manulife vn tin tuc'],
  },
  {
    brand: 'Generali Viet Nam',
    aliases: ['Generali Viet Nam', 'Generali Vietnam', 'Generali VN', 'Generali'],
    queries: ['generali viet nam bao hiem', 'generali vn tin tuc'],
  },
];

// Articles naming two or more tracked insurers are reported once under this
// label instead of once per brand.
const INDUSTRY_LABEL = 'Ngành bảo hiểm';

module.exports = { BRANDS, INDUSTRY_LABEL };
