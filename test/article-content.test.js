'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium } = require('playwright');
const { extractArticleContent } = require('../src/crawler/article');

test('article content excludes related stories even inside a broad articleBody wrapper', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const body = 'Hàng chục tấn nông sản tồn đọng vì dịch bệnh. '.repeat(20);
    await page.setContent(`<div itemprop="articleBody">
      <article class="article-detail"><h1>Tin nông sản</h1><div>${body}</div>
        <div class="tin-lien-quan"><article>Prudential đóng góp quỹ vaccine</article></div>
      </article><article>Prudential mở văn phòng</article>
      <script type="text/template">Prudential trong mẫu ẩn</script></div>`);
    const content = await extractArticleContent(page);
    assert.ok(content.includes('nông sản tồn đọng'));
    assert.ok(!content.includes('Prudential'));

    await page.setContent(`<div itemprop="articleBody"><article>Prudential ở tin liên quan</article>
      <div class="fck_detail">${body} Công ty Prudential Việt Nam giới thiệu sản phẩm mới.
        <aside>Prudential Financial ở Mỹ</aside></div></div>`);
    const actual = await extractArticleContent(page);
    assert.ok(actual.includes('Prudential Việt Nam giới thiệu'));
    assert.ok(!actual.includes('tin liên quan'));
    assert.ok(!actual.includes('Financial'));
  } finally {
    await browser.close();
  }
});

test('publish date is read from malformed JSON-LD before falling back to page text', async () => {
  const { extractPublishDate } = require('../src/parser/dateParser');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<script type="application/ld+json">{ "@type": "NewsArticle",
      "datePublished": "2026-10-06T11:30:00.000+07:00", "hasPart": [ , ] }</script>
      <aside>Tin khác 17/10/2025</aside><p>Nội dung bài.</p>`);
    assert.equal(await extractPublishDate(page, 'https://example.vn/bai-viet-123.html'), '2026-10-06T04:30:00.000Z');
  } finally {
    await browser.close();
  }
});
