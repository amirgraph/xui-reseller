const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB } = require('../models/database');
const { adminAuth } = require('../middleware/auth');
const xui = require('../services/xuiService');
const { generateApiToken } = require('../lib/apiToken');
const { getDB: db } = require('../models/database');

const router = express.Router();

// ─── Resellers ───────────────────────────────────────────────

// List all resellers
router.get('/resellers', adminAuth, (req, res) => {
  const db = getDB();
  const resellers = db.prepare(`
    SELECT id, username, name, email, telegram_id, balance,
           traffic_limit_gb, traffic_used_gb, max_clients, current_clients,
           allowed_inbounds, brand_name, brand_color, is_active,
           created_at, expires_at, price_per_gb,
           can_create_panels, discount_percent, parent_id
    FROM resellers ORDER BY created_at DESC
  `).all();
  res.json({ success: true, data: resellers });
});

// Create reseller
router.post('/resellers', adminAuth, (req, res) => {
  const db = getDB();
  const {
    username, password, name, email, telegram_id,
    traffic_limit_gb = 0, max_clients = 10,
    allowed_inbounds = [], price_per_gb = 0,
    brand_name = '', brand_color = '#6C63FF',
    brand_bg_color = '#0a0a0f', expires_at = null,
    can_create_panels = 0, discount_percent = 0
  } = req.body;
  // تخفیف باید ۰..۱۰۰ بماند — بیرونِ این بازه یعنی قیمتِ منفی یا افزایشِ قیمت
  const disc = Math.min(100, Math.max(0, Number(discount_percent) || 0));

  try {
    if (db.prepare('SELECT id FROM resellers WHERE username = ?').get(username)) {
      return res.status(400).json({ success: false, message: 'Username already exists' });
    }
    const hashed = bcrypt.hashSync(password, 10);
    const result = db.prepare(`
      INSERT INTO resellers (
        username, password, name, email, telegram_id,
        traffic_limit_gb, max_clients, allowed_inbounds,
        price_per_gb, brand_name, brand_color, brand_bg_color, expires_at,
        can_create_panels, discount_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      username, hashed, name, email || null, telegram_id || null,
      traffic_limit_gb, max_clients, JSON.stringify(allowed_inbounds),
      price_per_gb, brand_name, brand_color, brand_bg_color, expires_at,
      can_create_panels ? 1 : 0, disc
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update reseller
router.put('/resellers/:id', adminAuth, (req, res) => {
  const db = getDB();
  const { id } = req.params;
  const {
    name, email, telegram_id, traffic_limit_gb, max_clients,
    allowed_inbounds, price_per_gb, brand_name, brand_color,
    brand_bg_color, is_active, balance, expires_at, password,
    can_create_panels, discount_percent
  } = req.body;

  try {
    let query = `UPDATE resellers SET 
      name=?, email=?, telegram_id=?, traffic_limit_gb=?, max_clients=?,
      allowed_inbounds=?, price_per_gb=?, brand_name=?, brand_color=?,
      brand_bg_color=?, is_active=?, expires_at=?,
      can_create_panels=?, discount_percent=?`;
    let params = [
      name, email, telegram_id, traffic_limit_gb, max_clients,
      JSON.stringify(allowed_inbounds || []), price_per_gb, brand_name,
      brand_color, brand_bg_color, is_active ? 1 : 0, expires_at,
      can_create_panels ? 1 : 0, Math.min(100, Math.max(0, Number(discount_percent) || 0))
    ];

    if (balance !== undefined) {
      query += ', balance=?';
      params.push(balance);
    }

    if (password) {
      query += ', password=?';
      params.push(bcrypt.hashSync(password, 10));
    }

    query += ' WHERE id=?';
    params.push(id);

    db.prepare(query).run(...params);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete reseller (and remove all their clients from 3X-UI)
router.delete('/resellers/:id', adminAuth, async (req, res) => {
  const db = getDB();
  const { id } = req.params;
  try {
    const clients = db.prepare('SELECT * FROM clients WHERE reseller_id = ?').all(id);
    for (const client of clients) {
      try {
        await xui.deleteClient(client.xui_inbound_id, client.xui_uuid);
      } catch (e) { /* ignore xui errors */ }
    }
    db.prepare('DELETE FROM clients WHERE reseller_id = ?').run(id);
    db.prepare('DELETE FROM transactions WHERE reseller_id = ?').run(id);
    db.prepare('DELETE FROM resellers WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Add balance to reseller
router.post('/resellers/:id/balance', adminAuth, (req, res) => {
  const db = getDB();
  const { id } = req.params;
  const { amount, description } = req.body;
  try {
    db.prepare('UPDATE resellers SET balance = balance + ? WHERE id = ?').run(amount, id);
    db.prepare(`
      INSERT INTO transactions (reseller_id, type, amount, description)
      VALUES (?, 'credit', ?, ?)
    `).run(id, amount, description || 'Admin top-up');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Bot API access (per reseller) ─────────────────────────────
// ادمین تعیین می‌کند کدام نماینده‌ها اجازه دارند بات خودشان را از طریق
// API این پنل (مسیرهای /panel/api، شبیه API سه‌ایکس‌یو) وصل کنند.

router.post('/resellers/:id/api-token/enable', adminAuth, (req, res) => {
  const db = getDB();
  const reseller = db.prepare('SELECT id FROM resellers WHERE id=?').get(req.params.id);
  if (!reseller) return res.status(404).json({ success: false, message: 'Reseller not found' });
  const token = generateApiToken();
  db.prepare('UPDATE resellers SET api_enabled=1, api_token=? WHERE id=?').run(token, req.params.id);
  res.json({ success: true, data: { token } });
});

router.post('/resellers/:id/api-token/disable', adminAuth, (req, res) => {
  const db = getDB();
  db.prepare('UPDATE resellers SET api_enabled=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

router.get('/resellers/:id/api-token', adminAuth, (req, res) => {
  const db = getDB();
  const r = db.prepare('SELECT api_enabled, api_token FROM resellers WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ success: false, message: 'Reseller not found' });
  res.json({ success: true, data: { enabled: !!r.api_enabled, token: r.api_enabled ? r.api_token : null } });
});

// ─── Inbounds ───────────────────────────────────────────────

router.get('/inbounds', adminAuth, async (req, res) => {
  try {
    const inbounds = await xui.getInbounds();
    // Cache in DB
    const db = getDB();
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO inbounds_cache (id, tag, protocol, port, remark, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    for (const ib of inbounds) {
      upsert.run(ib.id, ib.tag, ib.protocol, ib.port, ib.remark, JSON.stringify(ib));
    }
    res.json({ success: true, data: inbounds });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── All Clients ─────────────────────────────────────────────

router.get('/clients', adminAuth, (req, res) => {
  const db = getDB();
  const clients = db.prepare(`
    SELECT c.*, r.username as reseller_username, r.name as reseller_name
    FROM clients c
    LEFT JOIN resellers r ON c.reseller_id = r.id
    ORDER BY c.created_at DESC
  `).all();
  res.json({ success: true, data: clients });
});

// ─── Dashboard Stats ─────────────────────────────────────────

router.get('/stats', adminAuth, (req, res) => {
  const db = getDB();
  const totalResellers = db.prepare('SELECT COUNT(*) as c FROM resellers').get().c;
  const activeResellers = db.prepare('SELECT COUNT(*) as c FROM resellers WHERE is_active=1').get().c;
  const totalClients = db.prepare('SELECT COUNT(*) as c FROM clients').get().c;
  const activeClients = db.prepare('SELECT COUNT(*) as c FROM clients WHERE is_active=1').get().c;
  const totalTraffic = db.prepare('SELECT SUM(traffic_used_gb) as t FROM clients').get().t || 0;
  const recentActivity = db.prepare(`
    SELECT r.username, r.name, r.current_clients, r.traffic_used_gb, r.balance
    FROM resellers r ORDER BY r.created_at DESC LIMIT 5
  `).all();

  res.json({
    success: true,
    data: { totalResellers, activeResellers, totalClients, activeClients, totalTraffic, recentActivity }
  });
});

// ─── Transactions ────────────────────────────────────────────

router.get('/transactions', adminAuth, (req, res) => {
  const db = getDB();
  const txns = db.prepare(`
    SELECT t.*, r.username as reseller_username
    FROM transactions t
    LEFT JOIN resellers r ON t.reseller_id = r.id
    ORDER BY t.created_at DESC LIMIT 100
  `).all();
  res.json({ success: true, data: txns });
});


// ─── Charge Requests (Admin) ──────────────────────────────────

router.get('/charge-requests', adminAuth, (req, res) => {
  const db = getDB();
  const status = req.query.status || 'pending';
  const rows = db.prepare(`
    SELECT cr.*, r.username as reseller_username, r.name as reseller_name
    FROM charge_requests cr
    JOIN resellers r ON r.id = cr.reseller_id
    WHERE cr.status = ?
    ORDER BY cr.created_at DESC
    LIMIT 50
  `).all(status);
  res.json({ success: true, data: rows });
});

router.post('/charge-requests/:id/approve', adminAuth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM charge_requests WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'درخواست پیدا نشد' });
  if (row.status !== 'pending') return res.status(400).json({ success: false, message: 'این درخواست قبلاً بررسی شده' });
  
  db.prepare('UPDATE charge_requests SET status=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run('approved', row.id);
  db.prepare('UPDATE resellers SET balance = balance + ? WHERE id=?').run(row.amount, row.reseller_id);
  db.prepare(
    'INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?,?,?,?)'
  ).run(row.reseller_id, 'credit', row.amount, 'شارژ کیف پول — تأیید ادمین');
  
  res.json({ success: true, message: 'شارژ تأیید و اعتبار افزوده شد' });
});

router.post('/charge-requests/:id/reject', adminAuth, (req, res) => {
  const db = getDB();
  const { note } = req.body;
  const row = db.prepare('SELECT * FROM charge_requests WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'درخواست پیدا نشد' });
  if (row.status !== 'pending') return res.status(400).json({ success: false, message: 'این درخواست قبلاً بررسی شده' });
  
  db.prepare('UPDATE charge_requests SET status=?, admin_note=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run('rejected', note||'', row.id);
  res.json({ success: true, message: 'درخواست رد شد' });
});

// Settings
router.get('/settings', adminAuth, (req, res) => {
  const db = getDB();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({ success: true, data: settings });
});

// کلیدهای مجاز — وگرنه هر ادمینی می‌تواند settings را با کلیدهای دلخواه
// پر کند و کدی که با پیش‌فرض کار می‌کند را گیج کند.
const NUMERIC_SETTINGS = ['panel_price','panel_traffic_gb','panel_price_per_gb','panel_max_clients',
                          'unlimited_price','test_traffic_gb','test_days','test_max_clients'];
const BOOL_SETTINGS = ['unlimited_enabled','test_enabled','voice_enabled','antifilter_extra'];
const TEXT_SETTINGS = ['charge_card_number','charge_card_owner','charge_amounts',
                       'bot_welcome','bot_help','bot_support'];
// متنِ ربات می‌تواند چندخطی و خالی باشد (خالی = پیش‌فرضِ کد)
const FREE_TEXT_SETTINGS = ['bot_welcome','bot_help','bot_support'];

router.put('/settings', adminAuth, (req, res) => {
  const db = getDB();
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ success: false, message: 'key required' });
  const known = [...NUMERIC_SETTINGS, ...BOOL_SETTINGS, ...TEXT_SETTINGS];
  if (!known.includes(key)) return res.status(400).json({ success: false, message: 'کلید ناشناخته: ' + key });

  // متنِ آزاد را trim نمی‌کنیم جز از دو سر: خطوط و فاصله‌های داخلی عمدی‌اند
  let v = String(value == null ? '' : value);
  if (FREE_TEXT_SETTINGS.includes(key)) {
    v = v.replace(/^\s+|\s+$/g, '');
    if (v.length > 4000) return res.status(400).json({ success: false, message: 'متن خیلی بلند است (حداکثر ۴۰۰۰ کاراکتر)' });
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, v);
    return res.json({ success: true });
  }
  v = v.trim();
  if (NUMERIC_SETTINGS.includes(key)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, message: 'مقدار باید عددِ مثبت باشد' });
    v = String(n);
  } else if (BOOL_SETTINGS.includes(key)) {
    v = (v === '1' || v === 'true') ? '1' : '0';
  } else if (key === 'charge_amounts') {
    const list = v.split(',').map(x => parseInt(String(x).trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
    if (!list.length) return res.status(400).json({ success: false, message: 'حداقل یک مبلغِ معتبر با کاما وارد کن' });
    v = list.join(',');
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, v);
  res.json({ success: true });
});

router.get('/test-stats', adminAuth, (req, res) => {
  const db = getDB();
  const q = s => db.prepare(s).get().c;
  res.json({ success: true, data: {
    total: q('SELECT COUNT(*) c FROM test_claims'),
    panel: q("SELECT COUNT(*) c FROM test_claims WHERE kind='panel'"),
    config: q("SELECT COUNT(*) c FROM test_claims WHERE kind='config'"),
  }});
});



// ─── Panel Orders (Admin) ─────────────────────────────────────

router.get('/panel-orders', adminAuth, (req, res) => {
  const db = getDB();
  const status = req.query.status || 'pending';
  const rows = db.prepare('SELECT * FROM panel_orders WHERE status=? ORDER BY created_at DESC').all(status);
  res.json({ success: true, data: rows });
});

router.post('/panel-orders/:id/approve', adminAuth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM panel_orders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'درخواست پیدا نشد' });
  if (row.status !== 'pending') return res.status(400).json({ success: false, message: 'قبلاً بررسی شده' });
  if (db.prepare('SELECT id FROM resellers WHERE username=?').get(row.username)) {
    return res.status(400).json({ success: false, message: 'نام کاربری قبلاً ثبت شده' });
  }
  // مشخصاتِ پنل از خودِ پلنِ خریداری‌شده می‌آید — همان منبعی که ربات هم
  // استفاده می‌کند، تا وب و ربات دو تعریفِ متفاوت از «پنل» نداشته باشند.
  const { planByKey, resellerFieldsFromPlan } = require('../models/plans');
  const plan = planByKey(row.plan_key || 'default');
  if (!plan) return res.status(400).json({ success: false, message: 'پلنِ این درخواست پیدا نشد' });
  const f = resellerFieldsFromPlan(plan);
  const result = db.prepare(`
    INSERT INTO resellers (username, password, name, telegram_id, traffic_limit_gb, max_clients, price_per_gb, balance, expires_at, plain_password, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(row.username, row.password_hash, row.full_name, row.telegram_id,
         f.traffic_limit_gb, f.max_clients, f.price_per_gb, f.balance, f.expires_at, row.plain_password);
  if (f.balance > 0) {
    db.prepare('INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?,?,?,?)')
      .run(result.lastInsertRowid, 'credit', f.balance, 'شارژ اولیه — پلن ' + plan.name);
  }
  db.prepare("UPDATE panel_orders SET status='approved', confirmed_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
  res.json({ success: true, reseller_id: result.lastInsertRowid, message: 'پنل ساخته شد' });
});

router.post('/panel-orders/:id/reject', adminAuth, (req, res) => {
  const db = getDB();
  const { note } = req.body;
  const row = db.prepare('SELECT id FROM panel_orders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'درخواست پیدا نشد' });
  db.prepare("UPDATE panel_orders SET status='rejected', admin_note=? WHERE id=?").run(note || '', row.id);
  res.json({ success: true });
});

// ── پلن‌ها ──────────────────────────────────────────────────────
// بسته‌هایی که پنلِ نمایندگی با آن‌ها فروخته می‌شود. قبلاً در bot.js هاردکد
// بودند؛ حالا ادمین از همین‌جا (و از ربات) می‌سازد و ویرایش می‌کند.

// اعتبارسنجی — هر ورودیِ نامعتبر باید همین‌جا رد شود، نه در DB
function validatePlan(b, { requireKey }) {
  const out = {};
  if (requireKey) {
    out.key = String(b.key || '').trim();
    if (!/^[a-z0-9_-]{2,32}$/.test(out.key)) return { error: 'شناسه فقط حروف کوچک انگلیسی، عدد، _ و - (۲ تا ۳۲ کاراکتر)' };
  }
  out.name = String(b.name || '').trim();
  if (!out.name) return { error: 'نام پلن الزامی است' };
  out.description = String(b.description || '').trim();
  const nums = {
    price: 'قیمت', traffic_gb: 'حجم', max_clients: 'سقف کاربر',
    duration_days: 'مدت', price_per_gb: 'نرخ هر گیگ', initial_balance: 'شارژ اولیه',
  };
  for (const [k, fa] of Object.entries(nums)) {
    const v = Number(b[k] === '' || b[k] == null ? 0 : b[k]);
    if (!Number.isFinite(v) || v < 0) return { error: `${fa} باید عددِ مثبت باشد` };
    out[k] = v;
  }
  out.billing = b.billing === 'monthly' ? 'monthly' : 'once';
  // پلنِ ماهانه بدونِ مدت بی‌معنی است: صورتحسابِ دوره‌ای نیاز به دوره دارد
  if (out.billing === 'monthly' && out.duration_days <= 0) out.duration_days = 30;
  out.is_active = b.is_active ? 1 : 0;
  out.resellable = b.resellable ? 1 : 0;
  out.sort_order = Number(b.sort_order) || 0;
  return { value: out };
}

router.get('/plans', adminAuth, (req, res) => {
  res.json({ success: true, data: require('../models/plans').allPlans() });
});

router.post('/plans', adminAuth, (req, res) => {
  const db = getDB();
  const { value: p, error } = validatePlan(req.body, { requireKey: true });
  if (error) return res.status(400).json({ success: false, message: error });
  if (db.prepare('SELECT id FROM plans WHERE key=?').get(p.key)) {
    return res.status(400).json({ success: false, message: 'این شناسه قبلاً استفاده شده' });
  }
  const r = db.prepare(`INSERT INTO plans
    (key,name,description,price,traffic_gb,max_clients,duration_days,billing,price_per_gb,initial_balance,is_active,resellable,sort_order)
    VALUES (@key,@name,@description,@price,@traffic_gb,@max_clients,@duration_days,@billing,@price_per_gb,@initial_balance,@is_active,@resellable,@sort_order)`).run(p);
  res.json({ success: true, id: r.lastInsertRowid, message: 'پلن ساخته شد' });
});

router.put('/plans/:id', adminAuth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM plans WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'پلن پیدا نشد' });
  // key عوض نمی‌شود: panel_orders و purchase_requests با همین به پلن اشاره می‌کنند
  const { value: p, error } = validatePlan(req.body, { requireKey: false });
  if (error) return res.status(400).json({ success: false, message: error });
  db.prepare(`UPDATE plans SET name=@name, description=@description, price=@price, traffic_gb=@traffic_gb,
    max_clients=@max_clients, duration_days=@duration_days, billing=@billing, price_per_gb=@price_per_gb,
    initial_balance=@initial_balance, is_active=@is_active, resellable=@resellable,
    sort_order=@sort_order WHERE id=@id`).run({ ...p, id: row.id });
  res.json({ success: true, message: 'پلن ذخیره شد' });
});

router.delete('/plans/:id', adminAuth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM plans WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'پلن پیدا نشد' });
  // درخواست‌های در انتظار به این پلن اشاره می‌کنند؛ حذفش تأییدشان را می‌شکند
  const pending = db.prepare("SELECT COUNT(*) c FROM panel_orders WHERE plan_key=? AND status='pending'").get(row.key).c
                + db.prepare("SELECT COUNT(*) c FROM purchase_requests WHERE plan_key=? AND status='pending'").get(row.key).c;
  if (pending > 0) {
    return res.status(400).json({ success: false, message: `${pending} درخواستِ در انتظار به این پلن وصل است — اول آن‌ها را تعیین تکلیف کن یا پلن را غیرفعال کن` });
  }
  db.prepare('DELETE FROM plans WHERE id=?').run(row.id);
  res.json({ success: true, message: 'پلن حذف شد' });
});

