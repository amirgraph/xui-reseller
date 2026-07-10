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
  const s = key => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r ? r.value : null; };
  const trafficGb = parseFloat(s('panel_traffic_gb') || '145');
  const pricePerGb = parseFloat(s('panel_price_per_gb') || '3500');
  const maxClients = parseInt(s('panel_max_clients') || '50');
  const result = db.prepare(`
    INSERT INTO resellers (username, password, name, telegram_id, traffic_limit_gb, max_clients, price_per_gb, plain_password, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(row.username, row.password_hash, row.full_name, row.telegram_id, trafficGb, maxClients, pricePerGb, row.plain_password);
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


module.exports = router;
