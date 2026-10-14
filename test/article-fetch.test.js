'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStaticPage, charsetOf } = require('../src/crawler/httpFetch');
const { extractArticle, MAX_CONTENT_CHARS } = require('../src/crawler/article');
const { createArticleFetcher } = require('../src/crawler/fetcher');
const { isCaptchaPage } = require('../src/crawler/captcha');
const {
  createGoogleNewsDecoder, decodeLegacyId, parseDecodingParams, buildBatchBody, parseBatchResponse,
} = require('../src/crawler/googleNewsDecode');
const { cleanVietnameseText } = require('../src/parser/vnText');
const { detectPrSignals, extractSourceCredit } = require('../src/parser/articleSignals');

const body = 'Công ty Bảo hiểm nhân thọ ra mắt sản phẩm mới cho khách hàng. '.repeat(10);
const html = ({ extraHead = '', extraBody = '', text = body } = {}) => `<!doctype html><html><head>
  <title>Trang chủ</title>
  <meta property="og:title" content="Ra mắt sản phẩm bảo hiểm mới">
  <link rel="canonical" href="/kinh-doanh/ra-mat-san-pham-123.html">
  <meta property="article:published_time" content="2026-10-08T09:00:00+07:00">
  <meta property="article:section" content="Kinh doanh">
  <meta property="article:tag" content="bảo hiểm"><meta property="article:tag" content="sản phẩm">
  <meta name="description" content="Mô tả ngắn">
  <script type="application/ld+json">{"@type":"NewsArticle","author":[{"name":"Kh&#xE1;nh Huy&#x1EC1;n"}],
    "keywords":"nhân thọ, khách hàng","dateModified":"2026-10-08T10:00:00+07:00"}</script>
  ${extraHead}</head><body>
  <ul class="breadcrumb"><li><a>Kinh doanh</a></li><li><a>Doanh nghiệp</a></li></ul>
  <h1>Ra mắt sản phẩm bảo hiểm mới</h1><p class="sapo">Sapo của bài viết.</p>
  <article class="fck_detail"><p>${text}</p><div class="tin-lien-quan"><article>Tin khác không liên quan</article></div></article>
  ${extraBody}</body></html>`;

test('static HTML pages run the browser extractors: title, body, date, identity and metadata', async () => {
  const page = createStaticPage(html(), 'https://example.vn/kinh-doanh/ra-mat-san-pham-123.html?utm_source=x');
  const result = await extractArticle(page, page.url());
  assert.equal(result.articleTitle, 'Ra mắt sản phẩm bảo hiểm mới');
  assert.ok(result.articleText.includes('ra mắt sản phẩm mới'));
  assert.ok(!result.articleText.includes('Tin khác'));
  assert.equal(result.publishDate, '2026-10-08T02:00:00.000Z');
  assert.equal(result.canonicalUrl, 'https://example.vn/kinh-doanh/ra-mat-san-pham-123.html');
  assert.equal(result.meta.author, 'Khánh Huyền'); // Double-encoded entities are decoded.
  assert.equal(result.meta.section, 'Kinh doanh');
  assert.deepEqual(result.meta.tags, ['bảo hiểm', 'sản phẩm', 'nhân thọ', 'khách hàng']);
  assert.equal(result.meta.sapo, 'Sapo của bài viết.');
  assert.deepEqual(result.meta.prSignals, []);
  assert.equal(result.contentTruncated, false);
  assert.equal(await isCaptchaPage(page), false);
  // Globals used while evaluating are restored afterwards.
  assert.equal(globalThis.document, undefined);
});

test('long bodies are kept up to two CSV cells and flagged when cut', async () => {
  const page = createStaticPage(html({ text: 'chữ '.repeat(20000) }), 'https://example.vn/a-1.html');
  const result = await extractArticle(page, page.url());
  assert.equal(result.articleText.length, MAX_CONTENT_CHARS);
  assert.equal(result.contentTruncated, true);
});

