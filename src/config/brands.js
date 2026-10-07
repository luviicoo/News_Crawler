'use strict';

/**
 * Backward-compatible view of the default profile. Brand and industry rules
 * live in profiles/*.js; see src/config/profile.js.
 */
const { loadProfile } = require('./profile');

const profile = loadProfile();

module.exports = { BRANDS: profile.brands, INDUSTRY_LABEL: profile.industryLabel };