// ─── بک‌آپ و بازیابی (فقط امیر پنل: x-ui.db + reseller.db + سورس) ───
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// بک‌آپِ فوری: اجرای اسکریپت و ارسال به کانالِ تلگرام
router.post('/backup/now', adminAuth, (req, res) => {
  exec('/usr/local/bin/amirpanel-backup.sh', { timeout: 200000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ success: false, message: 'بک‌آپ ناموفق بود', detail: String(stderr || err).slice(0, 500) });
    res.json({ success: true, message: 'بک‌آپ گرفته و به کانال ارسال شد', output: String(stdout || '').trim() });
  });
});

// بازیابی از فایلِ آپلودی (base64 از tar.gzِ بک‌آپ) — روی همین سرور یا سرورِ جدید
router.post('/backup/restore', adminAuth, (req, res) => {
  const b64 = req.body && req.body.file;
  if (!b64 || typeof b64 !== 'string') return res.status(400).json({ success: false, message: 'فایلِ بک‌آپ ارسال نشد' });
  try {
    const buf = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length < 100) return res.status(400).json({ success: false, message: 'فایل نامعتبر یا خالی' });
    const tmp = path.join(os.tmpdir(), 'amirpanel-restore-' + Date.now() + '.tar.gz');
    fs.writeFileSync(tmp, buf);
    exec('/usr/local/bin/amirpanel-restore.sh ' + tmp, { timeout: 200000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch {}
      if (err) return res.status(500).json({ success: false, message: 'بازیابی ناموفق بود', detail: String(stderr || err).slice(0, 800) });
      res.json({ success: true, message: 'بازیابی انجام شد؛ سرویس‌ها ری‌استارت شدند', output: String(stdout || '').trim() });
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'خطا در پردازشِ فایل: ' + e.message });
  }
});

