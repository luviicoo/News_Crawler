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
const { createSiteGate } = require('./siteGate');

// Đăng ký stealth plugin (chỉ cần 1 lần)
chromiumExtra.use(StealthPlugin());

// File lưu cookies/localStorage giữa các lần chạy
const STATE_FILE = path.join(__dirname, '..', '..', '.google-state.json');

// The User-Agent must agree with the real Chromium build and OS: a stale or
// foreign UA disagrees with sec-ch-ua/navigator.platform and looks like a bot.
const UA_PLATFORMS = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
};

function buildUserAgent(version, platform = process.platform) {
  const major = String(version || '').split('.')[0] || '131';
  return `Mozilla/5.0 (${UA_PLATFORMS[platform] || UA_PLATFORMS.linux}) ` +
    `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Only Google's own cookies/storage are worth keeping between runs (consent,
// verification). Article tabs share the context, and saving every publisher
// and ad network's storage made the session file grow to megabytes.
const isGoogleHost = host => /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(String(host || '').replace(/^\./, ''));

function filterGoogleState(state) {
  const originHost = origin => { try { return new URL(origin).hostname; } catch (_) { return ''; } };
  return {
    cookies: (state?.cookies || []).filter(cookie => isGoogleHost(cookie.domain)),
    origins: (state?.origins || []).filter(entry => isGoogleHost(originHost(entry.origin))),
  };
}

function readSavedState() {
  if (!fs.existsSync(STATE_FILE)) return undefined;
  try {
    return filterGoogleState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (err) {
    log.warn(`Ignoring unreadable session file: ${err.message}`);
    return undefined;
  }
}

let _browser       = null;
let _googleContext = null; // 1 context dùng chung → giữ cookies qua các query
let _googlePage    = null; // 1 tab tái sử dụng cho Google searches
let _isHeadless    = false;
let _verificationQueue = Promise.resolve();
let _verificationBrowser = null;
let _verificationGeneration = 0;
let _managedSignals = false;
let _userAgent = buildUserAgent('');

// ─── Launch ───────────────────────────────────────────────────────────────────

async function launchBrowser({ managedSignals = false } = {}) {
  if (_browser) return _browser;

  const headless = true;
  _managedSignals = managedSignals;
  _isHeadless = Boolean(headless);
  log.info(`Launching Chromium stealth (headless=${headless}) …`);

  _browser = await chromiumExtra.launch({
    headless,
    handleSIGINT: !managedSignals,
    handleSIGTERM: !managedSignals,
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

  _userAgent = buildUserAgent(_browser.version?.());

  // Load cookies từ lần chạy trước nếu có
  const storageState = readSavedState();
  if (storageState) {
    log.info('Loading saved Google session (cookies)…');
  } else {
    log.info('No saved session found — will create new one.');
  }

  _googleContext = await _browser.newContext({
    userAgent: _userAgent,
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

// Keep the crawler alive in the background; use a separate window only for
// manual verification. Serialize prompts so concurrent articles open one window.
function verifyInPopup(page, isChallengePage) {
  const generation = _verificationGeneration;
  const task = _verificationQueue.then(async () => {
    if (generation !== _verificationGeneration && !page.isClosed()) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    if (page.isClosed() || !(await isChallengePage(page))) return !page.isClosed();
    const configured = Number(process.env.CAPTCHA_PAUSE_MS || 120000);
    const pauseMs = Number.isFinite(configured) ? Math.max(0, configured) : 120000;
    if (!pauseMs) return false;
    let popupBrowser;
    try {
      log.captcha(pauseMs);
      const context = page.context();
      const state = await context.storageState();
      popupBrowser = await chromiumExtra.launch({ headless: false,
        handleSIGINT: !_managedSignals, handleSIGTERM: !_managedSignals });
      _verificationBrowser = popupBrowser;
      const popupContext = await popupBrowser.newContext({
        storageState: state, userAgent: _userAgent, locale: 'vi-VN',
        timezoneId: 'Asia/Ho_Chi_Minh',
      });
      const popup = await popupContext.newPage();
      await popup.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await popup.bringToFront();
      const deadline = Date.now() + pauseMs;
      while (!popup.isClosed() && Date.now() < deadline) {
        if (!(await isChallengePage(popup))) {
          const verified = await popupContext.storageState();
          await context.addCookies(verified.cookies);
          // Install localStorage for any verification redirects before navigation.
          await page.addInitScript((origins) => {
            const entry = origins.find(item => item.origin === location.origin);
            for (const item of entry?.localStorage || []) localStorage.setItem(item.name, item.value);
          }, verified.origins);
          await page.goto(popup.url(), { waitUntil: 'domcontentloaded', timeout: 30000 });
          if (!(await isChallengePage(page))) {
            _verificationGeneration++;
            await saveGoogleSession();
            log.info('[CAPTCHA] Verified; continuing in the background.');
            return true;
          }
          // A token can be tied to the browser. Keep the window available for
          // another manual attempt instead of accepting an unverified page.
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      log.warn('[CAPTCHA] Verification window closed or timed out.');
      return false;
    } catch (error) {
      log.warn(`[CAPTCHA] Could not complete manual verification: ${error.message}`);
      return false;
    } finally {
      if (popupBrowser) await popupBrowser.close().catch(() => {});
      _verificationBrowser = null;
    }
  });
  _verificationQueue = task.catch(() => {});
  return task;
}

// One verification window per publisher; a publisher left unverified is skipped
// for the rest of the run instead of reopening a window for each of its articles.
const siteGate = createSiteGate(verifyInPopup);

// ─── Lưu session sau mỗi search ──────────────────────────────────────────────

/**
 * Lưu cookies + localStorage của Google context vào file.
 * Gọi sau mỗi lần search thành công để lần sau không cần CAPTCHA lại.
 */
async function saveGoogleSession() {
  if (!_googleContext) return;
  try {
    const state = filterGoogleState(await _googleContext.storageState());
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
  if (_verificationBrowser) await _verificationBrowser.close().catch(() => {});
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
  verifyInPopup,
  verifySite: siteGate.verifySite,
  isSiteSkipped: siteGate.isSkipped,
  skippedSites: siteGate.skippedSites,
  setCaptchaDomains: siteGate.setPromptDomains,
  newArticlePage,
  closeArticlePage,
  newPage,
  closePage,
  buildUserAgent,
  filterGoogleState,
};
