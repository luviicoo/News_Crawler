'use strict';

/**
 * Playwright browser lifecycle — stealth edition.
 *
 * Dùng playwright-extra + puppeteer-extra-plugin-stealth để patch
 * tự động 20+ fingerprinting signals mà Google dùng để phát hiện bot:
 *   - navigator.webdriver
 *   - chrome.runtime
 *   - navigator.plugins / mimeTypes
 *   - WebGL vendor / renderer
 *   - Permission API behaviour
 *   - iframe contentWindow
 *   - hairline feature
 *   - ... và nhiều cái khác
 *
 * Storage state (cookies + localStorage) được lưu vào file sau mỗi lần
 * chạy, load lại lần sau → Google không thấy "trình duyệt mới" mỗi lần.
 */

const path   = require('path');
const fs     = require('fs');
const { chromium: chromiumExtra } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const log    = require('../output/logger');

// Đăng ký stealth plugin (chỉ cần 1 lần)
chromiumExtra.use(StealthPlugin());

// File lưu cookies/localStorage giữa các lần chạy
const STATE_FILE = path.join(__dirname, '..', '..', '.google-state.json');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

let _browser       = null;
let _googleContext = null; // 1 context dùng chung → giữ cookies qua các query
let _googlePage    = null; // 1 tab tái sử dụng cho Google searches
let _isHeadless    = false;

// ─── Launch ───────────────────────────────────────────────────────────────────

async function launchBrowser({ headless = false } = {}) {
  if (_browser) return _browser;

  _isHeadless = Boolean(headless);
  log.info(`Launching Chromium stealth (headless=${headless}) …`);

  _browser = await chromiumExtra.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
    ],
  });

  // Load cookies từ lần chạy trước nếu có
  const storageState = fs.existsSync(STATE_FILE) ? STATE_FILE : undefined;
  if (storageState) {
    log.info('Loading saved Google session (cookies)…');
  } else {
    log.info('No saved session found — will create new one.');
  }

  _googleContext = await _browser.newContext({
    userAgent: USER_AGENT,
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 1280, height: 800 },
    permissions: [],
    storageState,   // load cookies nếu có
    extraHTTPHeaders: {
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  log.info('Browser + Google context ready.');
  return _browser;
}

// ─── Lưu session sau mỗi search ──────────────────────────────────────────────

/**
 * Lưu cookies + localStorage của Google context vào file.
 * Gọi sau mỗi lần search thành công để lần sau không cần CAPTCHA lại.
 */
async function saveGoogleSession() {
  if (!_googleContext) return;
  try {
    const state = await _googleContext.storageState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    log.info('Google session saved.');
  } catch (err) {
    log.warn(`Could not save session: ${err.message}`);
  }
}

/**
 * Xoá file session (dùng khi muốn bắt đầu lại từ đầu).
 */
function clearGoogleSession() {
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
    log.info('Google session cleared.');
  }
}

// ─── Google tab (tái sử dụng) ─────────────────────────────────────────────────

async function getGooglePage() {
  if (!_googleContext) throw new Error('Browser not launched. Call launchBrowser() first.');
  if (_googlePage && !_googlePage.isClosed()) return _googlePage;
  _googlePage = await _googleContext.newPage();
  return _googlePage;
}

// ─── Article pages ────────────────────────────────────────────────────────────

async function newArticlePage() {
  if (!_googleContext) throw new Error('Browser not launched. Call launchBrowser() first.');
  return _googleContext.newPage();
}

async function closeArticlePage(page) {
  try {
    if (page && !page.isClosed()) await page.close();
  } catch (_) {}
}

// Backward compat (dùng bởi article.js cũ)
async function newPage()      { return newArticlePage(); }
async function closePage(p)   { return closeArticlePage(p); }

// ─── Shutdown ─────────────────────────────────────────────────────────────────

async function closeBrowser() {
  if (_browser) {
    // Lưu session trước khi đóng
    await saveGoogleSession();
    await _browser.close();
    _browser = _googleContext = _googlePage = null;
    _isHeadless = false;
    log.info('Browser closed.');
  }
}

function isHeadlessMode() {
  return _isHeadless;
}

module.exports = {
  launchBrowser,
  closeBrowser,
  isHeadlessMode,
  getGooglePage,
  saveGoogleSession,
  clearGoogleSession,
  newArticlePage,
  closeArticlePage,
  newPage,
  closePage,
};