// کانالِ بک‌آپ (در /etc/amirpanel-backup.env؛ بات باید ادمینِ کانال باشد)
const BK_ENV = '/etc/amirpanel-backup.env';
router.get('/backup/channel', adminAuth, (req, res) => {
  let ch = '';
  try { const m = fs.readFileSync(BK_ENV, 'utf8').match(/^BACKUP_CHANNEL=(.*)$/m); ch = m ? m[1].trim() : ''; } catch (e) {}
  res.json({ success: true, channel: ch });
});
router.post('/backup/channel', adminAuth, (req, res) => {
  const ch = String((req.body && req.body.channel) || '').trim();
  try {
    let cur = ''; try { cur = fs.readFileSync(BK_ENV, 'utf8'); } catch (e) {}
    if (/^BACKUP_CHANNEL=/m.test(cur)) cur = cur.replace(/^BACKUP_CHANNEL=.*$/m, 'BACKUP_CHANNEL=' + ch);
    else cur += (!cur || cur.endsWith('\n') ? '' : '\n') + 'BACKUP_CHANNEL=' + ch + '\n';
    fs.writeFileSync(BK_ENV, cur);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: 'خطا در ذخیره: ' + e.message }); }
});

// ─── سرورها (چند-کشوره) ───────────────────────────────────────
const crypto = require('crypto');

