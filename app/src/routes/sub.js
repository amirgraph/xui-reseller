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

async function buildLinks(uuid) {
  const e = encodeURIComponent;
  const links = [];
  // فقط نهان: xhttp پشت Cloudflare روی ۳ ساب‌دامین با IP تمیزِ اسکنر (چرخش خودکار)
  const NAHAN_SUBS = (process.env.NAHAN_SUBS || '__NSUB1__,__NSUB2__,__NSUB3__').split(',');
  const NAHAN_ADDRS = (process.env.NAHAN_ADDRS || '').split(',').filter(Boolean);
  for (let i = 0; i < NAHAN_SUBS.length; i++) {
    const h = NAHAN_SUBS[i].trim();
    const addr = NAHAN_ADDRS[i % (NAHAN_ADDRS.length || 1)] || h;
    links.push(
      `vless://${uuid}@${addr}:443?encryption=none&security=tls&sni=${e(h)}&fp=chrome&alpn=${e('h2,http/1.1')}&type=xhttp&host=${e(h)}&path=${e('/__XHTTP_NAME__')}&mode=auto&extra=${e('{"xPaddingBytes":"100-1000"}')}#${e('🔒 نهان-' + (i + 1))}`
    );
  }
  return links;
}

router.get('/voice-token', async (req, res) => {
  try {
    const { AccessToken } = require('livekit-server-sdk');
    const { user, room } = req.query;
    const at = new AccessToken('anastia', '1d39ab03932b3b6d7740d272e928c6ad5477356245c6778faee5a8a0f3e968c1', { identity: user || 'guest', ttl: '6h' });
    at.addGrant({ roomJoin: true, room: room || 'anastia-voice', canPublish: true, canSubscribe: true });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ token: await at.toJwt() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:uuid', async (req, res) => {
  const db = getDB();
  const { uuid } = req.params;
  if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) return res.status(404).send('bad');
  const client = db.prepare('SELECT * FROM clients WHERE xui_uuid=?').get(uuid);
  if (!client || !client.is_active) return res.status(404).send('Not found or disabled');
  const reseller = db.prepare('SELECT * FROM resellers WHERE id=?').get(client.reseller_id);
  const brandName = (reseller && reseller.brand_name) || 'VPN Service';
  const expireTimestamp = client.expires_at ? Math.floor(new Date(client.expires_at).getTime()/1000) : 0;
  const userinfo = 'upload=0; download=' + Math.round((client.traffic_used_gb||0) * 1073741824) + '; total=' + Math.round((client.traffic_limit_gb||0) * 1073741824) + '; expire=' + expireTimestamp;

  try {
    const links = await buildLinks(uuid);
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
