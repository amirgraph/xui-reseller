const express = require('express');
const axios = require('axios');
const https = require('https');
const { getDB } = require('../models/database');
const router = express.Router();
const SUB_BASE = process.env.SUB_BASE_URL || 'http://localhost:3000/sub';
const XUI_URL = process.env.XUI_URL;
const XUI_PATH = process.env.XUI_PATH || '';
const BEARER_TOKEN = process.env.XUI_API_KEY;
const CDN_PATH = process.env.CDN_XHTTP_PATH || '/xh2a00c7b6';

const xuiAxios = axios.create({
  baseURL: XUI_URL + XUI_PATH,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 10000,
  headers: { 'Authorization': `Bearer ${BEARER_TOKEN}`, 'Accept': 'application/json' }
});

const IPV6_LIST = [
  '2001:41d0:f00:bf00::a:1',
  '2001:41d0:f00:bf00::a:2',
  '2001:41d0:f00:bf00::a:3',
  '2001:41d0:f00:bf00::a:4',
  '2001:41d0:f00:bf00::a:5',
  '2001:41d0:f00:bf00::a:6',
  '2001:41d0:f00:bf00::a:7',
  '2001:41d0:f00:bf00::a:8',
  '2001:41d0:f00:bf00::a:9',
  '2001:41d0:f00:bf00::a:10',
];

// ۵ آدرس IPv6 برای کانفیگ خالی (بدون رمزنگاری)
const IPV6_PLAIN = [
  '2001:41d0:f00:bf00::a:1',
  '2001:41d0:f00:bf00::a:3',
  '2001:41d0:f00:bf00::a:5',
  '2001:41d0:f00:bf00::a:7',
  '2001:41d0:f00:bf00::a:9',
];

const CDN_CONFIGS = [
  { host: 'cdn.example.top',  name: '☁️ CDN-1 Arvan' },
  { host: 'app.example.top',  name: '☁️ CDN-2 Arvan' },
  { host: 'dl.example.top',   name: '☁️ CDN-3 Arvan' },
];

const nums = ['۱','۲','۳','۴','۵','۶','۷','۸','۹','۱۰'];

let inboundCache = null;
let inboundCacheTime = 0;

// ── «حالتِ ضدفیلترِ پیشرفته» (PattNG) ──
// مقادیرِ fragment(finalMask)/cipherSuites از کانالِ PattNG. این‌ها فقط در
// PattNG اثر دارند (fp=unsafe) و روی کانفیگِ Cloudflare هم «محدودیتِ آپلود» و
// هم «فیلترِ دامنه» را رد می‌کنند. کانفیگِ عادی برای بقیهٔ اپ‌ها دست‌نخورده می‌ماند.
const ANTIFILTER_FM = '{"tcp": [{"type": "fragment", "settings": {"packets": "tlshello", "lengths": ["5","94", "1"], "delays": ["0"], "maxSplit": "0"}},{"type": "fragment", "settings": {"packets": "1-1", "lengths": ["109", "1"], "delays": ["1"], "maxSplit": "355"}}]}';
const ANTIFILTER_CS = 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384:TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384:TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256:TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA:TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA:TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256:TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256';
// توگلِ ادمین: نسخهٔ «⚡ ضدفیلتر» به ساب اضافه شود؟ (settings.antifilter_extra)
function antifilterOn() {
  try { const r = getDB().prepare("SELECT value FROM settings WHERE key='antifilter_extra'").get(); return !!(r && r.value === '1'); }
  catch { return false; }
}

