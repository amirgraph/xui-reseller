require("dotenv").config({ path: "/opt/xui-reseller/.env" });
const https = require("https");

// پیام به یک چتِ دلخواه (نه فقط ادمین) — برای یادآوریِ تمدید به خودِ نماینده
function notifyChat(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
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

// ADMIN_TELEGRAM_ID می‌تواند چندتایی (کاما-جدا، مالتی-ادمین) باشد؛ تلگرام
// chat_id تکی می‌خواهد، پس باید جدا-جدا برای هرکدام بفرستیم وگرنه با
// «۱۲۳,۴۵۶» به‌عنوانِ chat_id واحد، سکوت‌شده رد می‌شود.
function notifyAdmin(text) {
  String(process.env.ADMIN_TELEGRAM_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .forEach((id) => notifyChat(id, text));
}

module.exports = { notifyAdmin, notifyChat };
