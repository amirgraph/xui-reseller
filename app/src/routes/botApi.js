// ─── routes/botApi.js ────────────────────────────────────────
// API برای بات‌های نمایندگان — شکلِ مسیرها/پاسخ‌ها مثلِ API خودِ 3X-UI:
// { success, msg, obj }. با Base URL این پنل + توکنِ Bearer نماینده،
// بات مستقیم برای همون نماینده کاربر می‌سازد/می‌بیند — بدون دسترسی به
// داده‌ی نماینده‌های دیگر.
//
// عمداً به‌جای فراخوانیِ routes/reseller.js، منطق را همینجا (کپی‌شده و
// هم‌گام با نسخهٔ فعلیِ reseller.js) پیاده کرده‌ایم تا هیچ تغییری در
// مسیر تست‌شده‌ی پنل وب داده نشود. اگر بعداً منطقِ billing در
// reseller.js عوض شد، این فایل هم باید همان‌طور آپدیت شود.
//
// این روتر باید پشتِ apiKeyAuth مونت شود (نه resellerAuth/JWT).

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDB } = require('../models/database');
const xui = require('../services/xuiService');
const { returnTrafficToReseller } = require('../services/syncService');

const SUB_BASE = process.env.SUB_BASE_URL || 'http://localhost:3000/sub';
const router = express.Router();

function ok(res, obj, msg = '') { res.json({ success: true, msg, obj: obj ?? null }); }
function fail(res, status, msg) { res.status(status).json({ success: false, msg, obj: null }); }

// subId کوتاهِ استاندارد ۳X-UI — همون که هنگام ساختِ کلاینت به خودِ پنل هم داده می‌شود
function subIdOf(xuiUuid) { return xuiUuid.replace(/-/g, '').substring(0, 16); }
function subUrlOf(xuiUuid) { return `${SUB_BASE}/${subIdOf(xuiUuid)}`; }

// نماینده فقط اینباندهای مجازِ خودش را می‌تواند به بات بدهد — چک‌ی که در
// پنل وب نیست (چون آنجا کاربرِ لاگین‌شده خودِ نماینده است)، ولی برای
// توکنی که بیرون از پنل در دستِ یک بات است منطقی‌تر است.
function allowedInboundIds(reseller, allInboundIds) {
  const allowed = JSON.parse(reseller.allowed_inbounds || '[]');
  return allowed.length > 0 ? allInboundIds.filter(id => allowed.includes(id)) : allInboundIds;
}

function getOwnedClient(resellerId, ref) {
  const db = getDB();
  let client = null;
  if (/^\d+$/.test(String(ref))) {
    client = db.prepare('SELECT * FROM clients WHERE id=? AND reseller_id=?').get(ref, resellerId);
  }
  if (!client) {
    client = db.prepare('SELECT * FROM clients WHERE (email=? OR xui_uuid=?) AND reseller_id=?')
      .get(ref, ref, resellerId);
  }
  return client;
}

// ─── Inbounds ───────────────────────────────────────────────

router.get('/inbounds/list', async (req, res) => {
  try {
    // زنده از خودِ پنل ۳X-UI — بات‌هایی مثل میرزا انتظار دارن settings/streamSettings/
    // clientStats کامل باشه، نسخهٔ خلاصه‌شده رو قبول نمی‌کنن (خطای «اینباند خود را
    // مشخص کنید» همینجا بود).
    const inbounds = await xui.getInbounds();
    const allowed = JSON.parse(req.reseller.allowed_inbounds || '[]');
    const filtered = allowed.length > 0 ? inbounds.filter(ib => allowed.includes(ib.id)) : inbounds;
    ok(res, filtered);
  } catch (err) {
    fail(res, 500, 'خطا در دریافت اینباندها: ' + err.message);
  }
});

// ─── Clients ────────────────────────────────────────────────

router.get('/clients/list', (req, res) => {
  const db = getDB();
  ok(res, db.prepare('SELECT * FROM clients WHERE reseller_id=? ORDER BY created_at DESC').all(req.reseller.id));
});

router.get('/clients/get/:ref', (req, res) => {
  const client = getOwnedClient(req.reseller.id, req.params.ref);
  if (!client) return fail(res, 404, 'Client not found');
  ok(res, { ...client, subId: subIdOf(client.xui_uuid), sub_url: subUrlOf(client.xui_uuid) });
});

