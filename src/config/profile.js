'use strict';

/**
 * Load and validate a brand/category profile (profiles/*.js).
 *
 * The engine holds no brand or industry rules; everything specific to a
 * monitoring project lives in its profile. See profiles/_template.js.
 */

const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PROFILE = 'insurance-vn';
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

function resolveProfilePath(nameOrPath = DEFAULT_PROFILE) {
  const value = String(nameOrPath || DEFAULT_PROFILE).trim();
  // A bare name refers to profiles/<name>.js; anything else is a file path.
  if (/^[\w.-]+$/.test(value) && !value.endsWith('.js')) return path.join(PROJECT_ROOT, 'profiles', `${value}.js`);
  return path.resolve(PROJECT_ROOT, value);
}

function validateProfile(profile, file) {
  const fail = message => { throw new Error(`Invalid profile ${file}: ${message}`); };
  const isStringList = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim());
  const isRegexList = value => Array.isArray(value) && value.every(item => item instanceof RegExp);
  if (!profile || typeof profile !== 'object') fail('must export an object');
  if (typeof profile.name !== 'string' || !profile.name.trim()) fail('"name" is required');
  if (typeof profile.industryLabel !== 'string' || !profile.industryLabel.trim()) fail('"industryLabel" is required');
  if (profile.outputPrefix !== undefined && typeof profile.outputPrefix !== 'string') fail('"outputPrefix" must be a string');
  if (!isStringList(profile.publishers || []) || (profile.publishers || []).some(domain => !DOMAIN.test(domain))) {
    fail('"publishers" must be a list of domains such as vnexpress.net');
  }
  if (!isStringList(profile.excludePhrases || [])) fail('"excludePhrases" must be a list of strings');
  const topic = profile.topic || {};
  for (const key of ['keywords', 'negativeTitleKeywords']) {
    if (!isStringList(topic[key] || [])) fail(`"topic.${key}" must be a list of strings`);
  }
  for (const key of ['description', 'llmRole', 'llmExclusions']) {
    if (topic[key] !== undefined && typeof topic[key] !== 'string') fail(`"topic.${key}" must be a string`);
  }
  if (topic.negativeOverride !== undefined && typeof topic.negativeOverride !== 'function') {
    fail('"topic.negativeOverride" must be a function');
  }
  if (!Array.isArray(profile.brands) || !profile.brands.length) fail('"brands" must be a non-empty list');
  const names = new Set();
  for (const [index, def] of profile.brands.entries()) {
    const where = `brands[${index}]${def?.brand ? ` (${def.brand})` : ''}`;
    if (typeof def?.brand !== 'string' || !def.brand.trim()) fail(`${where}: "brand" is required`);
    if (names.has(def.brand)) fail(`${where}: duplicate brand name`);
    names.add(def.brand);
    if (!isStringList(def.aliases) || !def.aliases.length) fail(`${where}: "aliases" must be a non-empty list`);
    if (!isStringList(def.queries) || !def.queries.length) fail(`${where}: "queries" must be a non-empty list`);
    if (def.siteQuery !== undefined && (typeof def.siteQuery !== 'string' || !def.siteQuery.trim())) {
      fail(`${where}: "siteQuery" must be a non-empty string`);
    }
    if (!isStringList(def.excludePhrases || [])) fail(`${where}: "excludePhrases" must be a list of strings`);
    if (!isRegexList(def.lookalikes || [])) fail(`${where}: "lookalikes" must be a list of RegExp`);
    if (def.lookalikes?.some(pattern => !pattern.global)) fail(`${where}: "lookalikes" patterns need the g flag`);
    if (def.requirePattern !== undefined && !(def.requirePattern instanceof RegExp)) {
      fail(`${where}: "requirePattern" must be a RegExp`);
    }
    if (def.requirePattern?.global) fail(`${where}: "requirePattern" must not use the g flag`);
    if (def.mentionMatcher !== undefined && typeof def.mentionMatcher !== 'function') {
      fail(`${where}: "mentionMatcher" must be a function`);
    }
  }
  return profile;
}

// Unquoted words in a site: search match almost every story of a large
// publisher, which floods the crawl with articles that are later rejected.
function profileWarnings(profile) {
  return profile.brands
    .filter(def => !(def.siteQuery || def.queries[0]).includes('"'))
    .map(def => `Profile ${profile.name}: site: query for ${def.brand} is unquoted ` +
      `("${def.siteQuery || def.queries[0]}"); it may be too broad. Declare siteQuery as a quoted phrase.`);
}

const cache = new Map();

function loadProfile(nameOrPath) {
  const file = resolveProfilePath(nameOrPath);
  if (!cache.has(file)) {
    let profile;
    try {
      profile = require(file);
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(file)) throw new Error(`Profile not found: ${file}`);
      throw err;
    }
    cache.set(file, validateProfile(profile, file));
  }
  return cache.get(file);
}

module.exports = { DEFAULT_PROFILE, loadProfile, validateProfile, profileWarnings, resolveProfilePath };
