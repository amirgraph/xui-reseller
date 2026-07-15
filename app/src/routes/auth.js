const { notifyAdmin } = require('../lib/notify');
const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB } = require('../models/database');
const { generateToken, adminAuth } = require('../middleware/auth');

const router = express.Router();

// Admin login
router.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const db = getDB();
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (!admin || !bcrypt.compareSync(password, admin.password)) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const token = generateToken({ id: admin.id, username: admin.username, role: 'admin' });
    res.json({ success: true, token, username: admin.username });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Reseller login
router.post('/reseller/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const db = getDB();
    const reseller = db.prepare('SELECT * FROM resellers WHERE username = ?').get(username);
    if (!reseller || !bcrypt.compareSync(password, reseller.password)) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    if (!reseller.is_active) {
      return res.status(403).json({ success: false, message: 'Account disabled' });
    }
    const token = generateToken({ id: reseller.id, username: reseller.username, role: 'reseller' });
    res.json({
      success: true, token,
      reseller: {
        id: reseller.id,
        username: reseller.username,
        name: reseller.name,
        brand_name: reseller.brand_name,
        brand_color: reseller.brand_color,
        brand_bg_color: reseller.brand_bg_color,
        brand_logo: reseller.brand_logo,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Change admin password
router.post('/admin/change-password', adminAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const db = getDB();
    const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
    if (!bcrypt.compareSync(oldPassword, admin.password)) {
      return res.status(401).json({ success: false, message: 'Wrong current password' });
    }
    const hashed = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE admins SET password = ? WHERE id = ?').run(hashed, req.admin.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// Change reseller password
router.post('/reseller/change-password', async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const authHeader = req.headers.authorization;
  if(!authHeader) return res.status(401).json({ success: false, message: 'No token' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(authHeader.replace('Bearer ',''), process.env.JWT_SECRET);
    const db = require('../models/database').getDB();
    const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(decoded.id);
    if(!reseller) return res.status(404).json({ success: false, message: 'Not found' });
    if(!bcrypt.compareSync(oldPassword, reseller.password)) {
      return res.status(401).json({ success: false, message: 'رمز فعلی اشتباه است' });
    }
    const hashed = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE resellers SET password=?, plain_password=? WHERE id=?').run(hashed, newPassword, reseller.id);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// ─── Public: Submit Panel Order ───────────────────────────────

router.post('/panel-order', async (req, res) => {
  const db = require('../models/database').getDB();
  const { full_name, telegram_id, username, password, card_receipt } = req.body;
  if (!full_name || !telegram_id || !username || !password) {
    return res.status(400).json({ success: false, message: 'همه فیلدها الزامی است' });
  }
  if (!/^\d{5,15}$/.test(String(telegram_id))) {
    return res.status(400).json({ success: false, message: 'آیدی تلگرام باید عدد باشد' });
  }
  if (!/^[a-zA-Z0-9_]{4,32}$/.test(username)) {
    return res.status(400).json({ success: false, message: 'نام کاربری فقط حروف انگلیسی و عدد (۴ تا ۳۲ کاراکتر)' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'رمز عبور حداقل ۶ کاراکتر' });
  }
  if (db.prepare('SELECT id FROM resellers WHERE username=?').get(username)) {
    return res.status(400).json({ success: false, message: 'این نام کاربری قبلاً ثبت شده' });
  }
  if (db.prepare("SELECT id FROM panel_orders WHERE username=? AND status='pending'").get(username)) {
    return res.status(400).json({ success: false, message: 'درخواستی با این نام کاربری در انتظار بررسی است' });
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  // مبلغ از خودِ پلن برداشته می‌شود، نه از فرم — وگرنه هر کسی می‌توانست
  // amount دلخواه بفرستد. قبلاً از settings.panel_price می‌آمد که یعنی
  // فقط یک محصول قابلِ فروش بود.
  const { planByKey, activePlans } = require('../models/plans');
  const plan = planByKey(req.body.plan_key || '') || activePlans()[0];
  if (!plan) return res.status(400).json({ success: false, message: 'فعلاً پلنی برای فروش تعریف نشده' });
  if (!plan.is_active) return res.status(400).json({ success: false, message: 'این پلن دیگر فعال نیست' });
  const amount = Number(plan.price) || 0;
  const result = db.prepare(
    'INSERT INTO panel_orders (full_name, telegram_id, username, password_hash, plain_password, card_receipt, amount, plan_key) VALUES (?,?,?,?,?,?,?,?)'
  ).run(full_name, String(telegram_id), username, passwordHash, password, card_receipt || null, amount, plan.key);
  notifyAdmin("\u{1F195} <b>\u062F\u0631\u062E\u0648\u0627\u0633\u062A \u067E\u0646\u0644 \u062C\u062F\u06CC\u062F</b>\n\u{1F464} " + full_name + "\n\u{1F4F1} " + String(telegram_id) + "\n\u{1F511} " + username + "\n\u{1F4B0} " + amount.toLocaleString() + " \u062A\u0648\u0645\u0627\u0646");
  res.json({ success: true, id: result.lastInsertRowid, message: 'درخواست ثبت شد — پس از تأیید پنل شما ساخته میشه' });
});

// Public: get panel order settings
// پلن‌های فعال — عمومی، چون صفحهٔ خرید قبل از لاگین آن‌ها را نشان می‌دهد.
// فقط فیلدهای لازم برای نمایش؛ sort_order/is_active به بیرون درز نکند.
router.get('/plans', (req, res) => {
  const plans = require('../models/plans').activePlans().map(p => ({
    key: p.key, name: p.name, description: p.description, price: p.price,
    traffic_gb: p.traffic_gb, max_clients: p.max_clients,
    duration_days: p.duration_days, billing: p.billing,
    price_per_gb: p.price_per_gb, initial_balance: p.initial_balance,
  }));
  res.json({ success: true, data: plans });
});

router.get('/panel-order/settings', (req, res) => {
  const db = require('../models/database').getDB();
  // unlimited_price اضافه شد تا فرانت نرخِ نامحدود را از سرور بگیرد؛ قبلاً
  // ۱۸۰٬۰۰۰ در HTML هاردکد بود و با مقدارِ واقعیِ بک‌اند فرق می‌کرد.
  const keys = ['panel_price','panel_traffic_gb','panel_price_per_gb','panel_max_clients',
                'charge_card_number','charge_card_owner','unlimited_price','unlimited_enabled'];
  const result = {};
  keys.forEach(k => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
    result[k] = row ? row.value : '';
  });
  res.json({ success: true, data: result });
});


module.exports = router;

// Mini App — اطلاعات برند عمومی نمایندگی
router.get('/mini-brand/:id', (req, res) => {
  const db = getDB();
  let reseller = null;
  const { id } = req.params;
  if (id === 'default') {
    reseller = db.prepare('SELECT * FROM resellers WHERE is_active=1 ORDER BY id LIMIT 1').get();
  } else if (/^\d+$/.test(id)) {
    reseller = db.prepare('SELECT * FROM resellers WHERE id=? AND is_active=1').get(parseInt(id));
  } else {
    reseller = db.prepare('SELECT * FROM resellers WHERE username=? AND is_active=1').get(id);
  }
  if (!reseller) return res.json({ success: false, message: 'not found' });
  res.json({
    success: true,
    brand: {
      name: reseller.brand_name || reseller.username,
      logo: reseller.brand_logo || '🌐',
      color: reseller.brand_color || '#7C5CFC',
      bg: reseller.brand_bg_color || '#07030f',
      telegram: reseller.telegram_support || '',
      motion: reseller.brand_motion || 'hearts',
    }
  });
});
