// ─── apiToken.js ─────────────────────────────────────────────
// تولید توکنِ API برای نمایندگان (مجزا از JWT پنل).

const crypto = require('crypto');
const PREFIX = 'v2pn_';

function generateApiToken() {
  return PREFIX + crypto.randomBytes(32).toString('hex');
}

module.exports = { generateApiToken };
