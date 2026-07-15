const { notifyAdmin } = require('../lib/notify');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../models/database');
const { resellerAuth } = require('../middleware/auth');
const xui = require('../services/xuiService');
const { returnTrafficToReseller } = require('../services/syncService');

const router = express.Router();

// ─── Profile ─────────────────────────────────────────────────

router.get('/profile', resellerAuth, (req, res) => {
  const db = getDB();
  const reseller = db.prepare(`
    SELECT id, username, name, email, telegram_id, balance,
           traffic_limit_gb, traffic_used_gb, max_clients, current_clients,
           allowed_inbounds, price_per_gb, brand_name, brand_logo, brand_color, brand_bg_color,
           sub_domain, is_active, created_at, expires_at,
           telegram_support, brand_motion,
           can_create_panels, discount_percent, parent_id
    FROM resellers WHERE id = ?
  `).get(req.user.id);
  res.json({ success: true, data: reseller });
});

// Update brand settings
router.put('/brand', resellerAuth, (req, res) => {
  const db = getDB();
  const { brand_name, brand_color, brand_bg_color, brand_logo, telegram_support, brand_motion } = req.body;
  db.prepare(`UPDATE resellers SET brand_name=?, brand_color=?, brand_bg_color=?, brand_logo=?, telegram_support=?, brand_motion=? WHERE id=?`).run(brand_name, brand_color, brand_bg_color, brand_logo||'', telegram_support||'', brand_motion||'hearts', req.user.id);
  res.json({ success: true });
});

// ─── Inbounds (allowed) ───────────────────────────────────────

router.get('/inbounds', resellerAuth, (req, res) => {
  const db = getDB();
  const reseller = db.prepare('SELECT allowed_inbounds FROM resellers WHERE id=?').get(req.user.id);
  const allowed = JSON.parse(reseller.allowed_inbounds || '[]');
  
  const inbounds = db.prepare('SELECT * FROM inbounds_cache').all().map(ib => ({
    ...ib,
    data: JSON.parse(ib.data || '{}')
  }));

  const filtered = allowed.length > 0
    ? inbounds.filter(ib => allowed.includes(ib.id))
    : inbounds;

  res.json({ success: true, data: filtered });
});

// ─── Clients ─────────────────────────────────────────────────

router.get('/clients', resellerAuth, (req, res) => {
  const db = getDB();
  const clients = db.prepare(`
    SELECT * FROM clients WHERE reseller_id = ? ORDER BY created_at DESC
  `).all(req.user.id);
  res.json({ success: true, data: clients });
});

