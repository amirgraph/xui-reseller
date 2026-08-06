const axios = require('axios');
const https = require('https');
const { getDB } = require('../models/database');

// سرورِ پیش‌فرض از env (سرورِ اولِ فعلی). سرورهای بیشتر از جدولِ servers می‌آیند.
const ENV_URL = process.env.XUI_URL;
const ENV_PATH = process.env.XUI_PATH || '';
const ENV_KEY = process.env.XUI_API_KEY;

const agent = new https.Agent({ rejectUnauthorized: false });

// یک کلاینتِ HTTP برای یک سرورِ 3x-ui مشخص
function makeClient(url, path, key) {
  const ax = axios.create({
    baseURL: (url || '') + (path || ''),
    httpsAgent: agent,
    timeout: 15000,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  async function req(method, endpoint, data = null) {
    const config = { method, url: endpoint };
    if (data) config.data = data;
    return (await ax(config)).data;
  }
  return {
    req,
    getInbounds: async () => (await req('GET', '/panel/api/inbounds/list'))?.obj || [],
    del: (email) => req('POST', `/panel/api/clients/del/${encodeURIComponent(email)}`),
    getClient: (email) => req('GET', `/panel/api/clients/get/${encodeURIComponent(email)}`),
    update: (email, payload) => req('POST', `/panel/api/clients/update/${encodeURIComponent(email)}`, payload),
  };
}

// سرورهای فعال از دیتابیس؛ اگر جدول خالی/نبود، fallback به سرورِ env (تک‌سرورِ قدیمی)
function activeServers() {
  try {
    const rows = getDB().prepare('SELECT * FROM servers WHERE active=1 ORDER BY sort_order, id').all();
    if (rows.length) return rows;
  } catch (_) {}
  return [{ xui_url: ENV_URL, xui_path: ENV_PATH, xui_api_key: ENV_KEY, inbound_ids: '', _env: true }];
}
const isEnvServer = (s) => s._env || s.xui_url === ENV_URL;
const clientFor = (s) => makeClient(s.xui_url, s.xui_path || '', s.xui_api_key);

async function login() { return true; }

// اینباندهای سرورِ اصلی (env) — برای انتخابِ اینباند در پنلِ ادمین
async function getInbounds() {
  const s = activeServers().find(isEnvServer) || activeServers()[0];
  try { return await clientFor(s).getInbounds(); } catch (e) { return []; }
}

// ترافیکِ همهٔ کلاینت‌ها — تجمیع بر اساس UUID روی همهٔ سرورهای فعال (چندکشوره)
async function getAllClientsWithTrafficRaw() {
  const byUuid = {};
  for (const s of activeServers()) {
    let inbounds = [];
    try { inbounds = await clientFor(s).getInbounds(); } catch (e) { continue; }
    for (const ib of inbounds) {
      for (const c of (ib.clientStats || [])) {
        if (!c.uuid) continue;
        if (!byUuid[c.uuid]) byUuid[c.uuid] = { email: c.email, uuid: c.uuid, enable: c.enable, expiryTime: c.expiryTime || 0, up: 0, down: 0 };
        byUuid[c.uuid].up += c.up || 0;
        byUuid[c.uuid].down += c.down || 0;
        if (c.email && !String(c.email).startsWith('nh_')) byUuid[c.uuid].email = c.email;
        if (c.enable) byUuid[c.uuid].enable = true;
      }
    }
  }
  return Object.values(byUuid).map((x) => ({ email: x.email, uuid: x.uuid, enable: x.enable, expiryTime: x.expiryTime, traffic: { up: x.up, down: x.down } }));
}

async function getAllClientStats() {
  const clients = await getAllClientsWithTrafficRaw();
  const stats = {};
  for (const c of clients) {
    const t = c.traffic || {};
    stats[c.email] = { up: t.up || 0, down: t.down || 0, total: (t.up || 0) + (t.down || 0), enable: c.enable, expiryTime: c.expiryTime };
  }
  return stats;
}

// اینباندهای هدفِ یک سرور: اگر server.inbound_ids ست است از همان؛ وگرنه برای سرورِ env از inboundIdِ فراخوان
function targetInbounds(s, callerIds) {
  if (s.inbound_ids && String(s.inbound_ids).trim()) {
    return String(s.inbound_ids).split(',').map((x) => parseInt(x.trim(), 10)).filter(Boolean);
  }
  if (isEnvServer(s)) return callerIds;
  return null; // سرورِ غیرِenv بدونِ inbound_ids → provisioning نمی‌شود
}

// افزودنِ کلاینت روی همهٔ سرورهای فعال (همان uuid روی همه)
async function addClient(inboundId, clientData) {
  const callerIds = Array.isArray(inboundId) ? inboundId : [inboundId];
  const payload = { ...clientData, tgId: parseInt(clientData.tgId || 0) || 0 };
  let anyOk = false;
  const results = [];
  for (const s of activeServers()) {
    const ids = targetInbounds(s, callerIds);
    if (!ids || !ids.length) continue;
    const cl = clientFor(s);
    for (const id of ids) {
      try {
        const r = await cl.req('POST', '/panel/api/clients/add', { inboundIds: [id], client: payload });
        const ok = !!(r && r.success);
        if (ok) anyOk = true;
        results.push({ server: s.xui_url, id, ok, msg: r && r.msg });
      } catch (e) {
        results.push({ server: s.xui_url, id, ok: false, msg: e.message });
      }
    }
  }
  return { success: anyOk, obj: null, results };
}

// آپدیت روی همهٔ سرورها (best-effort)
async function updateClient(inboundId, uuid, clientData) {
  const email = clientData.email;
  const payload = { ...clientData, id: uuid, tgId: parseInt(clientData.tgId || 0) || 0 };
  let anyOk = false;
  for (const s of activeServers()) {
    try { const r = await clientFor(s).update(email, payload); if (r && r.success) anyOk = true; } catch (e) {}
  }
  return { success: anyOk };
}

// حذف از همهٔ سرورها
async function deleteClient(inboundId, uuid, email) {
  if (!email) return { success: false, msg: 'email required for delete' };
  let anyOk = false;
  for (const s of activeServers()) {
    try { const r = await clientFor(s).del(email); if (r && r.success) anyOk = true; } catch (e) {}
  }
  return { success: anyOk };
}

// فعال/غیرفعال روی همهٔ سرورها
async function toggleClient(inboundId, uuid, enable, email) {
  if (!email) return { success: false, msg: 'email required for toggle' };
  let anyOk = false;
  for (const s of activeServers()) {
    try {
      const cl = clientFor(s);
      const info = await cl.getClient(email);
      const c = info?.obj?.client;
      if (!c) continue;
      const r = await cl.update(email, {
        email: c.email, id: c.uuid, subId: c.subId || '', flow: c.flow || '', security: c.security || '',
        limitIp: c.limitIp || 0, totalGB: c.totalGB || 0, expiryTime: c.expiryTime || 0, enable: enable,
        tgId: parseInt(c.tgId || 0) || 0, group: c.group || '', comment: c.comment || '', reset: c.reset || 0,
      });
      if (r && r.success) anyOk = true;
    } catch (e) {}
  }
  return { success: anyOk };
}

module.exports = { login, getInbounds, addClient, updateClient, deleteClient, toggleClient, getAllClientStats, getAllClientsWithTrafficRaw };