async function buildLinks(uuid, label) {
  const e = encodeURIComponent;
  const links = [];
  const baseLabel = label || 'امیرپنل';
  // چندسروره: از جدولِ servers ساخته می‌شود؛ اگر خالی بود، fallback به env (تک‌سرورِ قدیمی)
  let servers = [];
  try {
    servers = getDB().prepare('SELECT * FROM servers WHERE active=1 ORDER BY sort_order, id').all();
  } catch (_) { servers = []; }
  if (!servers.length) {
    servers = [{
      name: baseLabel, flag: '',
      // سازگاریِ عقب‌رو: نصب‌های قدیمی هنوز NAHAN_* دارند
      domains: process.env.AMIRPANEL_SUBS || process.env.NAHAN_SUBS || '',
      clean_ips: process.env.AMIRPANEL_ADDRS || process.env.NAHAN_ADDRS || '',
      tunnel_path: CDN_PATH,
    }];
  }
  const afOn = antifilterOn();
  // بخشِ transport بسته به شبکهٔ سرور: xhttp (Cloudflare) یا ws (آروان/CDN)
  const transport = (net, h, tpath) =>
    net === 'ws'
      ? `type=ws&host=${e(h)}&path=${e(tpath)}`
      : `type=xhttp&host=${e(h)}&path=${e(tpath)}&mode=auto&extra=${e('{"xPaddingBytes":"100-1000"}')}`;
  for (const srv of servers) {
    const subs = String(srv.domains || '').split(',').map((s) => s.trim()).filter(Boolean);
    const addrs = String(srv.clean_ips || '').split(',').map((s) => s.trim()).filter(Boolean);
    const tpath = srv.tunnel_path || CDN_PATH;
    const net = (srv.network || 'xhttp').trim();           // xhttp | ws
    const tag = (srv.flag ? srv.flag + ' ' : '') + (srv.name || baseLabel);
    // یک کانفیگ به ازای هر IP تمیز (اگر IP بیش از دامنه بود، دامنه‌ها cycle می‌شوند).
    const nSubs = subs.length || 1;
    const total = Math.max(subs.length, addrs.length) || 0;
    // ── کانفیگ‌های عادی (همهٔ اپ‌ها) ──
    for (let i = 0; i < total; i++) {
      const h = subs[i % nSubs];
      const addr = addrs.length ? addrs[i % addrs.length] : h;
      links.push(
        `vless://${uuid}@${addr}:443?encryption=none&security=tls&sni=${e(h)}&fp=chrome&alpn=${e(net === 'ws' ? 'http/1.1' : 'h2,http/1.1')}&${transport(net, h, tpath)}#${e(tag + ' - ' + (i + 1))}`
      );
    }
    // ── نسخهٔ «⚡ ضدفیلتر» (فرگمنت/PattNG) — وقتی توگل روشن است، دوقلوی هر کانفیگ ──
    if (afOn) {
      for (let i = 0; i < total; i++) {
        const h = subs[i % nSubs];
        const addr = addrs.length ? addrs[i % addrs.length] : h;
        links.push(
          `vless://${uuid}@${addr}:443?encryption=none&security=tls&sni=${e(h)}&fp=unsafe&alpn=${e('http/1.1')}&${transport(net, h, tpath)}&fm=${e(ANTIFILTER_FM)}&cs=${e(ANTIFILTER_CS)}&insecure=0&allowInsecure=0#${e('⚡ ضدفیلتر - ' + (i + 1))}`
        );
      }
    }
  }
  return links;
}

// ویس‌چت فعال است؟ (تاگلِ ادمین؛ نبودِ کلید = فعال)
function voiceEnabled() {
  try {
    const r = getDB().prepare("SELECT value FROM settings WHERE key='voice_enabled'").get();
    return !r || r.value === '1';
  } catch { return true; }
}
// وضعیتِ ویس برای صفحهٔ ساب (مخفی‌کردنِ کارت وقتی خاموش است)
router.get('/voice-status', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ enabled: voiceEnabled() });
});

