const express = require('express');
const https = require('https');
const http = require('http');
const { getDB } = require('../models/database');
const router = express.Router();

// لینک‌های واقعی رو از x-ui می‌گیریم و برمی‌گردونیم
function fetchXuiLinks(subUrl) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(subUrl);
      const lib = urlObj.protocol === 'https:' ? https : http;
      const opts = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname,
        method: 'GET',
        rejectUnauthorized: false,
        timeout: 5000,
      };
      const req = lib.request(opts, (proxyRes) => {
        let raw = '';
        proxyRes.on('data', (chunk) => { raw += chunk; });
        proxyRes.on('end', () => {
          try {
            // x-ui sub معمولاً base64 برمی‌گردونه
            let decoded = raw.trim();
            try { decoded = Buffer.from(decoded, 'base64').toString('utf8'); } catch (_) {}
            const links = decoded.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && /^(vless|vmess|trojan|ss|hysteria)/.test(l));
            resolve(links);
          } catch (_) { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.end();
    } catch (_) { resolve([]); }
  });
}

router.get('/:uuid', async (req, res) => {
  const db = getDB();
  const { uuid } = req.params;
  const client = db.prepare('SELECT * FROM clients WHERE xui_uuid=?').get(uuid);
  if (!client || !client.is_active) return res.status(404).json({ success: false });

  const reseller = db.prepare('SELECT * FROM resellers WHERE id=?').get(client.reseller_id);

  // subId همیشه اینجوری محاسبه می‌شه (همون که موقع ساخت به x-ui داده شد)
  const subId = uuid.replace(/-/g, '').substring(0, 16);
  const xuiSubBase = process.env.XUI_SUB_BASE || null;
  const realSubUrl = `http://127.0.0.1:3000/sub/${uuid}`; // لینک‌ها از سابِ محلیِ آلمان (بدون وابستگی به US)

  // لینک‌ها رو از x-ui واقعی بگیر
  let links = [];
  if (realSubUrl) {
    links = await fetchXuiLinks(realSubUrl);
  }

  // اگه از x-ui چیزی نگرفتیم، یه fallback ساده بساز
  if (!links.length) {
    const ib = db.prepare('SELECT * FROM inbounds_cache WHERE id=?').get(client.xui_inbound_id);
    if (ib) {
      const ibData = JSON.parse(ib.data || '{}');
      const ss = typeof ibData.streamSettings === 'string' ? JSON.parse(ibData.streamSettings || '{}') : (ibData.streamSettings || {});
      const network = ss.network || 'tcp';
      const security = ss.security || 'none';
      const serverIP = process.env.SERVER_IP || '';
      const brandName = reseller?.brand_name || 'VPN';
      let params = `type=${network}&security=${security}`;
      if (security === 'reality') {
        const rs = ss.realitySettings || {};
        params += `&pbk=${rs.settings?.publicKey || ''}&sid=${rs.shortIds?.[0] || ''}&sni=${rs.serverNames?.[0] || ''}&spx=${encodeURIComponent(rs.settings?.spiderX || '/')}&flow=xtls-rprx-vision&fp=chrome`;
      } else if (security === 'tls') {
        params += `&sni=${ss.tlsSettings?.serverName || serverIP}`;
      }
      if (network === 'ws') {
        const ws = ss.wsSettings || {};
        params += `&path=${encodeURIComponent(ws.path || '/')}&host=${ws.host || serverIP}`;
      }
      links = [`vless://${uuid}@${serverIP}:${ib.port}?${params}#${encodeURIComponent(brandName)}`];
    }
  }

  res.json({
    success: true,
    username: client.username,
    traffic_used_gb: client.traffic_used_gb,
    traffic_limit_gb: client.traffic_limit_gb,
    expires_at: client.expires_at,
    is_active: !!client.is_active,
    // لینک اصلی x-ui رو برای کپی برگردون
    sub_url: `${process.env.SUB_BASE_FRB || 'https://__NSUB1__/sub'}/${uuid}`, // ساب ۱: کلادفلر (cloudflare)
    sub_url_2: `${process.env.SUB_BASE_URL || 'https://__MAIN_DOMAIN__/sub'}/${uuid}`, // ساب ۲: آروان (bot.example)
    links,
    brand: {
      name: reseller?.brand_name || 'VPN Service',
      color: reseller?.brand_color || '#7c3aed',
      bg: reseller?.brand_bg_color || '#07030f',
      logo: reseller?.brand_logo || '🌐',
      telegram: reseller?.telegram_support || '',
      motion: reseller?.brand_motion || 'hearts',
    },
  });
});

module.exports = router;
