'use strict';

const { extractHostname, isHomepageUrl } = require('../parser/urlParser');

// Not press coverage: social networks, job boards and spam mirrors. A listed
// domain also blocks its subdomains (web.facebook.com, vn.linkedin.com...).
const SOCIAL_DOMAINS = ['facebook.com', 'fb.com', 'fb.watch', 'instagram.com', 'threads.net', 'threads.com',
  'tiktok.com', 'youtube.com', 'youtu.be', 'twitter.com', 'x.com', 'linkedin.com', 'pinterest.com',
  'reddit.com', 'quora.com', 'tumblr.com', 'zalo.me', 't.me', 'telegram.org', 'lemon8-app.com'];
const JOB_DOMAINS = ['vietnamworks.com', 'topcv.vn', 'careerviet.vn', 'careerbuilder.vn', 'careerlink.vn',
  'timviecnhanh.com', 'timviec365.vn', 'vieclam24h.vn', 'jobsgo.vn', 'mywork.com.vn', 'joboko.com',
  'itviec.com', 'topdev.vn', 'glints.com', 'jobstreet.vn', 'jobstreet.com', 'indeed.com', 'jooble.org',
  'ybox.vn', 'vieclamtot.com', 'jobs.vn', 'careerjet.vn', 'hrchannels.com', 'tuyendungnhanh.com'];
const SPAM_DOMAINS = ['arabsvoice.net', 'tin.skydoor.net', 'twaslnews.com', 'pvoil.com.vn'];
const BLOCKED = new Set([...SOCIAL_DOMAINS, ...JOB_DOMAINS, ...SPAM_DOMAINS]);
// Company career portals: careers.<x>, jobs.<x>, tuyendung.<x>, vieclam.<x>.
const JOB_HOST = /^(?:careers?|jobs?|tuyendung|tuyen-dung|vieclam|viec-lam)\./;

function isBlocked(url) {
  const host = extractHostname(url).replace(/^(?:www|m)\./, '');
  if (!host) return false;
  if (JOB_HOST.test(host)) return true;
  const labels = host.split('.');
  return labels.some((_, i) => BLOCKED.has(labels.slice(i).join('.')));
}

const isListing = url => isHomepageUrl(url) || /\/(?:tags?|authors?|search|tim-kiem)(?:\/|\?|$)|\.pdf(?:\?|$)/i.test(url);

module.exports = { isBlocked, isListing };
