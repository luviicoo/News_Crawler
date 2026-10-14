'use strict';

/**
 * Đổi link Google News (news.google.com/rss/articles/<id>) sang link bài thật
 * bằng HTTP, không mở trình duyệt.
 *
 * - id kiểu cũ chứa sẵn URL trong chuỗi base64 (protobuf: 08 13 22 <độ dài> URL).
 * - id kiểu mới (bắt đầu bằng "AU_yqL" sau khi giải base64) cần chữ ký và mốc
 *   thời gian lấy từ trang bài của Google News, rồi gọi batchexecute.
 * Mọi lỗi trả về '' để crawler dùng trình duyệt như trước.
 */

const fs = require('fs');
const pLimit = require('p-limit');
const log = require('../output/logger');

const BATCH_URL = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function articleIdOf(url) {
  const match = String(url || '').match(/^https?:\/\/news\.google\.com\/(?:rss\/)?(?:articles|read)\/([^/?#]+)/i);
  return match ? match[1] : '';
}

/** URL nằm sẵn trong id kiểu cũ; '' nếu là id kiểu mới hoặc không đọc được. */
function decodeLegacyId(id) {
  let text;
  try {
    text = Buffer.from(id, 'base64url').toString('latin1');
  } catch (_) {
    return '';
  }
  const prefix = '\x08\x13\x22';
  if (text.startsWith(prefix)) text = text.slice(prefix.length);
  const suffix = '\xd2\x01\x00';
  if (text.endsWith(suffix)) text = text.slice(0, -suffix.length);
  if (!text) return '';
  const length = text.charCodeAt(0);
  text = length >= 0x80 ? text.slice(2, length + 1) : text.slice(1, length + 1);
  if (text.startsWith('AU_yqL')) return '';
  return /^https?:\/\/\S+$/.test(text) ? text : '';
}

function parseDecodingParams(html) {
  const signature = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const timestamp = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  return signature && timestamp ? { signature, timestamp } : null;
}

function buildBatchBody(id, { signature, timestamp }) {
  const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"VN:vi",null,1,null,null,null,null,null,0,1],` +
    `"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${timestamp},"${signature}"]`;
  return `f.req=${encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]))}`;
}

function parseBatchResponse(text) {
  const chunk = String(text || '').split('\n\n')[1];
  if (!chunk) return '';
  for (const entry of JSON.parse(chunk)) {
    if (entry?.[0] !== 'wrb.fr' || entry[1] !== 'Fbv4je' || !entry[2]) continue;
    const url = JSON.parse(entry[2])?.[1];
    if (/^https?:\/\//i.test(url || '')) return url;
  }
  return '';
}

const MAX_INTERVAL_MS = 10000;
// Successful decodes in a row before the interval steps back toward its minimum.
const SPEED_UP_AFTER = 200;

/**
 * @param {string} [options.stateFile] JSON file that keeps the throttle and pace
 *   between runs, so a restart does not hit Google again while it still throttles.
 */
function createGoogleNewsDecoder({ concurrency = 2, timeoutMs = 15000, fetchImpl = fetch,
  cooldownMs = 10 * 60000, maxCooldownMs = 60 * 60000, minIntervalMs = 0, jitter = 0.25,
  stateFile = '', now = Date.now, random = Math.random } = {}) {
  const limit = pLimit(Math.max(1, concurrency));
  const inflight = new Map();
  // A 429 pauses decoding for a cooldown that doubles while Google keeps throttling,
  // and doubles the interval between decodes; long success streaks shorten it again.
  let throttledUntil = 0;
  let nextCooldown = cooldownMs;
  let intervalMs = minIntervalMs;
  let successes = 0;
  let nextStart = 0;
  const isThrottled = () => now() < throttledUntil;

  if (stateFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      throttledUntil = Number(saved.throttledUntil) || 0;
      nextCooldown = Math.min(Math.max(Number(saved.nextCooldown) || cooldownMs, cooldownMs), maxCooldownMs);
      intervalMs = Math.min(Math.max(Number(saved.intervalMs) || minIntervalMs, minIntervalMs), MAX_INTERVAL_MS);
      if (isThrottled()) {
        log.warn(`[URL] Google News still throttled from an earlier run; Google News links wait ${Math.ceil((throttledUntil - now()) / 60000)} min.`);
      }
    } catch (_) {
      // No saved state yet.
    }
  }
  function saveState() {
    if (!stateFile) return;
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ throttledUntil, nextCooldown, intervalMs }));
    } catch (err) {
      log.warn(`[URL] Could not save the Google News decoding state: ${err.message}`);
    }
  }

  function throttle() {
    if (isThrottled()) return;
    throttledUntil = now() + nextCooldown;
    intervalMs = Math.min(Math.max(intervalMs * 2, 500), MAX_INTERVAL_MS);
    successes = 0;
    log.warn(`[URL] Google News throttled link decoding (HTTP 429); Google News links wait ${Math.round(nextCooldown / 60000)} min, ` +
      `then decode every ${(intervalMs / 1000).toFixed(1)} s.`);
    nextCooldown = Math.min(nextCooldown * 2, maxCooldownMs);
    saveState();
  }

  function succeeded() {
    nextCooldown = cooldownMs;
    if (++successes < SPEED_UP_AFTER || intervalMs <= minIntervalMs) return;
    successes = 0;
    intervalMs = Math.max(minIntervalMs, Math.round(intervalMs * 0.8));
    saveState();
  }

  // Spaces decodes out (with jitter) so a long crawl stays under Google's rate limit.
  async function pace() {
    const startAt = Math.max(now(), nextStart);
    nextStart = startAt + intervalMs * (1 + jitter * (2 * random() - 1));
    if (startAt > now()) await new Promise(resolve => setTimeout(resolve, startAt - now()));
  }

  async function decodeNew(id) {
    await pace();
    if (isThrottled()) return '';
    const headers = { 'user-agent': USER_AGENT, 'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8' };
    const page = await fetchImpl(`https://news.google.com/rss/articles/${id}?hl=vi&gl=VN&ceid=VN:vi`,
      { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (page.status === 429) throttle();
    if (!page.ok) throw new Error(`Google News article page HTTP ${page.status}`);
    const params = parseDecodingParams(await page.text());
    if (!params) throw new Error('Google News decoding parameters not found');
    const response = await fetchImpl(BATCH_URL, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: buildBatchBody(id, params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429) throttle();
    if (!response.ok) throw new Error(`Google News batchexecute HTTP ${response.status}`);
    const url = parseBatchResponse(await response.text());
    if (url) succeeded();
    return url;
  }

  /** Link bài thật cho link Google News; '' nếu không giải được. */
  async function decode(url) {
    const id = articleIdOf(url);
    if (!id) return '';
    const legacy = decodeLegacyId(id);
    if (legacy) return legacy;
    if (isThrottled()) return '';
    // Only in-flight decodes are shared, so a long crawl does not keep every link.
    if (!inflight.has(id)) {
      inflight.set(id, limit(() => (isThrottled() ? '' : decodeNew(id))).catch(err => {
        if (!isThrottled()) log.warn(`[URL] Google News link not decoded over HTTP (${err.message}); using the browser.`);
        return '';
      }).finally(() => inflight.delete(id)));
    }
    return inflight.get(id);
  }

  return { decode, isThrottled, intervalMs: () => intervalMs };
}

module.exports = { createGoogleNewsDecoder, articleIdOf, decodeLegacyId, parseDecodingParams, buildBatchBody, parseBatchResponse };
