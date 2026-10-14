'use strict';

/**
 * Chuẩn hoá văn bản tiếng Việt trước khi lưu store (tiêu đề, sapo, thân bài,
 * tác giả, tag). Giữ nguyên dấu; việc so khớp không dấu vẫn dùng normalizeText
 * của bộ phân loại.
 *
 * - NFC: chữ có dấu tổ hợp (e + dấu) thành một ký tự, để cùng một chữ không
 *   có hai cách mã hoá khác nhau trong dữ liệu.
 * - Bỏ ký tự vô hình (zero-width, soft hyphen, BOM) và ký tự điều khiển.
 * - Nháy cong → nháy thẳng; khoảng trắng đặc biệt → khoảng trắng thường.
 * - Giải entity HTML còn sót (một số báo mã hoá hai lần: "Kh&#xE1;nh").
 */

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeLeftoverEntities(text) {
  const fromCode = code => (code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '');
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => fromCode(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec) => fromCode(Number(dec)))
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, name) => NAMED_ENTITIES[name]);
}

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

function cleanVietnameseText(value, { multiline = false } = {}) {
  let text = decodeLeftoverEntities(String(value ?? '')).normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(SPACES, ' ')
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'");
  text = multiline
    ? text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n')
    : text.replace(/\s+/g, ' ');
  return text.trim();
}

module.exports = { cleanVietnameseText };
