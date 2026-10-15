'use strict';

/**
 * CAPTCHA theo từng báo: mỗi báo chỉ mở một cửa sổ xác thực tại một thời điểm.
 * - Đang chờ xác thực báo X: bài khác của X chờ kết quả đó (không mở thêm cửa sổ),
 *   báo khác vẫn chạy bình thường.
 * - Xác thực xong: cookie đã chép sang trình duyệt chính, bài sau của X đọc tiếp.
 * - Không xác thực (đóng cửa sổ/hết giờ): X bị bỏ qua đến hết lượt chạy; bài của X
 *   giữ trạng thái cũ để lượt sau thử lại.
 */

function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * Tên miền đáng mở cửa sổ: '.vn' khớp mọi tên miền đuôi .vn, 'cafef.vn' khớp
 * cafef.vn và tên miền con. Danh sách rỗng = mọi trang.
 */
function matchesDomains(site, domains) {
  if (!domains.length) return true;
  return domains.some(domain => (domain.startsWith('.') ? site.endsWith(domain) : site === domain || site.endsWith(`.${domain}`)));
}

/** @param {(page, isChallengePage) => Promise<boolean>} verify mở cửa sổ xác thực thủ công */
function createSiteGate(verify) {
  // host → Promise<boolean> while a window is open; false once a site was not verified.
  const sites = new Map();
  // Sites outside these domains (shops, foreign pages from web search) are skipped without a window.
  let promptDomains = [];
  const setPromptDomains = domains => { promptDomains = (domains || []).map(domain => String(domain).toLowerCase().replace(/^www\./, '')); };

  const isSkipped = url => sites.get(siteOf(url)) === false;

  async function verifySite(page, isChallengePage) {
    const site = siteOf(page.url());
    const known = sites.get(site);
    if (known === false) return false;
    if (known === undefined && !matchesDomains(site, promptDomains)) {
      sites.set(site, false);
      return false;
    }
    if (known instanceof Promise) {
      if (!(await known)) return false;
      // Verified in another tab: its cookies are already in the shared context.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return !page.isClosed() && !(await isChallengePage(page));
    }
    const attempt = verify(page, isChallengePage).catch(() => false);
    sites.set(site, attempt);
    const verified = await attempt;
    // A verified site may challenge again later (expired clearance) and gets a new window then.
    if (verified) sites.delete(site);
    else sites.set(site, false);
    return verified;
  }

  return { verifySite, isSkipped, setPromptDomains, skippedSites: () => [...sites].filter(([, state]) => state === false).map(([site]) => site) };
}

module.exports = { createSiteGate, siteOf, matchesDomains };
