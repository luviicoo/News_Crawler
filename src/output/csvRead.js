'use strict';

const fs = require('fs');

/**
 * Đọc CSV (RFC 4180: ô trong ngoặc kép, "" là một dấu nháy, xuống dòng trong ô)
 * thành mảng object theo dòng tiêu đề. Bỏ BOM ở đầu file.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^﻿/, '');
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field); field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[index + 1] === '\n') index++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += char;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter(cells => cells.length > 1 || cells[0]);
  return body.map(cells => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ''])));
}

function readCsvFile(file) {
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

module.exports = { parseCsv, readCsvFile };
