require("dotenv").config({ path: "/opt/xui-reseller/.env" });
const https = require("https");

function notifyAdmin(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ADMIN_TELEGRAM_ID;
  if (!token || !chatId) return;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
  const req = https.request({
    hostname: "api.telegram.org",
    path: `/bot${token}/sendMessage`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
  }, () => {});
  req.on("error", () => {});
  req.write(body);
  req.end();
}

module.exports = { notifyAdmin };
