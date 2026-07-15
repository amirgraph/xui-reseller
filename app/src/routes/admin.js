const express = require('express');
const bcrypt = require('bcryptjs');
const { getDB } = require('../models/database');
const { adminAuth } = require('../middleware/auth');
const xui = require('../services/xuiService');
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
           created_at, expires_at
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
    brand_bg_color = '#0a0a0f', expires_at = null
  } = req.body;

  try {
    if (db.prepare('SELECT id FROM resellers WHERE username = ?').get(username)) {
      return res.status(400).json({ success: false, message: 'Username already exists' });
    }
    const hashed = bcrypt.hashSync(password, 10);
    const result = db.prepare(`
      INSERT INTO resellers (
        username, password, name, email, telegram_id,
        traffic_limit_gb, max_clients, allowed_inbounds,
        price_per_gb, brand_name, brand_color, brand_bg_color, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      username, hashed, name, email || null, telegram_id || null,
      traffic_limit_gb, max_clients, JSON.stringify(allowed_inbounds),
      price_per_gb, brand_name, brand_color, brand_bg_color, expires_at
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
    brand_bg_color, is_active, balance, expires_at, password
  } = req.body;

  try {
    let query = `UPDATE resellers SET 
      name=?, email=?, telegram_id=?, traffic_limit_gb=?, max_clients=?,
      allowed_inbounds=?, price_per_gb=?, brand_name=?, brand_color=?,
      brand_bg_color=?, is_active=?, expires_at=?`;
    let params = [
      name, email, telegram_id, traffic_limit_gb, max_clients,
      JSON.stringify(allowed_inbounds || []), price_per_gb, brand_name,
      brand_color, brand_bg_color, is_active ? 1 : 0, expires_at
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

router.put('/settings', adminAuth, (req, res) => {
  const db = getDB();
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ success: false, message: 'key required' });
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  res.json({ success: true });
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
    (key,name,description,price,traffic_gb,max_clients,duration_days,billing,price_per_gb,initial_balance,is_active,sort_order)
    VALUES (@key,@name,@description,@price,@traffic_gb,@max_clients,@duration_days,@billing,@price_per_gb,@initial_balance,@is_active,@sort_order)`).run(p);
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
    initial_balance=@initial_balance, is_active=@is_active, sort_order=@sort_order WHERE id=@id`).run({ ...p, id: row.id });
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

module.exports = router;
