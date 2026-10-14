'use strict';

/**
 * Tín hiệu đọc từ trang bài: dấu hiệu bài PR/tài trợ và dòng ghi nguồn
 * ("Theo …", "Nguồn: …"). Mẫu ở đây là quy ước chung của báo chí; profile
 * thêm mẫu riêng bằng `prSignals` (xem profiles/_template.js).
 */

const { normalizeText } = require('../utils/articleClassifier');

// Nhãn (không dấu) báo dùng cho bài trả tiền. Không gồm "quảng cáo" đơn lẻ:
// ô quảng cáo trên sidebar của mọi bài cũng mang chữ này.
const PR_LABELS = [
  'thong tin doanh nghiep', 'thong tin dich vu', 'noi dung tai tro', 'noi dung co tai tro', 'bai tai tro',
  'tai tro boi', 'duoc tai tro',
  'bai pr', 'tin pr', 'thong cao bao chi', 'tin quang cao', 'bai quang cao',
  'sponsored', 'sponsored content', 'advertorial', 'partner content', 'paid content', 'brand voice',
];
const PR_URL_PATTERNS = [
  /\/(?:thong-tin-doanh-nghiep|noi-dung-tai-tro|tin-tai-tro|tai-tro|thong-cao-bao-chi|sponsored|advertorial|brand-voice|pr)(?:\/|$)/i,
];

function matchLabels(texts, labels) {
  const found = new Set();
  for (const text of texts) {
    const padded = ` ${normalizeText(text)} `;
    for (const label of labels) if (padded.includes(` ${label} `)) found.add(label);
  }
  return [...found];
}

/**
 * @param {{url:string, labels?:string[], section?:string, tags?:string[], author?:string, body?:string}} page
 * @param {{labels?:string[], urlPatterns?:RegExp[]}} [extra] prSignals của profile
 * @returns {string[]} ví dụ ["label:thong tin doanh nghiep", "url:/tai-tro/"]
 */
function detectPrSignals({ url = '', labels = [], section = '', tags = [], author = '', body = '' }, extra = {}) {
  const prLabels = [...PR_LABELS, ...(extra.labels || []).map(normalizeText).filter(Boolean)];
  const signals = matchLabels([...labels, section, ...tags], prLabels).map(label => `label:${label}`);
  // Some papers sign paid stories with a byline such as "Thông tin dịch vụ".
  for (const label of matchLabels([author], prLabels)) signals.push(`author:${label}`);
  // PR stories often carry the disclosure as the first or last line of the body.
  const text = String(body || '');
  for (const label of matchLabels([text.slice(0, 300), text.slice(-300)], prLabels)) signals.push(`body:${label}`);
  let path = '';
  try { path = new URL(url).pathname; } catch (_) { /* not a URL */ }
  for (const pattern of [...PR_URL_PATTERNS, ...(extra.urlPatterns || [])]) {
    const match = path.match(pattern);
    if (match) signals.push(`url:${match[0]}`);
  }
  return [...new Set(signals)];
}

// "… Theo VnExpress", "(Nguồn: Bộ Y tế)" ở cuối thân bài.
function extractSourceCredit(body) {
  const tail = String(body || '').trim().slice(-200);
  const match = tail.match(/(?:^|[.!?"')\]]\s+|\s)\(?(?:Theo|Nguồn|Nguon|Source)\s*:?\s+([^.()\n]{2,80}?)\)?\s*\.?$/u);
  return match ? match[1].trim() : '';
}

module.exports = { PR_LABELS, detectPrSignals, extractSourceCredit };