router.get('/voice-token', async (req, res) => {
  try {
    if (!voiceEnabled()) return res.status(403).json({ error: 'voice disabled' });
    // کلید/سکرتِ LiveKit از env می‌آید (نباید در کد هاردکد شود)
    const LK_KEY = process.env.LIVEKIT_KEY, LK_SECRET = process.env.LIVEKIT_SECRET;
    if (!LK_KEY || !LK_SECRET) return res.status(503).json({ error: 'voice not configured' });
    const { AccessToken } = require('livekit-server-sdk');
    const { user, room } = req.query;
    const at = new AccessToken(LK_KEY, LK_SECRET, { identity: user || 'guest', ttl: '6h' });
    at.addGrant({ roomJoin: true, room: room || 'anastia-voice', canPublish: true, canSubscribe: true });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ token: await at.toJwt() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// اسکنرِ per-server IPهای تمیز را اینجا POST می‌کند (توکن‌محور، بدونِ لاگین)
router.post('/apply-cleanip', (req, res) => {
  const { server_id, token, ips } = req.body || {};
  if (!server_id || !token || !ips) return res.status(400).json({ success: false, message: 'params' });
  const row = getDB().prepare('SELECT * FROM servers WHERE id=?').get(server_id);
  if (!row || row.scan_token !== token) return res.status(403).json({ success: false, message: 'invalid token' });
  const clean = String(ips).split(',').map((s) => s.trim()).filter(Boolean).join(',');
  getDB().prepare('UPDATE servers SET clean_ips=? WHERE id=?').run(clean, server_id);
  res.json({ success: true, applied: clean });
});

// اپ‌های VPN وقتی ساب رو fetch می‌کنن معمولاً UA کوتاه و مشخص خودشون رو می‌فرستن
// (v2rayNG/…، Hiddify/…، Shadowrocket/…، sing-box، Clash و…)، برخلاف مرورگر که
// UA کامل Chrome/Safari/Firefox داره. اگه UA مرورگر بود، به‌جای متن خامِ
// base64، آدم رو می‌بریم صفحه‌ی برندشده‌ی /view/ که هم قشنگ‌تره هم وضعیت
// فعال/غیرفعال رو درست نشون می‌ده.
function looksLikeBrowser(ua) {
  if (!ua) return false;
  const vpnAppHints = /v2ray|hiddify|shadowrocket|clash|sing-box|streisand|nekobox|nekoray|passwall|karing|husi|matsuri|surge|quantumult|stash|loon|throne|v2box|npv|flclash/i;
  if (vpnAppHints.test(ua)) return false;
  return /Mozilla\/5\.0/i.test(ua) && /(Chrome|Safari|Firefox|Edg|OPR|CriOS|FxiOS)/i.test(ua);
}

router.get('/:uuid', async (req, res) => {
  const db = getDB();
  const { uuid } = req.params;
  let client;
  if (/^[0-9a-fA-F-]{36}$/.test(uuid)) {
    // فرمت خودِ این پروژه: uuid کامل با خط‌تیره
    client = db.prepare('SELECT * FROM clients WHERE xui_uuid=?').get(uuid);
  } else if (/^[0-9a-fA-F]{16}$/.test(uuid)) {
    // فرمت استاندارد ۳X-UI: subId کوتاه (۱۶ کاراکتر اول uuid بدون خط‌تیره) —
    // همون چیزی که بات‌هایی مثل میرزا طبق کانوانسیون ثنایی می‌سازن
    client = db.prepare("SELECT * FROM clients WHERE REPLACE(xui_uuid,'-','') LIKE ?").get(uuid + '%');
  } else {
    return res.status(404).send('bad');
  }
  if (!client) return res.status(404).send('Not found or disabled');

  if (looksLikeBrowser(req.headers['user-agent'] || '')) {
    return res.redirect(302, `/view/${client.xui_uuid}`);
  }

  if (!client.is_active) return res.status(404).send('Not found or disabled');
  const reseller = db.prepare('SELECT * FROM resellers WHERE id=?').get(client.reseller_id);
  const brandName = (reseller && reseller.brand_name) || 'VPN Service';
  const expireTimestamp = client.expires_at ? Math.floor(new Date(client.expires_at).getTime()/1000) : 0;
  const userinfo = 'upload=0; download=' + Math.round((client.traffic_used_gb||0) * 1073741824) + '; total=' + Math.round((client.traffic_limit_gb||0) * 1073741824) + '; expire=' + expireTimestamp;

  try {
    const configLabel = client.display_name || (reseller && reseller.brand_name) || null;
    const links = await buildLinks(client.xui_uuid, configLabel);
    if (!links.length) return res.status(503).send('No active inbounds');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Profile-Title', Buffer.from(brandName).toString('base64'));
    res.setHeader('Profile-Update-Interval', '6');
    res.setHeader('Subscription-Userinfo', userinfo);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(Buffer.from(links.join('\n')).toString('base64'));
  } catch (err) {
    console.error('Sub error:', err.message);
    res.status(500).send('Error generating subscription');
  }
});

router.get('/:uuid/info', (req, res) => {
  const db = getDB();
  const client = db.prepare('SELECT * FROM clients WHERE xui_uuid=?').get(req.params.uuid);
  if (!client) return res.status(404).json({ success: false });
  res.json({ success: true, sub_url: `${SUB_BASE}/${client.xui_uuid}`, traffic_used_gb: client.traffic_used_gb, traffic_limit_gb: client.traffic_limit_gb, expires_at: client.expires_at, is_active: client.is_active });
});

module.exports = router;