router.get('/servers', adminAuth, (req, res) => {
  const rows = getDB().prepare('SELECT * FROM servers ORDER BY sort_order, id').all();
  res.json({ success: true, data: rows });
});

router.post('/servers', adminAuth, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.xui_url || !b.xui_api_key)
    return res.status(400).json({ success: false, message: 'نام، آدرسِ 3x-ui و کلیدِ API لازم است' });
  const tok = crypto.randomBytes(16).toString('hex');
  const info = getDB().prepare(`INSERT INTO servers
    (name,flag,xui_url,xui_path,xui_api_key,domains,clean_ips,tunnel_path,inbound_ids,network,scan_token,active,sort_order)
    VALUES (@name,@flag,@xui_url,@xui_path,@xui_api_key,@domains,@clean_ips,@tunnel_path,@inbound_ids,@network,@scan_token,1,@sort_order)`).run({
    name: b.name, flag: b.flag || '', xui_url: b.xui_url, xui_path: b.xui_path || '', xui_api_key: b.xui_api_key,
    domains: b.domains || '', clean_ips: b.clean_ips || '', tunnel_path: b.tunnel_path || '/fml9vgwfwc',
    inbound_ids: b.inbound_ids || '', network: (b.network === 'ws' ? 'ws' : 'xhttp'), scan_token: tok, sort_order: Number(b.sort_order) || 0,
  });
  res.json({ success: true, id: info.lastInsertRowid });
});

