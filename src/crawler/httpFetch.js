'use strict';

/**
 * Tải bài bằng HTTP thường và đọc HTML bằng linkedom, nhanh hơn nhiều so với
 * mở tab Chromium. createStaticPage() bọc document thành "page" có url(),
 * evaluate(), $eval(), $$eval() để chạy lại đúng các hàm trích xuất viết cho
 * Playwright (article.js, dateParser.js, captcha.js).
 */

const { parseHTML } = require('linkedom');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Page giả lập trên HTML tĩnh. Hàm truyền vào evaluate() được viết cho trình
 * duyệt nên dùng biến toàn cục `document`/`location`; chúng được gán tạm thời
 * trong lúc gọi. Mọi hàm trích xuất đều đồng bộ nên không có hai trang dùng
 * chung biến toàn cục cùng lúc.
 */
function createStaticPage(html, url) {
  const { window, document } = parseHTML(html);
  // Relative canonical/hreflang links resolve against the article URL.
  if (!document.querySelector('base[href]') && document.head) {
    const base = document.createElement('base');
    base.setAttribute('href', url);
    document.head.prepend(base);
  }
  const location = new URL(url);
  const withGlobals = fn => {
    const saved = { document: globalThis.document, location: globalThis.location, window: globalThis.window };
    Object.assign(globalThis, { document, location, window });
    try {
      return fn();
    } finally {
      Object.assign(globalThis, saved);
    }
  };
  return {
    url: () => url,
    isClosed: () => false,
    document,
    async evaluate(fn, arg) {
      return withGlobals(() => fn(arg));
    },
    async $eval(selector, fn, arg) {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`No element for selector: ${selector}`);
      return withGlobals(() => fn(element, arg));
    },
    async $$eval(selector, fn, arg) {
      return withGlobals(() => fn(Array.from(document.querySelectorAll(selector)), arg));
    },
  };
}

function charsetOf(contentType, head) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1];
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1] : 'utf-8';
}

async function readLimited(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`Article page larger than ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * @returns {Promise<{ok:boolean, status:number, finalUrl:string, html?:string, contentType?:string, error?:string}>}
 */
async function fetchHtml(url, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8',
      },
    });
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, error: err.name === 'TimeoutError' ? `HTTP timeout after ${timeoutMs}ms` : err.message };
  }
  const finalUrl = response.url || url;
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    return { ok: false, status: response.status, finalUrl, contentType, error: `Article HTTP ${response.status}` };
  }
  if (contentType && !/html|xml/i.test(contentType)) {
    response.body?.cancel().catch(() => {});
    return { ok: false, status: response.status, finalUrl, contentType, notHtml: true, error: `Not an HTML page (${contentType})` };
  }
  try {
    const bytes = await readLimited(response);
    let decoder;
    try {
      decoder = new TextDecoder(charsetOf(contentType, bytes.subarray(0, 2048).toString('latin1')));
    } catch (_) {
      decoder = new TextDecoder('utf-8');
    }
    return { ok: true, status: response.status, finalUrl, contentType, html: decoder.decode(bytes) };
  } catch (err) {
    return { ok: false, status: response.status, finalUrl, contentType, error: err.message };
  }
}

module.exports = { createStaticPage, fetchHtml, charsetOf, USER_AGENT };
