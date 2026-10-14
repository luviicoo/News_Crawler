'use strict';

const log = require('../output/logger');

/**
 * Chromium chỉ khởi động khi cần (Web search hoặc bài HTTP không đọc được).
 * Playwright không giải phóng CDP session của tab đã đóng, nên trình duyệt
 * được khởi động lại sau mỗi `recycleAfter` bài đọc bằng trình duyệt; phiên
 * Google được lưu và nạp lại.
 */
function createBrowserSession({ launchBrowser, closeBrowser, recycleAfter = 300 }) {
  let launched = false;
  let launching = null;
  let recycling = null;
  let sinceLaunch = 0;

  async function ensure() {
    if (recycling) await recycling;
    if (launched) return;
    if (!launching) {
      launching = launchBrowser({ headless: true, managedSignals: true })
        .then(() => { launched = true; sinceLaunch = 0; })
        // A partially started browser (context or page failed) still holds resources.
        .catch(async err => { await closeBrowser().catch(() => {}); throw err; })
        .finally(() => { launching = null; });
    }
    await launching;
  }

  // Call only while no article tab or search is using the browser.
  async function recycleIfDue() {
    if (!launched || !recycleAfter || sinceLaunch < recycleAfter || recycling) return;
    log.info(`Restarting browser after ${sinceLaunch} articles to release memory.`);
    recycling = (async () => {
      await closeBrowser();
      await launchBrowser({ headless: true, managedSignals: true });
      sinceLaunch = 0;
    })();
    try { await recycling; } finally { recycling = null; }
  }

  async function close() {
    if (launching) await launching.catch(() => {});
    if (launched) {
      launched = false;
      await closeBrowser();
    }
  }

  return {
    ensure, recycleIfDue, close,
    countFetch: () => { sinceLaunch++; },
    waitForRecycle: () => recycling,
  };
}

module.exports = { createBrowserSession };
