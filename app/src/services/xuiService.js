const axios = require('axios');
const https = require('https');

const XUI_URL = process.env.XUI_URL;
const XUI_PATH = process.env.XUI_PATH || '';
const BEARER_TOKEN = process.env.XUI_API_KEY;

const agent = new https.Agent({ rejectUnauthorized: false });

const xuiAxios = axios.create({
  baseURL: XUI_URL + XUI_PATH,
  httpsAgent: agent,
  timeout: 15000,
  headers: {
    'Authorization': `Bearer ${BEARER_TOKEN}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
});

async function xuiRequest(method, endpoint, data = null) {
  const config = { method, url: endpoint };
  if (data) config.data = data;
  const res = await xuiAxios(config);
  return res.data;
}

async function login() { return true; }

async function getInbounds() {
  const res = await xuiRequest('GET', '/panel/api/inbounds/list');
  return res?.obj || [];
}

// همه کلاینت‌ها با ترافیک از clientStats موجود در inbound list
async function getAllClientsWithTraffic() {
  const res = await xuiRequest('GET', '/panel/api/inbounds/list');
  const inbounds = res?.obj || [];
  // تجمیع ترافیک بر اساس UUID روی همهٔ اینباندها (Reality + نهان + IPv6) — نه فقط ایمیل اصلی
  const byUuid = {};
  for (const ib of inbounds) {
    const stats = ib.clientStats || [];
    for (const c of stats) {
      if (!c.uuid) continue;
      if (!byUuid[c.uuid]) byUuid[c.uuid] = { email: c.email, uuid: c.uuid, enable: c.enable, expiryTime: c.expiryTime || 0, up: 0, down: 0 };
      byUuid[c.uuid].up += c.up || 0;
      byUuid[c.uuid].down += c.down || 0;
      if (c.email && !String(c.email).startsWith('nh_')) byUuid[c.uuid].email = c.email;
      if (c.enable) byUuid[c.uuid].enable = true;
    }
  }
  return Object.values(byUuid).map(function (x) {
    return { email: x.email, uuid: x.uuid, enable: x.enable, expiryTime: x.expiryTime, traffic: { up: x.up, down: x.down } };
  });
}

async function getAllClientStats() {
  const clients = await getAllClientsWithTraffic();
  const stats = {};
  for (const c of clients) {
    const t = c.traffic || {};
    stats[c.email] = {
      up: t.up || 0,
      down: t.down || 0,
      total: (t.up || 0) + (t.down || 0),
      enable: c.enable,
      expiryTime: c.expiryTime,
    };
  }
  return stats;
}

// اضافه کردن کلاینت — inboundId میتونه عدد یا آرایه باشه
async function addClient(inboundId, clientData) {
  const ids = Array.isArray(inboundId) ? inboundId : [inboundId];
  const payload = { ...clientData, tgId: parseInt(clientData.tgId || 0) || 0 };
  // per-inbound best-effort: اینباندهای قدیمیِ خراب (record not found) را نادیده بگیر،
  // روی اینباندهای سالم موفق شو. موفقیت = حداقل یک اینباند بپذیرد.
  let anyOk = false;
  const results = [];
  for (const id of ids) {
    try {
      const r = await xuiRequest('POST', '/panel/api/clients/add', { inboundIds: [id], client: payload });
      const ok = !!(r && r.success);
      if (ok) anyOk = true;
      results.push({ id, ok, msg: r && r.msg });
    } catch (e) {
      results.push({ id, ok: false, msg: e.message });
    }
  }
  return { success: anyOk, obj: null, results };
}

// آپدیت کلاینت — email در URL path
async function updateClient(inboundId, uuid, clientData) {
  const email = clientData.email;
  const payload = {
    ...clientData,
    id: uuid,
    tgId: parseInt(clientData.tgId || 0) || 0,
  };
  return await xuiRequest('POST', `/panel/api/clients/update/${encodeURIComponent(email)}`, payload);
}

// حذف کلاینت — با email
async function deleteClient(inboundId, uuid, email) {
  if (!email) return { success: false, msg: 'email required for delete' };
  return await xuiRequest('POST', `/panel/api/clients/del/${encodeURIComponent(email)}`);
}

// فعال/غیرفعال — با get/{email} اطلاعات کامل میگیریم
async function toggleClient(inboundId, uuid, enable, email) {
  if (!email) return { success: false, msg: 'email required for toggle' };
  const info = await xuiRequest('GET', `/panel/api/clients/get/${encodeURIComponent(email)}`);
  const c = info?.obj?.client;
  if (!c) return { success: false, msg: 'client not found' };
  return await xuiRequest('POST', `/panel/api/clients/update/${encodeURIComponent(email)}`, {
    email: c.email,
    id: c.uuid,
    subId: c.subId || '',
    flow: c.flow || '',
    security: c.security || '',
    limitIp: c.limitIp || 0,
    totalGB: c.totalGB || 0,
    expiryTime: c.expiryTime || 0,
    enable: enable,
    tgId: parseInt(c.tgId || 0) || 0,
    group: c.group || '',
    comment: c.comment || '',
    reset: c.reset || 0,
  });
}

module.exports = { login, getInbounds, addClient, updateClient, deleteClient, toggleClient, getAllClientStats, getAllClientsWithTrafficRaw: getAllClientsWithTraffic };