router.put('/servers/:id', adminAuth, (req, res) => {
  const db = getDB(); const b = req.body || {};
  const row = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: 'سرور پیدا نشد' });
  const g = (k) => (b[k] == null ? row[k] : b[k]);
  db.prepare(`UPDATE servers SET name=@name,flag=@flag,xui_url=@xui_url,xui_path=@xui_path,xui_api_key=@xui_api_key,
    domains=@domains,clean_ips=@clean_ips,tunnel_path=@tunnel_path,inbound_ids=@inbound_ids,network=@network,active=@active,sort_order=@sort_order WHERE id=@id`).run({
    id: row.id, name: g('name'), flag: g('flag'), xui_url: g('xui_url'), xui_path: g('xui_path'),
    xui_api_key: g('xui_api_key'), domains: g('domains'), clean_ips: g('clean_ips'), tunnel_path: g('tunnel_path'),
    inbound_ids: g('inbound_ids'), network: (g('network') === 'ws' ? 'ws' : 'xhttp'),
    active: (b.active == null ? row.active : (b.active ? 1 : 0)), sort_order: (b.sort_order == null ? row.sort_order : Number(b.sort_order)),
  });
  res.json({ success: true });
});

router.delete('/servers/:id', adminAuth, (req, res) => {
  getDB().prepare('DELETE FROM servers WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// دانلودِ اسکنرِ IP تمیزِ آمادهٔ همین سرور (ادمین از دستگاهِ ایرانیِ خودش اجرا می‌کند)
router.get('/servers/:id/scanner', adminAuth, (req, res) => {
  const row = getDB().prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).send('not found');
  const panelBase = (process.env.SUB_BASE_URL || 'https://panelsub.irsna.top/sub').replace(/\/sub.*$/, '');
  const nDomains = String(row.domains || '').split(',').filter(Boolean).length || 3;
  const applyUrl = panelBase + '/sub/apply-cleanip';
  const os = String(req.query.os || 'unix').toLowerCase();

  // اسکنر بسته به نوعِ سرور:
  //  xhttp (Cloudflare) → رنجِ CF + speed.cloudflare.com
  //  ws (آروان/CDN داخلی) → رنجِ آروان (185.143.232-235) + تستِ خودِ دامنه (endpoint 200)
  const isWs = (row.network || 'xhttp') === 'ws';
  const firstDom = (String(row.domains || '').split(',').map((s) => s.trim()).filter(Boolean)[0]) || '';
  const scHost = isWs && firstDom ? firstDom : 'speed.cloudflare.com';
  const scUrl = isWs && firstDom ? `https://${firstDom}/sub/voice-status` : 'https://speed.cloudflare.com/__down?bytes=3000000';
  const candU = isWs
    ? 'for o in 232 233 234 235; do for k in $(seq 1 20); do echo "185.143.$o.$((RANDOM%254+1))"; done; done'
    : 'for o in 16 17 18 19 20 21 22 24 25 26 27 28; do echo "104.$o.$((RANDOM%254+1)).$((RANDOM%254+1))"; done; for o in 96 97 98 99; do echo "188.114.$o.$((RANDOM%254+1))"; done';
  const candW = isWs
    ? 'foreach($o in 232,233,234,235){ 1..20 | %{ $cands+="185.143.$o.$(Get-Random -Max 254)" } }'
    : 'foreach($o in 16,17,18,19,20,21,22,24,25,26,27,28){$cands+="104.$o.$(Get-Random -Max 254).$(Get-Random -Max 254)"}; foreach($o in 96,97,98,99){$cands+="188.114.$o.$(Get-Random -Max 254)"}';

  // ── نسخهٔ ویندوز (PowerShell؛ از curl.exe داخلیِ Win10+ استفاده می‌کند) ──
  if (os === 'win') {
    const ps = `# AMIR PANEL - Clean IP Scanner - ${row.name}  (Windows / PowerShell)
$ErrorActionPreference='SilentlyContinue'
$SID=${row.id}; $TOKEN='${row.scan_token}'; $APPLY='${applyUrl}'; $TOPN=${nDomains}
Write-Host ''
Write-Host '  +======================================+' -ForegroundColor Magenta
Write-Host '  |          A M I R   P A N E L         |' -ForegroundColor Magenta
Write-Host '  |          Clean-IP Scanner            |' -ForegroundColor Magenta
Write-Host '  +======================================+' -ForegroundColor Magenta
Write-Host '  Country: ${row.name}' -ForegroundColor DarkGray
$geo = (curl.exe -s --max-time 10 https://api.ip.sb/geoip) | ConvertFrom-Json
if ($geo.country_code -ne 'IR') { Write-Host ('  [X] VPN is ON ('+$geo.country_code+'). Turn it OFF and rerun.') -ForegroundColor Red; Read-Host 'Enter'; exit }
Write-Host '  [OK] Connected from Iran' -ForegroundColor Green
$cands=@(); ${candW}
$res=@()
foreach($ip in $cands){
  $r = curl.exe -s -o NUL --resolve "${scHost}:443:$ip" -w '%{speed_download}|%{http_code}' --max-time 8 "${scUrl}"
  $p=$r -split '\\|'; $sp=[int]($p[0] -replace '\\..*',''); $code=$p[1]
  if($code -eq '200' -and $sp -gt 0){ $m=[math]::Round($sp*8/1000000,1); Write-Host ("  {0,-18} {1} Mbps" -f $ip,$m) -ForegroundColor Cyan; $res+=[pscustomobject]@{ip=$ip;sp=$sp} }
  else { Write-Host "  $ip  x" -ForegroundColor DarkGray }
}
$best=(($res | Sort-Object sp -Descending | Select-Object -First $TOPN).ip) -join ','
if(-not $best){ Write-Host '  [X] No clean IP found' -ForegroundColor Red; Read-Host 'Enter'; exit }
Write-Host "  Best: $best" -ForegroundColor Green
$body = (@{server_id=$SID;token=$TOKEN;ips=$best} | ConvertTo-Json -Compress)
$out = curl.exe -s --max-time 20 -X POST $APPLY -H 'Content-Type: application/json' -d $body
if($out -match '"success":true'){ Write-Host '  [OK] Applied - tell users to refresh sub' -ForegroundColor Green } else { Write-Host "  [X] Failed: $out" -ForegroundColor Red }
Read-Host 'Press Enter to close'
`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="AmirPanel-Scanner-${row.id}.ps1"`);
    return res.send(ps);
  }

  // ── نسخهٔ Mac/Linux (bash با برندِ Amir Panel و رنگ) ──
  const script = `#!/usr/bin/env bash
# AMIR PANEL - Clean IP Scanner - ${row.name}
set -uo pipefail
G='\\033[1;92m'; C='\\033[1;96m'; R='\\033[1;91m'; M='\\033[1;95m'; D='\\033[0;90m'; N='\\033[0m'
SERVER_ID=${row.id}; TOKEN="${row.scan_token}"; APPLY_URL="${applyUrl}"; TOP_N=${nDomains}
clear 2>/dev/null || true
echo -e "\${M}  ╔══════════════════════════════════════╗"
echo -e "  ║          A M I R   P A N E L         ║"
echo -e "  ║          Clean-IP Scanner            ║"
echo -e "  ╚══════════════════════════════════════╝\${N}"
echo -e "\${D}  کشور: ${row.name}\${N}\\n"
echo -e "\${D}▸ بررسی موقعیت…\${N}"
CC=$(curl -s --max-time 10 https://api.ip.sb/geoip 2>/dev/null | sed -n 's/.*"country_code":"\\([^"]*\\)".*/\\1/p')
if [ "$CC" != "IR" ]; then echo -e "\${R}✗ VPN روشن است ($CC). خاموش کن و دوباره بزن.\${N}"; read -rp "Enter…" _; exit 1; fi
echo -e "\${G}✓ از ایران وصلی\${N}\\n"
CANDIDATES=$( { ${candU}; } | sort -u)
RESULTS=""
while read -r ip; do [ -z "$ip" ] && continue
  r=$(curl -so /dev/null --resolve "${scHost}:443:$ip" -w '%{speed_download}|%{http_code}' --max-time 8 "${scUrl}" 2>/dev/null)
  sp=$(echo "$r"|cut -d'|' -f1|cut -d'.' -f1); code=$(echo "$r"|cut -d'|' -f2); [ -z "$sp" ]&&sp=0
  if [ "$code" = "200" ]&&[ "$sp" -gt 0 ]; then printf "  \${C}%-18s %s Mbps\${N}\\n" "$ip" "$(awk -v s=$sp 'BEGIN{printf "%.1f",s*8/1000000}')"; RESULTS="$RESULTS$sp $ip\\n"; else echo -e "  \${D}$ip ✗\${N}"; fi
done <<< "$CANDIDATES"
BEST=$(echo -e "$RESULTS"|grep -v '^$'|sort -rn|head -$TOP_N|awk '{print $2}'|paste -sd, -)
[ -z "$BEST" ] && { echo -e "\${R}✗ IP سالمی پیدا نشد\${N}"; read -rp "Enter…" _; exit 1; }
echo -e "\\n\${G}▸ بهترین‌ها: $BEST\${N}"
echo -e "\${D}▸ ارسال به Amir Panel…\${N}"
OUT=$(curl -s --max-time 20 -X POST "$APPLY_URL" -H 'Content-Type: application/json' -d "{\\"server_id\\":$SERVER_ID,\\"token\\":\\"$TOKEN\\",\\"ips\\":\\"$BEST\\"}")
echo "$OUT" | grep -q '"success":true' && echo -e "\${G}✅ اعمال شد — کاربران ساب را رفرش کنند\${N}" || echo -e "\${R}✗ اعمال نشد: $OUT\${N}"
read -rp "برای بستن Enter بزن…" _
`;
  res.setHeader('Content-Type', 'application/x-sh');
  res.setHeader('Content-Disposition', `attachment; filename="AmirPanel-Scanner-${row.id}.command"`);
  res.send(script);
});

// ─── بررسیِ نسخه و آپدیت ───────────────────────────────────────
// پنل نسخهٔ محلی (package.json) را با آخرین نسخهٔ ریپو مقایسه می‌کند و اگر
// جدیدتری بود، فرانت بنرِ «آپدیت موجود است» نشان می‌دهد. آپدیتِ واقعی با
// اجرای `bash scripts/update.sh` روی سرور انجام می‌شود (وب هرگز خودش git/pm2
// را root اجرا نمی‌کند — امنیت).
const _path = require('path');
let _verCache = { at: 0, latest: null };
const LOCAL_VERSION = (() => {
  try { return require(_path.join(__dirname, '..', '..', 'package.json')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
function _cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}
function _fetchLatest() {
  return new Promise((resolve) => {
    try {
      const https = require('https');
      const url = 'https://raw.githubusercontent.com/amirgraph/xui-reseller/main/app/package.json';
      const req = https.get(url, { timeout: 6000, headers: { 'User-Agent': 'amirpanel' } }, (r) => {
        let d = ''; r.on('data', (c) => (d += c));
        r.on('end', () => { try { resolve(JSON.parse(d).version || null); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}
router.get('/version', adminAuth, async (req, res) => {
  let latest = _verCache.latest;
  if (!latest || Date.now() - _verCache.at > 3600e3) {
    const fresh = await _fetchLatest();
    if (fresh) { latest = fresh; _verCache = { at: Date.now(), latest: fresh }; }
  }
  const current = LOCAL_VERSION;
  const updateAvailable = !!(latest && _cmpVer(latest, current) > 0);
  res.json({ success: true, data: { current, latest: latest || current, updateAvailable } });
});

module.exports = router;
