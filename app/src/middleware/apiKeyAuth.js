// ─── apiKeyAuth.js ───────────────────────────────────────────
// احراز هویتِ درخواست‌های بات با توکنِ اختصاصیِ هر نماینده.
// فقط نمایندگانی که ادمین از پنل api_enabled=1 کرده باشد وصل می‌شوند.

const { getDB } = require('../models/database');

function apiKeyAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ success: false, msg: 'Authorization: Bearer <token> الزامی است' });
  }

  const db = getDB();
  const reseller = db.prepare(
    'SELECT * FROM resellers WHERE api_token = ? AND api_enabled = 1'
  ).get(token);

  if (!reseller) {
    return res.status(401).json({ success: false, msg: 'توکن نامعتبر یا دسترسی API غیرفعال است' });
  }
  if (!reseller.is_active) {
    return res.status(403).json({ success: false, msg: 'حساب نماینده غیرفعال است' });
  }

  req.reseller = reseller;
  next();
}

module.exports = { apiKeyAuth };