test('PR signals come from labels, the URL path or a disclosure line, never from a bare ad slot', async () => {
  const page = createStaticPage(html({ extraBody: '<div class="sponsor-box">Nội dung tài trợ</div><div class="ad-sponsor">Quảng cáo</div>' }),
    'https://example.vn/thong-tin-doanh-nghiep/bai-1.html');
  const { meta } = await extractArticle(page, page.url());
  assert.deepEqual(meta.prSignals.sort(), ['label:noi dung tai tro', 'url:/thong-tin-doanh-nghiep/']);
  assert.deepEqual(detectPrSignals({ url: 'https://x.vn/a.html', labels: ['Quảng cáo'] }), []);
  assert.deepEqual(detectPrSignals({ url: 'https://nhandan.vn/a.html', labels: ['Xã hội', 'Nội dung có tài trợ'] }),
    ['label:noi dung co tai tro']);
  assert.deepEqual(detectPrSignals({ url: 'https://thanhnien.vn/a.htm', author: 'Thông tin dịch vụ' }), ['author:thong tin dich vu']);
  assert.deepEqual(detectPrSignals({ url: 'https://x.vn/a.html', body: `${body} (Thông cáo báo chí)` }), ['body:thong cao bao chi']);
  assert.deepEqual(detectPrSignals({ url: 'https://x.vn/doanh-nghiep-viet/a.html', section: 'Tin doanh nghiệp' },
    { labels: ['tin doanh nghiệp'], urlPatterns: [/\/doanh-nghiep-viet\//] }), ['label:tin doanh nghiep', 'url:/doanh-nghiep-viet/']);
  assert.equal(extractSourceCredit(`${body} Theo VnExpress`), 'VnExpress');
  assert.equal(extractSourceCredit(`${body} (Nguồn: Bộ Tài chính)`), 'Bộ Tài chính');
  assert.equal(extractSourceCredit(`${body} Minh Anh`), '');
});

test('Vietnamese text is NFC-normalized without invisible characters or curly quotes', () => {
  assert.equal(cleanVietnameseText('Bảo​ hiểm   “nhân thọ” é &amp; &#x1EA1;'), 'Bảo hiểm "nhân thọ" é & ạ');
  assert.equal(cleanVietnameseText('é').length, 1);
  assert.equal(charsetOf('text/html; charset=windows-1258', ''), 'windows-1258');
  assert.equal(charsetOf('', '<meta charset="utf-8">'), 'utf-8');
});

test('Google News links decode over HTTP: legacy ids directly, new ids through batchexecute', async () => {
  const url = 'https://vnexpress.net/a-1.html';
  const legacy = Buffer.concat([Buffer.from([0x08, 0x13, 0x22, url.length]), Buffer.from(url), Buffer.from([0xd2, 0x01, 0x00])])
    .toString('base64url');
  assert.equal(decodeLegacyId(legacy), url);
  assert.equal(decodeLegacyId(Buffer.from('\x08\x13\x22\x06AU_yqLabc').toString('base64url')), '');
  assert.deepEqual(parseDecodingParams('<c-wiz><div data-n-a-sg="SIG" data-n-a-ts="1700"></div></c-wiz>'),
    { signature: 'SIG', timestamp: '1700' });
  const request = JSON.parse(decodeURIComponent(buildBatchBody('ID1', { signature: 'SIG', timestamp: '1700' }).slice('f.req='.length)));
  assert.deepEqual(JSON.parse(request[0][0][1]).slice(-3), ['ID1', 1700, 'SIG']);
  const reply = `)]}'\n\n${JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', 'https://tuoitre.vn/b.htm', 1])], ['di', 1]])}\n\n`;
  assert.equal(parseBatchResponse(reply), 'https://tuoitre.vn/b.htm');

  const calls = [];
  const fetchImpl = async (target, init = {}) => {
    calls.push(init.method || 'GET');
    if (!init.method) return new Response('<div data-n-a-sg="SIG" data-n-a-ts="1700"></div>');
    return new Response(reply);
  };
  const decoder = createGoogleNewsDecoder({ fetchImpl });
  assert.equal(await decoder.decode('https://news.google.com/rss/articles/CBMiNEWID?oc=5'), 'https://tuoitre.vn/b.htm');
  assert.deepEqual(calls, ['GET', 'POST']);
  assert.equal(await decoder.decode(`https://news.google.com/rss/articles/${legacy}?oc=5`), url);
  assert.equal(calls.length, 2); // Legacy ids need no request.

  // A 429 pauses decoding for a cooldown that doubles while Google keeps throttling, then resets.
  let clock = 0;
  let status = 429;
  const throttled = createGoogleNewsDecoder({ now: () => clock, cooldownMs: 1000,
    fetchImpl: async (target, init = {}) => (status === 429 ? new Response('', { status })
      : init.method ? new Response(reply) : new Response('<div data-n-a-sg="SIG" data-n-a-ts="1700"></div>')) });
  assert.equal(await throttled.decode('https://news.google.com/rss/articles/CBMiA?oc=5'), '');
  assert.equal(throttled.isThrottled(), true);
  clock = 999;
  assert.equal(throttled.isThrottled(), true);
  clock = 1000;
  assert.equal(await throttled.decode('https://news.google.com/rss/articles/CBMiB?oc=5'), '');
  clock = 2999;
  assert.equal(throttled.isThrottled(), true); // Second cooldown is 2000 ms.
  clock = 3000;
  status = 200;
  assert.equal(await throttled.decode('https://news.google.com/rss/articles/CBMiC?oc=5'), 'https://tuoitre.vn/b.htm');
  assert.equal(throttled.isThrottled(), false);
});

test('a throttle slows later decodes and is remembered by the next run', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'news.db.gn-decode.json');
  let clock = 1000;
  const first = createGoogleNewsDecoder({ now: () => clock, stateFile, minIntervalMs: 1000, cooldownMs: 60000,
    fetchImpl: async () => new Response('', { status: 429 }) });
  assert.equal(await first.decode('https://news.google.com/rss/articles/CBMiA?oc=5'), '');
  assert.equal(first.intervalMs(), 2000);
  // A restart within the cooldown starts throttled, with the slower pace.
  let requests = 0;
  const second = createGoogleNewsDecoder({ now: () => clock + 30000, stateFile, minIntervalMs: 1000, cooldownMs: 60000,
    fetchImpl: async () => { requests++; return new Response('', { status: 500 }); } });
  assert.equal(second.isThrottled(), true);
  assert.equal(second.intervalMs(), 2000);
  assert.equal(await second.decode('https://news.google.com/rss/articles/CBMiB?oc=5'), '');
  assert.equal(requests, 0);
  const later = createGoogleNewsDecoder({ now: () => clock + 61000, stateFile, minIntervalMs: 1000 });
  assert.equal(later.isThrottled(), false);
});

test('throttled Google News links are deferred instead of opened in the browser', async () => {
  const browserReads = [];
  const fetcher = createArticleFetcher({
    decoder: { decode: async () => '', isThrottled: () => true },
    browserFetch: async target => { browserReads.push(target); return {}; },
  });
  const result = await fetcher.fetchArticle('https://news.google.com/rss/articles/CBMiNO?oc=5');
  assert.equal(result.deferred, true);
  assert.equal(browserReads.length, 0);
  assert.equal(fetcher.isDecodeThrottled(), true);
  assert.equal(fetcher.stats.deferred, 1);
});

test('articles are read over HTTP and fall back to the browser only when HTTP is not enough', async () => {
  const pages = {
    'https://example.vn/ok-1.html': () => new Response(html(), { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    'https://example.vn/js-2.html': () => new Response(html({ text: 'Đang tải…' }), { headers: { 'content-type': 'text/html' } }),
    'https://example.vn/file.pdf': () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
    'https://example.vn/blocked-3.html': () => new Response('denied', { status: 403 }),
    'https://example.vn/challenge-4.html': () => new Response('<title>Just a moment...</title><div id="challenge-running"></div>',
      { headers: { 'content-type': 'text/html' } }),
  };
  const browserReads = [];
  let ensured = 0;
  const fetcher = createArticleFetcher({
    fetchImpl: async target => pages[target](),
    decoder: { decode: async target => (target.includes('CBMiOK') ? 'https://example.vn/ok-1.html' : '') },
    browserFetch: async target => { browserReads.push(target); return { finalUrl: target, articleTitle: 'T', articleText: 'x'.repeat(300) }; },
  });
  const ensureBrowser = async () => { ensured++; };
  const ok = await fetcher.fetchArticle('https://example.vn/ok-1.html', { ensureBrowser });
  assert.equal(ok.fetchMethod, 'http');
  assert.equal(ok.meta.section, 'Kinh doanh');
  assert.equal((await fetcher.fetchArticle('https://news.google.com/rss/articles/CBMiOK?oc=5', { ensureBrowser })).fetchMethod, 'http');
  assert.equal((await fetcher.fetchArticle('https://example.vn/file.pdf', { ensureBrowser })).notArticle, true);
  for (const target of ['https://example.vn/js-2.html', 'https://example.vn/blocked-3.html', 'https://example.vn/challenge-4.html',
    'https://news.google.com/rss/articles/CBMiNO?oc=5']) {
    assert.equal((await fetcher.fetchArticle(target, { ensureBrowser })).fetchMethod, 'browser', target);
  }
  assert.equal(browserReads.length, 4);
  assert.equal(ensured, 4);
  assert.deepEqual({ http: fetcher.stats.http, browser: fetcher.stats.browser }, { http: 2, browser: 4 });
});