// Create client
router.post('/clients', resellerAuth, async (req, res) => {
  const db = getDB();
  const reseller = req.reseller;
  const {
    username, email, inbound_id, inbound_ids,
    traffic_limit_gb = 10, ip_limit = 1,
    expires_at = null, telegram_id = null
  } = req.body;

  // Checks — ۰ یعنی «بی‌نهایت»، نه «هیچ». قبلاً نمایندهٔ ساخته‌شده از ربات
  // max_clients=0 می‌گرفت و 0>=0 درست بود، پس پنلش از لحظهٔ اول قفل می‌شد.
  if (reseller.max_clients > 0 && reseller.current_clients >= reseller.max_clients) {
    return res.status(400).json({ success: false, message: 'Client limit reached' });
  }
  // === هزینه: نامحدود = تعداد ماه × نرخِ ماهانه | حجمی = GB × نرخِ نماینده ===
  // نرخِ نامحدود از settings می‌آید (نصب‌کننده می‌پرسد و ادمین از پنل عوضش می‌کند).
  // قبلاً ۱۸۰٬۰۰۰ هاردکد بود و مقدارِ واقعیِ settings را نادیده می‌گرفت.
  const isUnlimited = Number(traffic_limit_gb) === 0;
  const UNLIMITED_MONTHLY = require('../models/plans').unlimitedMonthly();
  let cost = 0;
  if (isUnlimited) {
    if (!expires_at) {
      return res.status(400).json({ success: false, message: 'برای کاربر نامحدود باید تاریخ انقضا (تعداد ماه) انتخاب کنید.' });
    }
    const days = Math.max(1, Math.round((new Date(expires_at).getTime() - Date.now()) / 86400000));
    const months = Math.max(1, Math.round(days / 30));
    cost = months * UNLIMITED_MONTHLY;
  } else {
    // traffic_limit_gb=0 روی نماینده یعنی سهمیهٔ نامحدود؛ آن‌وقت چیزی که او را
    // محدود می‌کند موجودیِ کیف پول است (مدلِ balance). وگرنه سهمیه چک می‌شود.
    if (reseller.traffic_limit_gb > 0) {
      const trafficAvailable = reseller.traffic_limit_gb - reseller.traffic_used_gb;
      if (traffic_limit_gb > trafficAvailable) {
        return res.status(400).json({ success: false, message: `Not enough traffic. Available: ${trafficAvailable.toFixed(2)} GB` });
      }
    }
    if (reseller.price_per_gb > 0) cost = Number(traffic_limit_gb) * reseller.price_per_gb;
  }
  if (cost > 0 && reseller.balance < cost) {
    return res.status(400).json({ success: false, message: `موجودی کافی نیست. موجودی: ${reseller.balance.toLocaleString()} ت — هزینه: ${cost.toLocaleString()} ت` });
  }

  // اگه inbound_ids آمد → از اونا، وگرنه → همه اینباندها
  const inboundList = await xui.getInbounds();
  const allInboundIds = inboundList.map(ib => ib.id);
  const selectedInbounds = (inbound_ids && Array.isArray(inbound_ids) && inbound_ids.length > 0)
    ? inbound_ids.map(Number).filter(id => allInboundIds.includes(id))
    : allInboundIds;
  if (!selectedInbounds.length) {
    return res.status(500).json({ success: false, message: 'هیچ اینباند فعالی در 3X-UI وجود ندارد' });
  }

  const uuid = uuidv4();
  const clientEmail = `${reseller.username}_${username}`.toLowerCase().replace(/\s/g, '_');
  const expiryTime = expires_at ? new Date(expires_at).getTime() : 0;
  const trafficBytes = Math.round(traffic_limit_gb * 1024 ** 3);
  const primaryInbound = selectedInbounds[0];

  try {
    // اضافه کردن به همه اینباندهای انتخابی در 3X-UI
    const result = await xui.addClient(selectedInbounds, {
      id: uuid,
      email: clientEmail,
      enable: true,
      totalGB: trafficBytes,
      expiryTime: expiryTime,
      limitIp: ip_limit,
      flow: 'xtls-rprx-vision',
      tgId: telegram_id ? parseInt(telegram_id) : 0,
      subId: uuid.replace(/-/g, '').substring(0, 16),
    });

    if (!result?.success) {
      return res.status(500).json({ success: false, message: '3X-UI error: ' + JSON.stringify(result) });
    }

    // Save to DB
    db.prepare(`
      INSERT INTO clients (reseller_id, xui_uuid, xui_inbound_id, username, email,
        telegram_id, traffic_limit_gb, ip_limit, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(reseller.id, uuid, primaryInbound, username, clientEmail,
      telegram_id, traffic_limit_gb, ip_limit, expires_at);

    // Update reseller counts
    db.prepare(`
      UPDATE resellers SET current_clients = current_clients + 1 WHERE id = ?
    `).run(reseller.id);

    // کسر از موجودی (نامحدود یا حجمی) — یک‌بار، بدون تمدید خودکار
    if (cost > 0) {
      db.prepare('UPDATE resellers SET balance = balance - ? WHERE id = ?').run(cost, reseller.id);
      const desc = isUnlimited ? `Created UNLIMITED client: ${username} (${cost.toLocaleString()}t)` : `Created client: ${username} (${traffic_limit_gb}GB)`;
      db.prepare(`
        INSERT INTO transactions (reseller_id, type, amount, description)
        VALUES (?, 'debit', ?, ?)
      `).run(reseller.id, cost, desc);
    }

    res.json({ success: true, uuid, email: clientEmail });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Toggle client (enable/disable)
router.post('/clients/:id/toggle', resellerAuth, async (req, res) => {
  const db = getDB();
  const client = db.prepare('SELECT * FROM clients WHERE id=? AND reseller_id=?')
    .get(req.params.id, req.user.id);
  if (!client) return res.status(404).json({ success: false, message: 'Not found' });

  const newState = !client.is_active;
  try {
    await xui.toggleClient(client.xui_inbound_id, client.xui_uuid, newState, client.email);
  } catch (e) {
    // اگه در 3X-UI وجود نداشت، فقط DB رو آپدیت کن
  }
  db.prepare('UPDATE clients SET is_active=? WHERE id=?').run(newState ? 1 : 0, client.id);
  res.json({ success: true, is_active: newState });
});

// Delete client (returns unused traffic)
router.delete('/clients/:id', resellerAuth, async (req, res) => {
  const db = getDB();
  const client = db.prepare('SELECT * FROM clients WHERE id=? AND reseller_id=?')
    .get(req.params.id, req.user.id);
  if (!client) return res.status(404).json({ success: false, message: 'Not found' });

  // کاربر نامحدود را نماینده نمی‌تواند حذف کند — فقط ادمین اصلی
  if (Number(client.traffic_limit_gb) === 0) {
    return res.status(403).json({ success: false, message: 'کاربر نامحدود قابل حذف توسط نماینده نیست؛ پس از پایان زمان خودکار منقضی می‌شود. برای حذف با ادمین تماس بگیرید.' });
  }

  try {
    await xui.deleteClient(client.xui_inbound_id, client.xui_uuid, client.email);
  } catch (e) {
    // اگه در 3X-UI وجود نداشت، ادامه بده و از DB حذف کن
  }
  db.prepare('DELETE FROM clients WHERE id=?').run(client.id);
  const refundedGb = returnTrafficToReseller(req.user.id, client.traffic_used_gb, client.traffic_limit_gb);
  db.prepare('UPDATE resellers SET current_clients = current_clients - 1 WHERE id = ?').run(req.user.id);

  // برگشت موجودی برای حجم استفاده‌نشده
  const resellerInfo = db.prepare('SELECT price_per_gb FROM resellers WHERE id=?').get(req.user.id);
  if (resellerInfo && resellerInfo.price_per_gb > 0 && refundedGb > 0) {
    const refundAmount = refundedGb * resellerInfo.price_per_gb;
    db.prepare('UPDATE resellers SET balance = balance + ? WHERE id = ?').run(refundAmount, req.user.id);
    db.prepare("INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, 'credit', ?, ?)")
      .run(req.user.id, refundAmount, 'بازگشت حجم: ' + client.username + ' (' + refundedGb.toFixed(2) + 'GB)');
  }

  res.json({ success: true, refunded_gb: refundedGb });
});

// Update client (traffic, ip_limit, expiry)
router.put('/clients/:id', resellerAuth, async (req, res) => {
  const db = getDB();
  const client = db.prepare('SELECT * FROM clients WHERE id=? AND reseller_id=?')
    .get(req.params.id, req.user.id);
  if (!client) return res.status(404).json({ success: false, message: 'Not found' });

  const { traffic_limit_gb, ip_limit, expires_at } = req.body;
  const reseller = req.reseller;

  try {
    const expiryTime = expires_at ? new Date(expires_at).getTime() : 0;
    const trafficBytes = Math.round((traffic_limit_gb || client.traffic_limit_gb) * 1024 ** 3);

    try {
      await xui.updateClient(client.xui_inbound_id, client.xui_uuid, {
        id: client.xui_uuid,
        email: client.email,
        enable: !!client.is_active,
        totalGB: trafficBytes,
        expiryTime,
        limitIp: ip_limit || client.ip_limit,
        flow: 'xtls-rprx-vision',
      });
    } catch (e) {
      // اگه در 3X-UI وجود نداشت، فقط DB رو آپدیت کن
    }

    const newGb = traffic_limit_gb || client.traffic_limit_gb;
    const diff = newGb - client.traffic_limit_gb;
    if(diff !== 0 && reseller.price_per_gb > 0) {
      const costDiff = diff * reseller.price_per_gb;
      db.prepare('UPDATE resellers SET balance = balance - ? WHERE id = ?').run(costDiff, reseller.id);
      db.prepare("INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, ?, ?, ?)").run(reseller.id, diff > 0 ? 'debit' : 'credit', Math.abs(costDiff), 'Edit client: ' + client.username + ' (' + (diff > 0 ? '+' : '') + diff + 'GB)');
    }
    db.prepare("UPDATE clients SET traffic_limit_gb=?, ip_limit=?, expires_at=? WHERE id=?").run(
      newGb, ip_limit !== undefined ? ip_limit : client.ip_limit,
      expires_at !== undefined ? expires_at : client.expires_at, client.id
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Transactions ────────────────────────────────────────────

router.get('/transactions', resellerAuth, (req, res) => {
  const db = getDB();
  const txns = db.prepare(`
    SELECT * FROM transactions WHERE reseller_id=? ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json({ success: true, data: txns });
});

// ─── Stats ───────────────────────────────────────────────────

router.get('/stats', resellerAuth, (req, res) => {
  const db = getDB();
  const reseller = db.prepare('SELECT * FROM resellers WHERE id=?').get(req.user.id);
  const activeClients = db.prepare('SELECT COUNT(*) as c FROM clients WHERE reseller_id=? AND is_active=1').get(req.user.id).c;
  const totalClients = db.prepare('SELECT COUNT(*) as c FROM clients WHERE reseller_id=?').get(req.user.id).c;
  const expiringSoon = db.prepare(`
    SELECT COUNT(*) as c FROM clients 
    WHERE reseller_id=? AND expires_at BETWEEN CURRENT_TIMESTAMP AND datetime('now', '+3 days')
  `).get(req.user.id).c;

  res.json({
    success: true,
    data: {
      balance: reseller.balance,
      traffic_limit_gb: reseller.traffic_limit_gb,
      traffic_used_gb: reseller.traffic_used_gb,
      traffic_remaining_gb: Math.max(0, reseller.traffic_limit_gb - reseller.traffic_used_gb),
      max_clients: reseller.max_clients,
      current_clients: reseller.current_clients,
      active_clients: activeClients,
      total_clients: totalClients,
      online_clients: 0,
      expiring_soon: expiringSoon,
    }
  });
});


// ─── Charge Requests ─────────────────────────────────────────

router.get('/charge/settings', resellerAuth, (req, res) => {
  const db = getDB();
  const cardNumber = db.prepare("SELECT value FROM settings WHERE key='charge_card_number'").get();
  const cardOwner = db.prepare("SELECT value FROM settings WHERE key='charge_card_owner'").get();
  const amounts = db.prepare("SELECT value FROM settings WHERE key='charge_amounts'").get();
  res.json({
    success: true,
    data: {
      card_number: cardNumber ? cardNumber.value : '',
      card_owner: cardOwner ? cardOwner.value : '',
      amounts: amounts ? amounts.value.split(',').map(Number) : [100000,200000,500000,1000000],
    }
  });
});

router.post('/charge/request', resellerAuth, (req, res) => {
  const db = getDB();
  const { amount, card_receipt } = req.body;
  if (!amount || amount < 10000) return res.status(400).json({ success: false, message: 'مبلغ نامعتبر' });
  try {
    const result = db.prepare(
      'INSERT INTO charge_requests (reseller_id, amount, card_receipt) VALUES (?, ?, ?)'
    ).run(req.user.id, parseInt(amount), card_receipt || null);
    const rsInfo = db.prepare('SELECT username, brand_name FROM resellers WHERE id=?').get(req.user.id);
    notifyAdmin(
      '<b>\u{1F4B0} \u062F\u0631\u062E\u0648\u0627\u0633\u062A \u0634\u0627\u0631\u0698 \u062C\u062F\u06CC\u062F</b>\n' +
      '\u{1F464} \u0646\u0645\u0627\u06CC\u0646\u062F\u0647: ' + (rsInfo ? rsInfo.username : String(req.user.id)) + '\n' +
      '\u{1F4B5} \u0645\u0628\u0644\u063A: ' + parseInt(amount).toLocaleString() + ' \u062A\u0648\u0645\u0627\u0646'
    );
    res.json({ success: true, id: result.lastInsertRowid, message: 'درخواست شارژ ثبت شد' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── زیرنمایندگی ──────────────────────────────────────────────
// نماینده می‌تواند خودش پنل بسازد و هزینه‌اش از موجودی‌اش کم می‌شود.
// چه پلن‌هایی: آن‌هایی که ادمین resellable زده. چه قیمتی: قیمتِ پلن منهای
// تخفیفِ شخصیِ خودش. چه کسی اجازه دارد: هر که ادمین can_create_panels داده.

// پلن‌هایی که این نماینده می‌تواند بفروشد، با قیمتِ خودش
router.get('/sellable-plans', resellerAuth, (req, res) => {
  const db = getDB();
  const me = db.prepare('SELECT * FROM resellers WHERE id=?').get(req.user.id);
  if (!me) return res.status(404).json({ success: false, message: 'نماینده پیدا نشد' });
  if (!me.can_create_panels) return res.json({ success: true, allowed: false, data: [] });
  const { sellablePlans, priceForReseller } = require('../models/plans');
  const data = sellablePlans().map(p => ({
    key: p.key, name: p.name, description: p.description,
    list_price: p.price, your_price: priceForReseller(p, me),
    traffic_gb: p.traffic_gb, max_clients: p.max_clients,
    duration_days: p.duration_days, billing: p.billing,
    price_per_gb: p.price_per_gb, initial_balance: p.initial_balance,
  }));
  res.json({ success: true, allowed: true, discount_percent: me.discount_percent || 0, balance: me.balance, data });
});

// پنل‌هایی که خودم ساخته‌ام
router.get('/panels', resellerAuth, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT id, username, name, telegram_id, balance, traffic_limit_gb, traffic_used_gb,
           max_clients, current_clients, is_active, expires_at, created_at
    FROM resellers WHERE parent_id=? ORDER BY created_at DESC
  `).all(req.user.id);
  res.json({ success: true, data: rows });
});

router.post('/panels', resellerAuth, (req, res) => {
  const db = getDB();
  const bcrypt = require('bcryptjs');
  const { planByKey, priceForReseller, resellerFieldsFromPlan } = require('../models/plans');
  const { plan_key, username, password, name, telegram_id } = req.body || {};

  const me = db.prepare('SELECT * FROM resellers WHERE id=?').get(req.user.id);
  if (!me) return res.status(404).json({ success: false, message: 'نماینده پیدا نشد' });
  if (!me.can_create_panels) return res.status(403).json({ success: false, message: 'اجازهٔ ساخت پنل نداری — از ادمین بخواه فعالش کند' });

  if (!/^[a-zA-Z0-9_]{4,32}$/.test(String(username || ''))) {
    return res.status(400).json({ success: false, message: 'نام کاربری: حروف انگلیسی، عدد و _ (۴ تا ۳۲ کاراکتر)' });
  }
  if (String(password || '').length < 6) return res.status(400).json({ success: false, message: 'رمز عبور حداقل ۶ کاراکتر' });
  if (!String(name || '').trim()) return res.status(400).json({ success: false, message: 'نام الزامی است' });
  if (db.prepare('SELECT id FROM resellers WHERE username=?').get(username)) {
    return res.status(400).json({ success: false, message: 'این نام کاربری قبلاً ثبت شده' });
  }

  const plan = planByKey(String(plan_key || ''));
  if (!plan || !plan.is_active) return res.status(400).json({ success: false, message: 'پلن پیدا نشد' });
  // فقط پلن‌هایی که ادمین اجازه داده — وگرنه نماینده می‌توانست plan_key
  // یک پلنِ غیرقابلِ فروش را دستی بفرستد.
  if (!plan.resellable) return res.status(403).json({ success: false, message: 'این پلن قابلِ فروش توسط نماینده نیست' });

  const cost = priceForReseller(plan, me);
  if (me.balance < cost) {
    return res.status(400).json({ success: false, message:
      `موجودی کافی نیست. هزینه: ${cost.toLocaleString()} ت — موجودی: ${Math.floor(me.balance).toLocaleString()} ت` });
  }

  const f = resellerFieldsFromPlan(plan);
  // کسرِ پول و ساختِ پنل باید اتمیک باشند: اگر وسطش خطا بخورد نباید پول
  // کم شده باشد ولی پنلی ساخته نشده باشد (یا برعکس).
  const run = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO resellers (username, password, plain_password, name, telegram_id, traffic_limit_gb,
                             max_clients, price_per_gb, balance, expires_at, is_active, parent_id,
                             can_create_panels, discount_percent, allowed_inbounds)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,?,0,0,?)
    `).run(username, bcrypt.hashSync(password, 10), password, String(name).trim(), String(telegram_id || ''),
           f.traffic_limit_gb, f.max_clients, f.price_per_gb, f.balance, f.expires_at, me.id,
           me.allowed_inbounds || '[]');
    db.prepare('UPDATE resellers SET balance = balance - ? WHERE id=?').run(cost, me.id);
    db.prepare('INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?,?,?,?)')
      .run(me.id, 'debit', cost, 'ساخت پنل «' + username + '» — پلن ' + plan.name);
    if (f.balance > 0) {
      db.prepare('INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?,?,?,?)')
        .run(r.lastInsertRowid, 'credit', f.balance, 'شارژ اولیه — پلن ' + plan.name);
    }
    return r.lastInsertRowid;
  });

  try {
    const id = run();
    const left = db.prepare('SELECT balance FROM resellers WHERE id=?').get(me.id).balance;
    notifyAdmin(
      '<b>\u{1F195} پنل زیرمجموعه</b>\n' +
      '\u{1F464} سازنده: ' + me.username + '\n' +
      '\u{1F4E6} پنل: ' + username + ' (' + plan.name + ')\n' +
      '\u{1F4B5} ' + cost.toLocaleString() + ' تومان'
    );
    res.json({ success: true, id, cost, balance: left, message: 'پنل ساخته شد — ' + cost.toLocaleString() + ' تومان کسر شد' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/charge/history', resellerAuth, (req, res) => {
  const db = getDB();
  const rows = db.prepare(
    'SELECT id, amount, status, admin_note, created_at, reviewed_at FROM charge_requests WHERE reseller_id=? ORDER BY created_at DESC LIMIT 20'
  ).all(req.user.id);
  res.json({ success: true, data: rows });
});


module.exports = router;