// body: { username, traffic_limit_gb, ip_limit, expires_at, telegram_id, inbound_ids? }
// — همان امضایی که reseller.js POST /clients می‌پذیرد.
router.post('/clients/add', async (req, res) => {
  const db = getDB();
  const reseller = req.reseller;
  const {
    username, inbound_ids,
    traffic_limit_gb = 10, ip_limit = 1,
    expires_at = null, telegram_id = null, display_name = null
  } = req.body || {};

  if (!username || String(username).trim().length < 2) return fail(res, 400, 'username الزامی است');

  if (reseller.max_clients > 0 && reseller.current_clients >= reseller.max_clients) {
    return fail(res, 400, 'Client limit reached');
  }

  const isUnlimited = Number(traffic_limit_gb) === 0;
  const UNLIMITED_MONTHLY = require('../models/plans').unlimitedMonthly();
  let cost = 0;
  if (isUnlimited) {
    if (!expires_at) return fail(res, 400, 'برای کاربر نامحدود باید تاریخ انقضا (تعداد ماه) انتخاب کنید.');
    const days = Math.max(1, Math.round((new Date(expires_at).getTime() - Date.now()) / 86400000));
    const months = Math.max(1, Math.round(days / 30));
    cost = months * UNLIMITED_MONTHLY;
  } else {
    if (reseller.traffic_limit_gb > 0) {
      const allocated = db.prepare(
        'SELECT COALESCE(SUM(traffic_limit_gb),0) AS s FROM clients WHERE reseller_id=? AND traffic_limit_gb > 0'
      ).get(reseller.id).s;
      const trafficAvailable = reseller.traffic_limit_gb - allocated;
      if (Number(traffic_limit_gb) > trafficAvailable) {
        return fail(res, 400, `حجم کافی نیست. باقی‌مانده: ${trafficAvailable.toFixed(2)} GB از ${reseller.traffic_limit_gb} GB`);
      }
    }
    if (reseller.price_per_gb > 0) cost = Number(traffic_limit_gb) * reseller.price_per_gb;
  }
  if (cost > 0 && reseller.balance < cost) {
    return fail(res, 400, `موجودی کافی نیست. موجودی: ${reseller.balance.toLocaleString()} ت — هزینه: ${cost.toLocaleString()} ت`);
  }

  const inboundList = await xui.getInbounds();
  const allInboundIds = allowedInboundIds(reseller, inboundList.map(ib => ib.id));
  const selectedInbounds = (inbound_ids && Array.isArray(inbound_ids) && inbound_ids.length > 0)
    ? inbound_ids.map(Number).filter(id => allInboundIds.includes(id))
    : allInboundIds;
  if (!selectedInbounds.length) return fail(res, 500, 'هیچ اینباند مجازی برای این نماینده در دسترس نیست');

  const uuid = uuidv4();
  const clientEmail = `${reseller.username}_${username}`.toLowerCase().replace(/\s/g, '_');
  const expiryTime = expires_at ? new Date(expires_at).getTime() : 0;
  const trafficBytes = Math.round(traffic_limit_gb * 1024 ** 3);
  const primaryInbound = selectedInbounds[0];

  try {
    const result = await xui.addClient(selectedInbounds, {
      id: uuid, email: clientEmail, enable: true,
      totalGB: trafficBytes, expiryTime, limitIp: ip_limit,
      flow: 'xtls-rprx-vision',
      tgId: telegram_id ? parseInt(telegram_id) : 0,
      subId: uuid.replace(/-/g, '').substring(0, 16),
    });
    if (!result?.success) return fail(res, 500, '3X-UI error: ' + JSON.stringify(result));

    db.prepare(`
      INSERT INTO clients (reseller_id, xui_uuid, xui_inbound_id, username, email,
        telegram_id, traffic_limit_gb, ip_limit, expires_at, display_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(reseller.id, uuid, primaryInbound, username, clientEmail,
      telegram_id, traffic_limit_gb, ip_limit, expires_at, display_name || null);

    db.prepare('UPDATE resellers SET current_clients = current_clients + 1 WHERE id = ?').run(reseller.id);

    if (cost > 0) {
      db.prepare('UPDATE resellers SET balance = balance - ? WHERE id = ?').run(cost, reseller.id);
      const desc = isUnlimited
        ? `Created UNLIMITED client: ${username} (${cost.toLocaleString()}t)`
        : `Created client: ${username} (${traffic_limit_gb}GB)`;
      db.prepare(`INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, 'debit', ?, ?)`)
        .run(reseller.id, cost, desc);
    }

    ok(res, { uuid, email: clientEmail, subId: subIdOf(uuid), sub_url: subUrlOf(uuid) }, 'کلاینت ساخته شد');
  } catch (err) {
    fail(res, 500, err.message);
  }
});

router.post('/clients/:ref/enable', async (req, res) => { await toggle(req, res, true); });
router.post('/clients/:ref/disable', async (req, res) => { await toggle(req, res, false); });

async function toggle(req, res, enable) {
  const client = getOwnedClient(req.reseller.id, req.params.ref);
  if (!client) return fail(res, 404, 'Client not found');
  const db = getDB();
  try { await xui.toggleClient(client.xui_inbound_id, client.xui_uuid, enable, client.email); }
  catch (e) { /* اگه در 3X-UI وجود نداشت، فقط DB رو آپدیت کن */ }
  db.prepare('UPDATE clients SET is_active=? WHERE id=?').run(enable ? 1 : 0, client.id);
  ok(res, { id: client.id, is_active: enable });
}

router.post('/clients/del/:ref', async (req, res) => {
  const db = getDB();
  const reseller = req.reseller;
  const client = getOwnedClient(reseller.id, req.params.ref);
  if (!client) return fail(res, 404, 'Client not found');

  if (Number(client.traffic_limit_gb) === 0) {
    return fail(res, 403, 'کاربر نامحدود قابل حذف از طریق بات نیست؛ با ادمین تماس بگیرید.');
  }

  try { await xui.deleteClient(client.xui_inbound_id, client.xui_uuid, client.email); }
  catch (e) { /* اگه در 3X-UI وجود نداشت، ادامه بده و از DB حذف کن */ }

  db.prepare('DELETE FROM clients WHERE id=?').run(client.id);
  const refundedGb = returnTrafficToReseller(reseller.id, client.traffic_used_gb, client.traffic_limit_gb);
  db.prepare('UPDATE resellers SET current_clients = current_clients - 1 WHERE id = ?').run(reseller.id);

  const info = db.prepare('SELECT price_per_gb FROM resellers WHERE id=?').get(reseller.id);
  if (info && info.price_per_gb > 0 && refundedGb > 0) {
    const refundAmount = refundedGb * info.price_per_gb;
    db.prepare('UPDATE resellers SET balance = balance + ? WHERE id = ?').run(refundAmount, reseller.id);
    db.prepare("INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, 'credit', ?, ?)")
      .run(reseller.id, refundAmount, 'بازگشت حجم: ' + client.username + ' (' + refundedGb.toFixed(2) + 'GB)');
  }

  ok(res, { refunded_gb: refundedGb }, 'حذف شد');
});

// body: { traffic_limit_gb?, ip_limit?, expires_at? }
router.post('/clients/update/:ref', async (req, res) => {
  const db = getDB();
  const reseller = req.reseller;
  const client = getOwnedClient(reseller.id, req.params.ref);
  if (!client) return fail(res, 404, 'Client not found');
  const { traffic_limit_gb, ip_limit, expires_at } = req.body || {};

  try {
    const expiryTime = expires_at ? new Date(expires_at).getTime() : 0;
    const trafficBytes = Math.round((traffic_limit_gb || client.traffic_limit_gb) * 1024 ** 3);
    try {
      await xui.updateClient(client.xui_inbound_id, client.xui_uuid, {
        id: client.xui_uuid, email: client.email, enable: !!client.is_active,
        totalGB: trafficBytes, expiryTime, limitIp: ip_limit || client.ip_limit,
        flow: 'xtls-rprx-vision',
      });
    } catch (e) { /* اگه در 3X-UI وجود نداشت، فقط DB رو آپدیت کن */ }

    const newGb = traffic_limit_gb || client.traffic_limit_gb;
    const diff = newGb - client.traffic_limit_gb;
    if (diff !== 0 && reseller.price_per_gb > 0) {
      const costDiff = diff * reseller.price_per_gb;
      db.prepare('UPDATE resellers SET balance = balance - ? WHERE id = ?').run(costDiff, reseller.id);
      db.prepare("INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, ?, ?, ?)")
        .run(reseller.id, diff > 0 ? 'debit' : 'credit', Math.abs(costDiff),
          'Edit client: ' + client.username + ' (' + (diff > 0 ? '+' : '') + diff + 'GB)');
    }
    db.prepare("UPDATE clients SET traffic_limit_gb=?, ip_limit=?, expires_at=? WHERE id=?").run(
      newGb, ip_limit !== undefined ? ip_limit : client.ip_limit,
      expires_at !== undefined ? expires_at : client.expires_at, client.id
    );
    ok(res, { id: client.id }, 'بروزرسانی شد');
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ─── Profile ────────────────────────────────────────────────

router.get('/me', (req, res) => {
  const r = req.reseller;
  ok(res, {
    username: r.username, name: r.name, balance: r.balance,
    traffic_limit_gb: r.traffic_limit_gb, traffic_used_gb: r.traffic_used_gb,
    max_clients: r.max_clients, current_clients: r.current_clients,
    price_per_gb: r.price_per_gb,
  });
});

module.exports = router;
