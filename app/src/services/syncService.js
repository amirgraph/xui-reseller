const { getDB } = require('../models/database');
const xui = require('./xuiService');

async function syncUsersJob() {
  const db = getDB();
  try {
    const allClientsXui = await xui.getAllClientsWithTrafficRaw();

    // دو map بساز: email→stats و uuid→stats
    const statsByEmail = {};
    const statsByUuid = {};
    for (const c of allClientsXui) {
      const t = c.traffic || {};
      const stat = {
        up: t.up || 0,
        down: t.down || 0,
        total: (t.up || 0) + (t.down || 0),
        enable: c.enable,
        expiryTime: c.expiryTime,
        email: c.email,
      };
      if (c.email) statsByEmail[c.email] = stat;
      if (c.uuid) statsByUuid[c.uuid] = stat;
    }

    const clients = db.prepare('SELECT * FROM clients').all();
    const updateTraffic = db.prepare(
      `UPDATE clients SET traffic_used_gb=?, last_sync=CURRENT_TIMESTAMP WHERE id=?`
    );
    const updateEmail = db.prepare(`UPDATE clients SET email=? WHERE id=?`);

    const resellerDelta = {};

    for (const client of clients) {
      // email اول، اگه نبود UUID
      let stat = statsByEmail[client.email] || statsByUuid[client.xui_uuid];
      if (!stat) continue;

      // اگه email خالیه ولی از uuid پیداش کردیم، email رو هم ذخیره کن
      if ((!client.email || client.email === '') && stat.email) {
        updateEmail.run(stat.email, client.id);
      }

      const usedGb = stat.total / Math.pow(1024, 3);
      const diff = Math.max(0, usedGb - (client.traffic_used_gb || 0));
      updateTraffic.run(usedGb, client.id);

      if (!resellerDelta[client.reseller_id]) resellerDelta[client.reseller_id] = 0;
      resellerDelta[client.reseller_id] += diff;

      // غیرفعال کردن وقتی حجم تموم شد
      if (client.is_active && client.traffic_limit_gb > 0 && usedGb >= client.traffic_limit_gb) {
        try {
          await xui.toggleClient(client.xui_inbound_id, client.xui_uuid, false, client.email || stat.email);
        } catch (e) {}
        db.prepare('UPDATE clients SET is_active=0 WHERE id=?').run(client.id);
      }
    }

    const updateReseller = db.prepare(
      `UPDATE resellers SET traffic_used_gb=traffic_used_gb+? WHERE id=?`
    );
    for (const [rid, delta] of Object.entries(resellerDelta)) {
      if (delta > 0) updateReseller.run(delta, rid);
    }
  } catch (err) {
    console.error('Sync error:', err.message);
  }
}

async function checkExpiredAccounts() {
  const db = getDB();
  try {
    const expired = db.prepare(`
      SELECT * FROM clients WHERE is_active=1
      AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
    `).all();
    for (const client of expired) {
      try {
        await xui.toggleClient(client.xui_inbound_id, client.xui_uuid, false, client.email);
      } catch (e) {}
      db.prepare('UPDATE clients SET is_active=0 WHERE id=?').run(client.id);
    }
  } catch (err) {
    console.error('Expiry check error:', err.message);
  }
}

function returnTrafficToReseller(resellerId, trafficUsedGb, trafficLimitGb) {
  const db = getDB();
  const remaining = Math.max(0, trafficLimitGb - trafficUsedGb);
  db.prepare(`UPDATE resellers SET traffic_used_gb=MAX(0,traffic_used_gb-?) WHERE id=?`).run(remaining, resellerId);
  return remaining;
}

module.exports = { syncUsersJob, checkExpiredAccounts, returnTrafficToReseller };
