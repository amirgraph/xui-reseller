// override: همان دلیلِ server.js — pm2 مقدارِ قدیمی را تزریق می‌کند و dotenv
// بدونِ override آن را دست نمی‌زند، پس .env بی‌اثر می‌شود.
require('dotenv').config({ path: '/opt/xui-reseller/.env', override: true });
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const axios = require('axios');
const https = require('https');
const { v4: uuidv4 } = require('uuid');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// چند-ادمین: ADMIN_TELEGRAM_ID می‌تواند چند آیدیِ کاما-جدا باشد. اولی = ادمینِ اصلی (اعلان‌ها به آن می‌رود).
const ADMIN_IDS = String(process.env.ADMIN_TELEGRAM_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
const ADMIN_ID = ADMIN_IDS[0] || '';
const XUI_URL = process.env.XUI_URL;
const XUI_PATH = process.env.XUI_PATH || '';
const XUI_API_KEY = process.env.XUI_API_KEY;
const SUB_BASE_URL = process.env.SUB_BASE_URL || '';

// ⚠️ PRICE_PER_GB و PLANS قبلاً همین‌جا هاردکد بودند (۳۵۰۰ و برنزی/نقره‌ای/طلایی).
// نتیجه: ربات نرخِ واقعیِ هر نماینده را نادیده می‌گرفت و همان کاربر از پنل ۲۰۰
// و از ربات ۳۵۰۰ حساب می‌شد. حالا نرخ از خودِ نماینده و پلن‌ها از DB می‌آیند.
const {
  rateOf, defaultPricePerGb, activePlans, planByKey, allPlans,
  describePlan, resellerFieldsFromPlan,
} = require('./models/plans');

const db = new Database(path.resolve('/opt/xui-reseller/data/reseller.db'));
db.pragma('journal_mode = WAL');

// ── گیتِ استارتِ متقابل با رباتِ رفرال (@Ref28ralbot) ──
// کاربر برای استفاده از این ربات باید رباتِ رفرال را هم استارت کرده باشد.
// اتصالِ readonly به دیتابیسِ رفرال؛ اگر باز نشد گیت غیرفعال می‌ماند (fail-open).
let refStmt = null;
try {
  if (process.env.REFERRAL_DB) {
    const refdb = new Database(process.env.REFERRAL_DB, { readonly: true, fileMustExist: true });
    refStmt = refdb.prepare('SELECT 1 FROM users WHERE id=?');
    console.log('🔗 اتصال به دیتابیسِ رفرال برقرار شد (گیتِ استارتِ متقابل فعال).');
  }
} catch (e) {
  console.error('⚠️ اتصال به دیتابیسِ رفرال نشد؛ گیت غیرفعال:', e.message);
}
const REFERRAL_BOT = process.env.REFERRAL_BOT_USERNAME || 'Ref28ralbot';
const refGateOn = () => !!refStmt;
function refGatePassed(chatId) {
  if (!refGateOn()) return true;
  try {
    return !!refStmt.get(Number(chatId));
  } catch {
    return true; // fail-open تا کاربر قفل نشود
  }
}
function sendRefGate(chatId) {
  return bot.sendMessage(
    chatId,
    '🔒 برای استفاده از این ربات، اول رباتِ زیر را استارت کن:\n@' +
      REFERRAL_BOT +
      '\n\nبعد از استارت، دکمهٔ «✅ استارت کردم» را بزن.',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🤖 استارتِ ربات', url: 'https://t.me/' + REFERRAL_BOT + '?start=fromreseller' }],
          [{ text: '✅ استارت کردم، بررسی کن', callback_data: 'refgate_check' }],
        ],
      },
    }
  );
}

// ── عضویتِ اجباریِ کانال (ادمین با دستورِ /forcechannel تنظیم می‌کند) ──
async function channelGatePassed(chatId) {
  if (isAdmin(chatId)) return true;
  const ch = getSetting('force_channel');
  if (!ch) return true;
  try {
    const m = await bot.getChatMember(ch, chatId);
    return ['creator', 'administrator', 'member', 'restricted'].includes(m.status);
  } catch (e) { return true; } // اگر ربات نتواند بررسی کند (ادمینِ کانال نیست) قفل نکن
}
function sendChannelGate(chatId) {
  const ch = getSetting('force_channel') || '';
  const link = ch.startsWith('@') ? 'https://t.me/' + ch.slice(1) : ('https://t.me/' + String(ch).replace(/^@/, ''));
  return bot.sendMessage(
    chatId,
    '🔒 برای استفاده از ربات، اول در کانالِ ما عضو شو، بعد «✅ عضو شدم» را بزن:',
    { reply_markup: { inline_keyboard: [
      [{ text: '📢 عضویت در کانال', url: link }],
      [{ text: '✅ عضو شدم، بررسی کن', callback_data: 'chk_join' }],
    ] } }
  );
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM bot_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO bot_settings (key, value) VALUES (?, ?)').run(key, value);
}

const agent = new https.Agent({ rejectUnauthorized: false });
const xuiAxios = axios.create({
  baseURL: XUI_URL + XUI_PATH,
  httpsAgent: agent,
  timeout: 15000,
  headers: {
    'Authorization': 'Bearer ' + XUI_API_KEY,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
});

async function xuiReq(method, url, data) {
  const res = await xuiAxios({ method, url, data });
  return res.data;
}
async function getInbounds() {
  const res = await xuiReq('GET', '/panel/api/inbounds/list');
  return (res && res.obj) ? res.obj : [];
}
async function addClient(inboundId, clientData) {
  return await xuiReq('POST', '/panel/api/clients/add', { inboundIds: [inboundId], client: clientData });
}
async function toggleClient(inboundId, uuid, enable) {
  const res = await xuiReq('GET', '/panel/api/inbounds/get/' + inboundId);
  if (!res || !res.obj) return false;
  const settings = JSON.parse(res.obj.settings || '{}');
  const client = (settings.clients || []).find(function(c) { return c.id === uuid; });
  if (!client) return false;
  client.enable = enable;
  await xuiReq('POST', '/panel/api/inbounds/updateClient/' + uuid, { id: inboundId, settings: JSON.stringify({ clients: [client] }) });
  return true;
}
async function deleteClientXui(inboundId, uuid) {
  return await xuiReq('POST', '/panel/api/inbounds/' + inboundId + '/delClient/' + uuid);
}
async function getClientTraffic(email) {
  const res = await xuiReq('GET', '/panel/api/inbounds/getClientTraffics/' + email);
  return (res && res.obj) ? res.obj : null;
}

async function createPlisioInvoice(orderId, amount, description) {
  try {
    const apiKey = getSetting('plisio_api_key');
    const params = new URLSearchParams({
      api_key: apiKey,
      currency: 'USDT_TRX',
      order_number: orderId,
      order_name: description,
      source_amount: amount,
      source_currency: 'IRR',
    });
    const res = await axios.get('https://plisio.net/api/v1/invoices/new?' + params.toString(), { timeout: 15000 });
    if (res.data && res.data.status === 'success') {
      return { success: true, invoice_url: res.data.data.invoice_url, txn_id: res.data.data.txn_id };
    }
    return { success: false, error: JSON.stringify(res.data) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

const bot = new TelegramBot(TOKEN, { polling: true });

// برای ساختِ لینکِ رفرال (t.me/<username>?start=ref_<id>) لازمه — یک‌بار موقعِ
// بالا اومدن گرفته می‌شه و کش می‌مونه
let BOT_USERNAME = '';
bot.getMe().then(function(me) { BOT_USERNAME = me.username; }).catch(function() {});

const REFERRAL_BONUS = 8000;
function referralLink(chatId) {
  return 'https://t.me/' + (BOT_USERNAME || '') + '?start=ref_' + chatId;
}

// پرداختِ پاداشِ رفرال — دقیقاً همون لحظه‌ای که شمارهٔ ایرانیِ فردِ رفرال‌شده
// تأیید می‌شه (نه صرفاً کلیک روی لینک). فقط یک‌بار برای هر کاربر پرداخت می‌شه.
async function creditReferralIfNeeded(chatId) {
  const u = db.prepare('SELECT referred_by, referral_paid FROM bot_users WHERE chat_id=?').get(String(chatId));
  if (!u || !u.referred_by || u.referral_paid) return;
  db.prepare('UPDATE bot_users SET referral_paid=1 WHERE chat_id=?').run(String(chatId)); // اول قفلش کن، بعد پرداخت

  const refChatId = u.referred_by;
  if (isAdmin(refChatId)) {
    try { await bot.sendMessage(refChatId, '🎉 یه نفر جدید از لینکِ رفرالِ شما وارد بات شد و شماره‌شو تأیید کرد!'); } catch (e) {}
    return;
  }
  const referrer = db.prepare('SELECT * FROM resellers WHERE telegram_id=? AND is_active=1').get(refChatId);
  if (!referrer) return; // رفرال‌دهنده دیگه معتبر نیست (حذف/غیرفعال شده)

  db.prepare('UPDATE resellers SET balance = balance + ? WHERE id=?').run(REFERRAL_BONUS, referrer.id);
  db.prepare("INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, 'credit', ?, ?)")
    .run(referrer.id, REFERRAL_BONUS, 'پاداش رفرال — کاربر جدید');
  try {
    await bot.sendMessage(refChatId,
      '🎉 پاداشِ رفرال!\n\n' +
      '💰 ' + formatNum(REFERRAL_BONUS) + ' تومان به کیف‌پولت اضافه شد (یه نفر جدید از لینکِ رفرالت اومد).');
  } catch (e) {}
}
const state = {};

function setState(chatId, s) { state[chatId] = s; }
function getState(chatId) { return state[chatId] || {}; }
function clearState(chatId) { delete state[chatId]; }
function isAdmin(chatId) { return ADMIN_IDS.includes(String(chatId)); }
function getReseller(chatId) {
  return db.prepare('SELECT * FROM resellers WHERE telegram_id = ? AND is_active = 1').get(String(chatId));
}
function gbToBytes(gb) { return gb * 1024 * 1024 * 1024; }
function bytesToGb(b) { return (b / 1024 / 1024 / 1024).toFixed(2); }
function formatNum(b) { return Number(b || 0).toLocaleString('fa-IR'); }
function randomPass() { return Math.random().toString(36).substring(2, 10); }

// مبالغِ آمادهٔ شارژ از settings (نصب‌کننده می‌پرسد؛ ادمین از پنل عوض می‌کند)
function chargeAmounts() {
  const r = db.prepare("SELECT value FROM settings WHERE key='charge_amounts'").get();
  const list = (r ? String(r.value) : '500000,1000000,2000000,5000000')
    .split(',').map(function(x) { return parseInt(String(x).trim(), 10); })
    .filter(function(x) { return Number.isFinite(x) && x > 0; });
  return list.length ? list : [500000, 1000000, 2000000, 5000000];
}

// متنِ تعرفه‌ها از پلن‌های فعال
function planListText() {
  const ps = activePlans();
  if (!ps.length) return '❌ فعلاً پلنی تعریف نشده.';
  let t = '💎 تعرفه‌های پنل نمایندگی\n\n';
  for (const p of ps) {
    t += '▪️ ' + p.name + '\n   💰 ' + formatNum(p.price) + ' تومان' +
         (p.billing === 'monthly' ? ' / ماه' : '') + '\n   ' + describePlan(p) + '\n';
    if (p.description) t += '   ' + p.description + '\n';
    t += '\n';
  }
  return t.trim();
}

// دکمهٔ اینلاین برای هر پلن
function planButton(prefix) {
  return function(p) {
    return [{
      text: p.name + ' — ' + formatNum(p.price) + ' ت' + (p.billing === 'monthly' ? '/ماه' : '') +
            (p.traffic_gb > 0 ? ' (' + p.traffic_gb + 'GB)' : ' (نامحدود)'),
      callback_data: prefix + p.key,
      style: 'primary',
    }];
  };
}

const adminMenu = {
  reply_markup: {
    keyboard: [
      [{ text: '👥 نمایندگان', style: 'primary' }, { text: '🛒 درخواست‌های خرید', style: 'primary' }],
      [{ text: '💰 شارژ دستی', style: 'success' }, { text: '📊 آمار کلی', style: 'primary' }],
      [{ text: '📋 تراکنش‌ها', style: 'primary' }, { text: '📢 پیام همگانی', style: 'primary' }],
      [{ text: '⚙️ تنظیمات بات', style: 'primary' }, { text: '🔄 همه کاربران', style: 'primary' }],
      [{ text: '🖼 بنر تبلیغاتی', style: 'success' }, { text: '📢 کانال من', style: 'primary' }],
      [{ text: '🔗 لینک رفرال من', style: 'success' }],
      [{ text: '🔄 بروزرسانی منو', style: 'primary' }],
    ],
    resize_keyboard: true
  }
};

function resellerMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '💰 کیف پول', style: 'success' }, { text: '➕ کاربر جدید', style: 'primary' }],
        [{ text: '👥 کاربران من', style: 'primary' }, { text: '📊 آمار من', style: 'primary' }],
        [{ text: '🔗 لینک اشتراک', style: 'primary' }, { text: '⚙️ حساب من', style: 'primary' }],
        [{ text: '🛒 شارژ کیف پول', style: 'success' }, { text: '📞 پشتیبانی', style: 'primary' }],
        [{ text: '📢 کانال من', style: 'primary' }],
        [{ text: '🔗 لینک رفرال من', style: 'success' }],
        [{ text: '🔄 بروزرسانی منو', style: 'primary' }],
      ],
      resize_keyboard: true
    }
  };
}

function guestMenu() {
  const rows = [[{ text: '🛒 خرید پنل نمایندگی', style: 'success' }]];
  if (testEnabled()) rows.push([{ text: '🧪 تست رایگان', style: 'primary' }]);
  rows.push([{ text: '📋 تعرفه‌ها', style: 'primary' }, { text: '❓ راهنما', style: 'primary' }], [{ text: '📞 پشتیبانی', style: 'primary' }]);
  rows.push([{ text: '🔄 بروزرسانی منو', style: 'primary' }]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

// ── تستِ رایگان ──────────────────────────────────────────────
// هر شمارهٔ ایرانی یک‌بار. شماره را از خودِ تلگرام می‌گیریم
// (request_contact) نه از تایپِ کاربر، پس قابلِ جعل نیست.
function setting(key, dflt) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r && r.value !== '' && r.value != null ? r.value : dflt;
}
function testEnabled() { return String(setting('test_enabled', '1')) === '1'; }
function testGb() { const v = parseFloat(setting('test_traffic_gb', '10')); return Number.isFinite(v) && v > 0 ? v : 10; }
function testDays() { const v = parseInt(setting('test_days', '1')); return Number.isFinite(v) && v >= 0 ? v : 1; }
function testMaxClients() { const v = parseInt(setting('test_max_clients', '5')); return Number.isFinite(v) && v >= 0 ? v : 5; }

// تلگرام شماره را بدونِ + و گاهی با ۰ ابتدایی می‌دهد؛ همه را به 98XXXXXXXXXX
// نرمال می‌کنیم تا «۰۹۱۲…» و «+۹۸۹۱۲…» دو رکوردِ متفاوت نشوند.
function normalizeIranPhone(raw) {
  let p = String(raw || '').replace(/[^\d]/g, '');
  if (p.startsWith('0098')) p = p.slice(4);
  else if (p.startsWith('98')) p = p.slice(2);
  else if (p.startsWith('0')) p = p.slice(1);
  return /^9\d{9}$/.test(p) ? '98' + p : null;
}
function testClaimOf(phone) {
  return db.prepare('SELECT * FROM test_claims WHERE phone=?').get(phone);
}

// خبر دادن به ادمین. خودِ ربات است، پس کتابخانهٔ notify لازم ندارد —
// و مهم‌تر: هیچ‌وقت throw نمی‌کند. قبلاً notifyAdmin صدا زده می‌شد که در
// bot.js اصلاً import نشده بود؛ ReferenceError می‌داد و چون *بعد* از ساختِ
// موفقِ تست بود، کاربر پنلش را می‌گرفت و بلافاصله «خطا در ساخت تست» می‌دید.
function tellAdmin(text) {
  try { bot.sendMessage(ADMIN_ID, text).catch(function(){}); } catch (e) { /* هرگز جریان را نشکن */ }
}

// ── متن‌های قابلِ تنظیم توسط ادمین ─────────────────────────
// قبلاً متنِ خوش‌آمد/راهنما/پشتیبانی در کد هاردکد بود — با آیدیِ تلگرامِ
// شخصِ سازنده. یعنی هر خریدارِ این پنل، آیدیِ او را به مشتری‌هایش می‌داد.
// حالا در settings است و ادمین از پنل عوضش می‌کند.
const TEXT_DEFAULTS = {
  bot_welcome:
    '✨ سلام {name}!\n' +
    'به ربات پنل نمایندگی خوش اومدی\n\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '🌐 با پنل نمایندگی چی می‌تونی بکنی؟\n\n' +
    '◉ سابلینک اختصاصی با برند خودت بساز\n' +
    '◉ کاربر VPN اضافه کن\n' +
    '◉ مصرف و انقضا رو لحظه‌ای مانیتور کن\n' +
    '◉ از ربات یا پنل وب مدیریت کن\n\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '💎 نرخ: هر GB = {rate} تومان\n\n' +
    'برای خرید پنل دکمه زیر رو بزن 👇',
  bot_help:
    '❓ راهنمای پنل نمایندگی\n\n' +
    '1️⃣ یک پلن انتخاب کن\n' +
    '2️⃣ پرداخت انجام بده\n' +
    '3️⃣ پس از تایید ادمین پنل فعال میشه\n' +
    '4️⃣ از همین ربات کاربر بساز\n\n' +
    '💡 هر گیگابایت = {rate} تومان',
  bot_support: '📞 پشتیبانی\n\nبرای ارتباط با ما پیام بدید.',
};

// {name} و {rate} تنها جاهایی‌اند که متن به داده‌ی زنده نیاز دارد
function botText(key, vars) {
  const v = setting(key, '');
  let t = (v && String(v).trim()) ? String(v) : TEXT_DEFAULTS[key];
  Object.entries(vars || {}).forEach(function(e) {
    t = t.split('{' + e[0] + '}').join(String(e[1]));
  });
  return t;
}

// سهمیهٔ باقی‌ماندهٔ نماینده بر اساسِ حجمِ *تخصیص‌یافته* به کاربرانش.
// null یعنی سهمیه نامحدود است (traffic_limit_gb=0) و پول محدودش می‌کند.
function remainingQuota(reseller) {
  if (!(reseller.traffic_limit_gb > 0)) return null;
  const allocated = db.prepare(
    'SELECT COALESCE(SUM(traffic_limit_gb),0) AS s FROM clients WHERE reseller_id=? AND traffic_limit_gb > 0'
  ).get(reseller.id).s;
  return Math.max(0, reseller.traffic_limit_gb - allocated);
}

const contactBtn = {
  reply_markup: {
    keyboard: [[{ text: '📱 ارسال شماره من', request_contact: true, style: 'primary' }], [{ text: '❌ انصراف', style: 'danger' }]],
    resize_keyboard: true, one_time_keyboard: true
  }
};

const cancelBtn = {
  reply_markup: {
    keyboard: [[{ text: '❌ انصراف', style: 'danger' }]],
    resize_keyboard: true
  }
};

bot.onText(/\/start(?:\s+(\S+))?/, async function(msg, match) {
  const chatId = msg.chat.id;
  clearState(chatId);
  const isNewUser = !db.prepare('SELECT 1 FROM bot_users WHERE chat_id=?').get(String(chatId));
  db.prepare(`
    INSERT INTO bot_users (chat_id, first_name, username, last_seen)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, last_seen=CURRENT_TIMESTAMP
  `).run(String(chatId), msg.from.first_name || '', msg.from.username || '');

  // کدِ رفرال — فقط بارِ اولی که کاربر با بات آشنا می‌شه ثبت می‌شه (نه هر
  // بارِ /start)، و رفرالِ خودِ آدم به خودش قبول نمی‌شه
  const refParam = match && match[1];
  if (isNewUser && refParam && refParam.startsWith('ref_')) {
    const refChatId = refParam.slice(4);
    if (refChatId && refChatId !== String(chatId)) {
      db.prepare('UPDATE bot_users SET referred_by=? WHERE chat_id=?').run(refChatId, String(chatId));
    }
  }

  if (isAdmin(chatId)) {
    const pending = db.prepare("SELECT COUNT(*) as c FROM purchase_requests WHERE status='pending'").get().c;
    let txt = '👋 خوش اومدی ادمین!\n\n';
    if (pending > 0) txt += '🔔 ' + pending + ' درخواست خرید در انتظار تایید!\n\n';
    txt += 'از منوی زیر استفاده کن:';
    return bot.sendMessage(chatId, txt, adminMenu);
  }
  // گیتِ استارتِ متقابل: باید رباتِ رفرال را استارت کرده باشد
  if (!refGatePassed(chatId)) return sendRefGate(chatId);
  // گیتِ عضویتِ اجباریِ کانال
  if (!(await channelGatePassed(chatId))) return sendChannelGate(chatId);
  const reseller = getReseller(chatId);
  if (reseller) {
    return bot.sendMessage(chatId,
      '👋 خوش اومدی ' + reseller.name + '!\n\n' +
      '💰 موجودی: ' + formatNum(reseller.balance) + ' تومان\n' +
      '📦 ظرفیت باقی: ~' + Math.floor(reseller.balance / rateOf(reseller)) + ' GB',
      resellerMenu()
    );
  }
  const firstName = msg.from.first_name || '';
  return bot.sendMessage(chatId,
    botText('bot_welcome', { name: firstName, rate: formatNum(defaultPricePerGb()) }),
    guestMenu()
  );
});

// ⚠️ هندلرِ جدا لازم است: پیامِ مخاطب متن ندارد و bot.on('message') پایین
// روی `!msg.text` فوراً return می‌کند.
bot.on('contact', async function(msg) {
  const chatId = msg.chat.id;
  if (getState(chatId).step !== 'test_phone') return;
  if (!testEnabled()) { clearState(chatId); return bot.sendMessage(chatId, '❌ تست رایگان غیرفعال است.', guestMenu()); }

  // شماره باید مالِ خودِ فرستنده باشد: تلگرام user_id مخاطب را می‌دهد و اگر
  // کاربر مخاطبِ *دیگری* را forward کند این با فرستنده یکی نیست.
  if (String(msg.contact.user_id || '') !== String(msg.from.id)) {
    return bot.sendMessage(chatId, '❌ باید شمارهٔ خودت را با همان دکمه بفرستی، نه مخاطبِ دیگری.', contactBtn);
  }
  const phone = normalizeIranPhone(msg.contact.phone_number);
  if (!phone) {
    clearState(chatId);
    return bot.sendMessage(chatId, '❌ فقط شمارهٔ موبایلِ ایران (۹۸+) پذیرفته می‌شود.', guestMenu());
  }

  await creditReferralIfNeeded(chatId);

  const prev = testClaimOf(phone);
  if (prev) {
    clearState(chatId);
    return bot.sendMessage(chatId,
      '❌ با این شماره قبلاً تست گرفته‌ای (' + (prev.kind === 'panel' ? 'پنل تستی' : 'کانفیگ تستی') + ').\n' +
      'هر شماره فقط یک‌بار.', guestMenu());
  }

  setState(chatId, { step: 'test_pick', phone: phone });
  return bot.sendMessage(chatId,
    '✅ شماره تأیید شد.\n\n' +
    'کدام را می‌خواهی؟ (فقط یکی — بعداً قابلِ تغییر نیست)\n\n' +
    '📦 پنل تستی: خودِ پنلِ نمایندگی را می‌بینی و کاربر می‌سازی\n' +
    '🔗 کانفیگ تستی: یک کانفیگِ آماده برای اتصال\n\n' +
    'هر دو ' + testGb() + ' گیگ' + (testDays() > 0 ? ' و ' + testDays() + ' روزه' : '') + '.',
    { reply_markup: { inline_keyboard: [
      [{ text: '📦 پنل تستی', callback_data: 'test_panel', style: 'primary' }],
      [{ text: '🔗 کانفیگ تستی', callback_data: 'test_config', style: 'primary' }],
    ] } }
  );
});

// عکسِ بنر — شبیهِ الگوی contact بالا، جدا مدیریت می‌شود
bot.on('photo', async function(msg) {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  if (getState(chatId).step !== 'promo_banner_photo') return;
  const st = getState(chatId);
  const fileId = msg.photo[msg.photo.length - 1].file_id; // بزرگ‌ترین سایز
  setState(chatId, { step: 'promo_banner_confirm', banner_text: st.banner_text, banner_photo: fileId });
  return sendPromoPreview(chatId, st.banner_text, fileId);
});

function showBannerPicker(chatId, channelId) {
  const banners = db.prepare('SELECT id, text FROM promo_banners ORDER BY created_at DESC LIMIT 15').all();
  if (!banners.length) {
    return bot.sendMessage(chatId, '📭 هنوز هیچ بنری ذخیره نشده. از ادمین بخواه یکی بسازه.',
      isAdmin(chatId) ? adminMenu : resellerMenu());
  }
  const buttons = banners.map(function(b) {
    const preview = b.text.length > 35 ? b.text.slice(0, 35) + '…' : b.text;
    return [{ text: '📄 ' + preview, callback_data: 'promo_pick_' + b.id, style: 'primary' }];
  });
  buttons.push([{ text: '🔄 تغییر کانال', callback_data: 'promo_channel_reset', style: 'danger' }]);
  return bot.sendMessage(chatId,
    '📢 کانال ذخیره‌شده: ' + channelId + '\n\nکدوم بنر رو بفرستم؟',
    { reply_markup: { inline_keyboard: buttons } });
}


function promoKeyboard(referrerChatId) {
  const link = referrerChatId ? referralLink(referrerChatId) : null;
  return {
    inline_keyboard: [
      link
        ? [{ text: '🆓 تست رایگان', url: link, style: 'success' }]
        : [{ text: '🆓 تست رایگان', callback_data: 'promo_test', style: 'success' }],
      link
        ? [{ text: '🛒 خرید پنل', url: link, style: 'primary' }]
        : [{ text: '🛒 خرید پنل', callback_data: 'promo_buy', style: 'primary' }],
      [{ text: '🎨 شخصی‌سازی', callback_data: 'promo_custom', style: 'primary' }],
    ]
  };
}

async function sendPromoPreview(chatId, text, photoFileId) {
  const opts = { reply_markup: promoKeyboard(chatId) };
  if (photoFileId) await bot.sendPhoto(chatId, photoFileId, { caption: text, ...opts });
  else await bot.sendMessage(chatId, text, opts);
  return bot.sendMessage(chatId, 'پیش‌نمایش بالا 👆 چیکار کنم؟', {
    reply_markup: { inline_keyboard: [
      [{ text: '📢 ذخیره + ارسال به همه', callback_data: 'promo_send_confirm', style: 'success' }],
      [{ text: '💾 فقط ذخیره (برای کانال‌ها)', callback_data: 'promo_save_only', style: 'primary' }],
      [{ text: '❌ لغو', callback_data: 'promo_cancel', style: 'danger' }],
    ] }
  });
}


// ── Countdown Engine ─────────────────────────────────────────
const activeCountdowns = {};

function buildCountdownText(bannerText, endTime, photoFileId) {
  const now = Date.now();
  const remaining = endTime - now;
  const elapsed = endTime - (endTime - (12 * 60 * 60 * 1000)) - now;
  const total = 12 * 60 * 60 * 1000;
  const pct = Math.min(100, Math.max(0, Math.floor(((total - remaining) / total) * 100)));
  
  const filled = Math.floor(pct / 10);
  const empty = 10 - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  
  const icons = ['⏳', '⌛'];
  const colors = ['🟢', '🟡', '🟠', '🔴'];
  const colorIdx = remaining < 30*60*1000 ? 3 : remaining < 2*60*60*1000 ? 2 : remaining < 4*60*60*1000 ? 1 : 0;
  const icon = icons[Math.floor(Date.now()/1000) % 2];
  const color = colors[colorIdx];
  
  const totalSec = Math.max(0, Math.floor(remaining / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const timeStr = String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
  
  const endDate = new Date(endTime);
  const endStr = String(endDate.getHours()).padStart(2,'0')+':'+String(endDate.getMinutes()).padStart(2,'0')+':'+String(endDate.getSeconds()).padStart(2,'0');

  return color + ' <b>پیشنهاد ویژه</b>\n\n' +
    icon + ' شمارش معکوس...\n\n' +
    '<code>' + bar + ' ' + pct + '%</code>\n\n' +
    '⏳ <b>زمان باقی‌مانده:</b>\n' +
    '<code>' + timeStr + '</code>\n\n' +
    '🎯 فقط تا ساعت <b>' + endStr + '</b>\n\n' +
    '━━━━━━━━━━━━━━━\n' +
    bannerText + '\n' +
    '━━━━━━━━━━━━━━━\n' +
    '⚠️ با پایان شمارش، این قیمت حذف می‌شود.';
}

function startCountdown(st, finalBannerId) {
  const { channel_id, banner_text, photo_file_id, sent_msg_id, end_time } = st;
  const endTime = parseInt(end_time);
  const key = channel_id + '_' + sent_msg_id;
  let finalBannerSent = false;

  if (activeCountdowns[key]) clearInterval(activeCountdowns[key]);

  async function update() {
    const now = Date.now();
    const remaining = endTime - now;

    // نیم ساعت مونده — بنر پایانی بفرست
    if (!finalBannerSent && remaining <= 30 * 60 * 1000 && finalBannerId) {
      finalBannerSent = true;
      const finalBanner = db.prepare('SELECT * FROM promo_banners WHERE id=?').get(finalBannerId);
      if (finalBanner) {
        try {
          if (finalBanner.photo_file_id) await bot.sendPhoto(channel_id, finalBanner.photo_file_id, { caption: finalBanner.text, reply_markup: promoKeyboard(null) });
          else await bot.sendMessage(channel_id, finalBanner.text, { reply_markup: promoKeyboard(null) });
        } catch(e) { console.error('final banner error:', e.message); }
      }
    }

    if (remaining <= 0) {
      clearInterval(activeCountdowns[key]);
      delete activeCountdowns[key];
      // پیام پایان
      const endMsg = '✅ <b>زمان پیشنهاد ویژه به پایان رسید.</b>\n\n🔔 برای اطلاع از پیشنهادهای بعدی در کانال بمانید.';
      try {
        if (sent_msg_id) {
          if (photo_file_id) await bot.editMessageCaption(endMsg, { chat_id: channel_id, message_id: sent_msg_id, parse_mode: 'HTML' });
          else await bot.editMessageText(endMsg, { chat_id: channel_id, message_id: sent_msg_id, parse_mode: 'HTML' });
        }
      } catch(e) {}
      return;
    }

    const newText = buildCountdownText(banner_text, endTime, photo_file_id);
    try {
      if (sent_msg_id) {
        if (photo_file_id) await bot.editMessageCaption(newText, { chat_id: channel_id, message_id: sent_msg_id, parse_mode: 'HTML' });
        else await bot.editMessageText(newText, { chat_id: channel_id, message_id: sent_msg_id, parse_mode: 'HTML' });
      }
    } catch(e) {
      if (!e.message.includes('not modified')) console.error('countdown edit error:', e.message);
    }
  }

  // interval: تا ۵ دقیقه آخر هر ۱۰ ثانیه، بعدش هر ۱ ثانیه
  const tick = endTime - Date.now() <= 5 * 60 * 1000 ? 1000 : 10000;
  activeCountdowns[key] = setInterval(async function() {
    const rem = endTime - Date.now();
    // switch به ۱ ثانیه وقتی ۵ دقیقه مونده
    if (rem <= 5 * 60 * 1000 && activeCountdowns[key]._idleTimeout !== 1000) {
      clearInterval(activeCountdowns[key]);
      activeCountdowns[key] = setInterval(update, 1000);
    }
    await update();
  }, tick);

  update(); // اولین آپدیت فوری
}

// ادمین: تنظیمِ کانالِ عضویتِ اجباری
bot.onText(/^\/forcechannel(?:\s+(\S+))?/, function(msg, match) {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return;
  const arg = match && match[1];
  if (!arg) {
    const cur = getSetting('force_channel');
    return bot.sendMessage(chatId, '📢 عضویتِ اجباریِ کانال\n\nفعلی: ' + (cur || '(خاموش)') + '\n\nتنظیم:  /forcechannel @channel\nخاموش:  /forcechannel off\n\n⚠️ ربات باید ادمینِ آن کانال باشد تا بتواند عضویت را بررسی کند؛ وگرنه گیت باز می‌ماند.');
  }
  if (arg === 'off' || arg === 'حذف' || arg === '0') {
    setSetting('force_channel', '');
    return bot.sendMessage(chatId, '✅ عضویتِ اجباری خاموش شد.', adminMenu);
  }
  const ch = arg.startsWith('@') ? arg : '@' + String(arg).replace(/^@/, '');
  setSetting('force_channel', ch);
  return bot.sendMessage(chatId, '✅ عضویتِ اجباری روی ' + ch + ' فعال شد.\n⚠️ حتماً ربات را ادمینِ ' + ch + ' کن، وگرنه نمی‌تواند عضویت را چک کند.', adminMenu);
});

bot.on('message', async function(msg) {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  // گیتِ استارتِ متقابل با رباتِ رفرال
  if (!isAdmin(chatId) && !refGatePassed(chatId)) return sendRefGate(chatId);
  if (!isAdmin(chatId) && !(await channelGatePassed(chatId))) return sendChannelGate(chatId);
  const text = msg.text.trim();
  const st = getState(chatId);

  if (text === '❌ انصراف') {
    clearState(chatId);
    if (isAdmin(chatId)) return bot.sendMessage(chatId, 'لغو شد.', adminMenu);
    const r = getReseller(chatId);
    if (r) return bot.sendMessage(chatId, 'لغو شد.', resellerMenu());
    return bot.sendMessage(chatId, 'لغو شد.', guestMenu());
  }

  if (text === '🔄 بروزرسانی منو') {
    if (isAdmin(chatId)) return bot.sendMessage(chatId, '✅ منو بروز شد.', adminMenu);
    const r = getReseller(chatId);
    if (r) return bot.sendMessage(chatId, '✅ منو بروز شد.', resellerMenu());
    return bot.sendMessage(chatId, '✅ منو بروز شد.', guestMenu());
  }

  if (text === '📢 کانال من') {
    const isAdm = isAdmin(chatId);
    const rs = getReseller(chatId);
    if (!isAdm && !rs) return; // فقط ادمین/نماینده
    const channelId = isAdm ? getSetting('admin_promo_channel') : rs.promo_channel_id;
    if (!channelId) {
      setState(chatId, { step: 'set_promo_channel' });
      return bot.sendMessage(chatId,
        '📢 آیدی عددی یا یوزرنیمِ کانالت رو بفرست (مثلاً @mychannel یا -1001234567890).\n\n' +
        '⚠️ قبلش باید ربات رو ادمین همون کانال کرده باشی، وگرنه نمی‌تونه پست کنه.',
        cancelBtn);
    }
    return showBannerPicker(chatId, channelId);
  }

  if (text === '🔗 لینک رفرال من') {
    if (!isAdmin(chatId) && !getReseller(chatId)) return;
    return bot.sendMessage(chatId,
      '🔗 لینکِ رفرالِ شخصیِ تو:\n\n' + referralLink(chatId) + '\n\n' +
      'به‌ازای هر کسی که از این لینک وارد بات بشه و شمارهٔ ایرانیشو تأیید کنه، ' +
      formatNum(REFERRAL_BONUS) + ' تومان به کیف‌پولت اضافه می‌شه.');
  }

  if (st.step === 'set_promo_channel') {
    const isAdm = isAdmin(chatId);
    const rs = getReseller(chatId);
    if (!isAdm && !rs) { clearState(chatId); return; }
    if (isAdm) setSetting('admin_promo_channel', text);
    else db.prepare('UPDATE resellers SET promo_channel_id=? WHERE id=?').run(text, rs.id);
    clearState(chatId);
    await bot.sendMessage(chatId, '✅ کانال ذخیره شد.');
    return showBannerPicker(chatId, text);
  }

  if (st.step === 'countdown_end_time') {
    // پارس ساعت ورودی مثل 17:05:05
    const parts = text.trim().split(':');
    if (parts.length < 2) return bot.sendMessage(chatId, '❌ فرمت اشتباهه. مثال: 17:05:05', cancelBtn);
    const endTime = new Date();
    endTime.setHours(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]||0), 0);
    if (endTime <= new Date()) return bot.sendMessage(chatId, '❌ این ساعت گذشته! یه ساعت آینده بده.', cancelBtn);
    setState(chatId, { ...st, step: 'countdown_final_ask', end_time: endTime.getTime() });
    // انتخاب بنر پایانی
    const banners = db.prepare('SELECT id, text FROM promo_banners ORDER BY created_at DESC LIMIT 10').all();
    const buttons = banners.map(function(b) {
      const preview = b.text.length > 35 ? b.text.slice(0,35)+'…' : b.text;
      return [{ text: '📄 '+preview, callback_data: 'countdown_final_'+b.id }];
    });
    buttons.push([{ text: '⏭ بدون بنر پایانی', callback_data: 'countdown_final_banner_skip' }]);
    return bot.sendMessage(chatId,
      '🎁 کدوم بنر رو نیم ساعت مونده بفرستم؟ (بنر ویژه پایانی)',
      { reply_markup: { inline_keyboard: buttons } });
  }

  if (isAdmin(chatId)) return handleAdmin(chatId, text, st, msg);
  const reseller = getReseller(chatId);
  if (reseller) return handleReseller(chatId, text, st, reseller, msg);
  return handleGuest(chatId, text, st, msg);
});

async function handleGuest(chatId, text, st, msg) {
  // شمارهٔ تایپ‌شده قبول نیست: فقط شماره‌ای که خودِ تلگرام تأیید کند
  if (st.step === 'test_phone') {
    return bot.sendMessage(chatId,
      '📱 شماره را تایپ نکن — دکمهٔ «ارسال شماره من» را بزن تا تلگرام تأییدش کند.',
      contactBtn);
  }
  if (text === '🧪 تست رایگان') {
    if (!testEnabled()) return bot.sendMessage(chatId, '❌ تست رایگان فعلاً غیرفعال است.', guestMenu());
    setState(chatId, { step: 'test_phone' });
    return bot.sendMessage(chatId,
      '🧪 تست رایگان\n\n' +
      'برای جلوگیری از سوءاستفاده، هر شمارهٔ موبایل فقط یک‌بار می‌تواند تست بگیرد.\n' +
      'دکمهٔ زیر را بزن تا شماره‌ات از تلگرام تأیید شود 👇',
      contactBtn
    );
  }
  if (text === '📋 تعرفه‌ها') {
    return bot.sendMessage(chatId,
      planListText(),
      guestMenu()
    );
  }
  if (text === '❓ راهنما') {
    return bot.sendMessage(chatId,
      botText('bot_help', { rate: formatNum(defaultPricePerGb()) }),
      guestMenu()
    );
  }
  if (text === '📞 پشتیبانی') {
    return bot.sendMessage(chatId,
      botText('bot_support'),
      guestMenu()
    );
  }
  if (text === '🛒 خرید پنل نمایندگی') {
    const ps = activePlans();
    if (!ps.length) return bot.sendMessage(chatId, '❌ فعلاً پلنی برای فروش تعریف نشده. بعداً سر بزن.', guestMenu());
    return bot.sendMessage(chatId, '🛒 پلن مورد نظرت رو انتخاب کن:', {
      reply_markup: { inline_keyboard: ps.map(planButton('buy_')) }
    });
  }
  if (st.step === 'waiting_receipt') {
    const req = st.purchase_req;
    db.prepare('UPDATE purchase_requests SET card_receipt = ?, status = ? WHERE id = ?').run(text, 'pending', req.id);
    clearState(chatId);
    const fromUser = msg.from;
    const userName = (fromUser.first_name || '') + (fromUser.last_name ? ' ' + fromUser.last_name : '');
    await bot.sendMessage(ADMIN_ID,
      '🔔 درخواست خرید جدید!\n\n' +
      '👤 نام: ' + userName + '\n' +
      '📱 آیدی: ' + chatId + '\n' +
      '📦 پلن: ' + req.plan_name + '\n' +
      '💰 مبلغ: ' + formatNum(req.amount) + ' تومان\n' +
      '🧾 رسید: ' + text,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ تایید', callback_data: 'approve_req_' + req.id, style: 'success' },
            { text: '❌ رد', callback_data: 'reject_req_' + req.id, style: 'danger' },
          ]]
        }
      }
    );
    return bot.sendMessage(chatId, '✅ رسید ثبت شد!\n\n⏳ در انتظار تایید ادمین...\nمعمولا چند دقیقه طول میکشه.', guestMenu());
  }
}

async function handleAdmin(chatId, text, st, msg) {
  if (text === '🛒 درخواست‌های خرید') {
    const reqs = db.prepare("SELECT * FROM purchase_requests WHERE status='pending' ORDER BY created_at DESC").all();
    if (!reqs.length) return bot.sendMessage(chatId, '✅ هیچ درخواست در انتظاری وجود ندارد.', adminMenu);
    for (const r of reqs) {
      await bot.sendMessage(chatId,
        '📋 درخواست #' + r.id + '\n\n' +
        '👤 آیدی: ' + r.telegram_id + '\n' +
        '📦 پلن: ' + r.plan_name + '\n' +
        '💰 مبلغ: ' + formatNum(r.amount) + ' تومان\n' +
        '💳 روش: ' + (r.payment_method === 'card' ? 'کارت به کارت' : 'ارز دیجیتال') + '\n' +
        '🧾 رسید: ' + (r.card_receipt || r.plisio_invoice_id || '-') + '\n' +
        '🕐 ' + r.created_at,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ تایید', callback_data: 'approve_req_' + r.id, style: 'success' },
              { text: '❌ رد', callback_data: 'reject_req_' + r.id, style: 'danger' },
            ]]
          }
        }
      );
    }
    return;
  }
  if (text === '👥 نمایندگان') {
    const list = db.prepare('SELECT * FROM resellers ORDER BY created_at DESC').all();
    if (!list.length) return bot.sendMessage(chatId, 'هیچ نماینده‌ای ثبت نشده.', adminMenu);
    for (const r of list) {
      await bot.sendMessage(chatId,
        (r.is_active ? '🟢' : '🔴') + ' ' + r.name + ' (@' + r.username + ')\n' +
        '💰 موجودی: ' + formatNum(r.balance) + ' تومان\n' +
        '👥 کاربران: ' + r.current_clients + '\n' +
        '📱 تلگرام: ' + (r.telegram_id || 'ندارد'),
        {
          reply_markup: {
            inline_keyboard: [[
              { text: r.is_active ? '🔴 غیرفعال' : '🟢 فعال', callback_data: 'toggle_r_' + r.id, style: r.is_active ? 'danger' : 'success' },
              { text: '💰 شارژ', callback_data: 'charge_' + r.id, style: 'primary' },
              { text: '🗑 حذف', callback_data: 'del_r_' + r.id, style: 'danger' },
            ]]
          }
        }
      );
    }
    return;
  }
  if (text === '💰 شارژ دستی') {
    const list = db.prepare('SELECT id, name, balance FROM resellers WHERE is_active=1 ORDER BY name').all();
    if (!list.length) return bot.sendMessage(chatId, 'نماینده‌ای وجود ندارد.', adminMenu);
    const buttons = list.map(function(r) {
      return [{ text: r.name + ' (' + formatNum(r.balance) + ' ت)', callback_data: 'charge_' + r.id, style: 'primary' }];
    });
    return bot.sendMessage(chatId, 'نماینده را انتخاب کن:', { reply_markup: { inline_keyboard: buttons } });
  }
  if (st.step === 'charge_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, 'مبلغ معتبر وارد کن:', cancelBtn);
    setState(chatId, { step: 'charge_desc', reseller_id: st.reseller_id, amount: amount });
    return bot.sendMessage(chatId, 'توضیحات (یا بنویس -):', cancelBtn);
  }
  if (st.step === 'charge_desc') {
    const desc = text === '-' ? 'شارژ دستی ادمین' : text;
    const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(st.reseller_id);
    db.prepare('UPDATE resellers SET balance = balance + ? WHERE id = ?').run(st.amount, st.reseller_id);
    db.prepare('INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, ?, ?, ?)').run(st.reseller_id, 'credit', st.amount, desc);
    clearState(chatId);
    if (r.telegram_id) {
      try { await bot.sendMessage(r.telegram_id, '💰 کیف پول شارژ شد!\nمبلغ: ' + formatNum(st.amount) + ' تومان\nموجودی جدید: ' + formatNum(r.balance + st.amount) + ' تومان'); } catch(e) {}
    }
    return bot.sendMessage(chatId, '✅ ' + r.name + ' شارژ شد! موجودی جدید: ' + formatNum(r.balance + st.amount) + ' تومان', adminMenu);
  }
  if (text === '📊 آمار کلی') {
    const totalR = db.prepare('SELECT COUNT(*) as c FROM resellers').get().c;
    const activeR = db.prepare('SELECT COUNT(*) as c FROM resellers WHERE is_active=1').get().c;
    const totalC = db.prepare('SELECT COUNT(*) as c FROM clients').get().c;
    const activeC = db.prepare('SELECT COUNT(*) as c FROM clients WHERE is_active=1').get().c;
    const totalTraffic = db.prepare('SELECT SUM(traffic_used_gb) as t FROM clients').get().t || 0;
    const totalBalance = db.prepare('SELECT SUM(balance) as b FROM resellers').get().b || 0;
    const pendingReqs = db.prepare("SELECT COUNT(*) as c FROM purchase_requests WHERE status='pending'").get().c;
    const totalSales = db.prepare("SELECT SUM(amount) as s FROM purchase_requests WHERE status='approved'").get().s || 0;
    return bot.sendMessage(chatId,
      '📊 آمار کلی\n\n' +
      '👥 نمایندگان: ' + activeR + ' فعال / ' + totalR + ' کل\n' +
      '👤 کاربران: ' + activeC + ' فعال / ' + totalC + ' کل\n' +
      '📶 مصرف کل: ' + Number(totalTraffic).toFixed(2) + ' GB\n' +
      '💰 موجودی کل نمایندگان: ' + formatNum(totalBalance) + ' تومان\n' +
      '💵 کل فروش: ' + formatNum(totalSales) + ' تومان\n' +
      '🔔 درخواست در انتظار: ' + pendingReqs,
      adminMenu
    );
  }
  if (text === '📋 تراکنش‌ها') {
    const txns = db.prepare('SELECT t.*, r.name as rname FROM transactions t LEFT JOIN resellers r ON t.reseller_id = r.id ORDER BY t.created_at DESC LIMIT 20').all();
    if (!txns.length) return bot.sendMessage(chatId, 'تراکنشی ثبت نشده.', adminMenu);
    let txt = 'آخرین 20 تراکنش:\n\n';
    for (const t of txns) {
      txt += (t.type === 'credit' ? '💚 +' : '🔴 -') + formatNum(t.amount) + ' | ' + t.rname + ' | ' + (t.description || '-') + '\n';
    }
    return bot.sendMessage(chatId, txt, adminMenu);
  }
  if (text === '📢 پیام همگانی') {
    setState(chatId, { step: 'broadcast_msg' });
    return bot.sendMessage(chatId, 'پیام خود را بنویس (به همه نمایندگان فعال ارسال میشه):', cancelBtn);
  }
  if (st.step === 'broadcast_msg') {
    const resellers = db.prepare("SELECT telegram_id FROM resellers WHERE is_active=1 AND telegram_id IS NOT NULL").all();
    let sent = 0, failed = 0;
    for (const r of resellers) {
      try { await bot.sendMessage(r.telegram_id, '📢 پیام از ادمین:\n\n' + text); sent++; } catch(e) { failed++; }
    }
    clearState(chatId);
    return bot.sendMessage(chatId, '✅ ارسال شد!\nموفق: ' + sent + ' | ناموفق: ' + failed, adminMenu);
  }
  if (text === '🖼 بنر تبلیغاتی') {
    setState(chatId, { step: 'promo_banner_text' });
    return bot.sendMessage(chatId,
      '🖼 متنِ بنر رو بنویس (با ایموجی/فرمت‌بندی که می‌خوای دقیقاً همون‌جوری فرستاده می‌شه):',
      cancelBtn);
  }
  if (st.step === 'promo_banner_text') {
    setState(chatId, { step: 'promo_banner_photo', banner_text: text });
    return bot.sendMessage(chatId,
      '🖼 اگه می‌خوای عکس هم پیوست کنی، همین‌جا بفرستش — وگرنه بنویس «بدون عکس».',
      cancelBtn);
  }
  if (st.step === 'promo_banner_photo') {
    if (text === 'بدون عکس') {
      setState(chatId, { step: 'promo_banner_confirm', banner_text: st.banner_text, banner_photo: null });
      return sendPromoPreview(chatId, st.banner_text, null);
    }
    return bot.sendMessage(chatId, 'یا عکس بفرست یا بنویس «بدون عکس».', cancelBtn);
  }
  if (text === '⚙️ تنظیمات بات') {
    return bot.sendMessage(chatId,
      '⚙️ تنظیمات بات\n\n💳 کارت: ' + (getSetting('card_number') || '-') + '\n👤 صاحب: ' + (getSetting('card_owner') || '-'),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ شماره کارت', callback_data: 'set_card_number', style: 'primary' }],
            [{ text: '✏️ نام صاحب کارت', callback_data: 'set_card_owner', style: 'primary' }],
            [{ text: '✏️ API Key پلیزیو', callback_data: 'set_plisio_key', style: 'primary' }],
          ]
        }
      }
    );
  }
  if (text === '🔄 همه کاربران') {
    const clients = db.prepare('SELECT c.*, r.name as rname FROM clients c LEFT JOIN resellers r ON c.reseller_id = r.id ORDER BY c.created_at DESC LIMIT 30').all();
    if (!clients.length) return bot.sendMessage(chatId, 'کاربری ثبت نشده.', adminMenu);
    let txt = 'آخرین 30 کاربر:\n\n';
    for (const c of clients) {
      txt += (c.is_active ? '🟢' : '🔴') + ' ' + c.username + ' | ' + Number(c.traffic_used_gb || 0).toFixed(1) + '/' + c.traffic_limit_gb + 'GB | ' + c.rname + '\n';
    }
    return bot.sendMessage(chatId, txt, adminMenu);
  }
  if (st.step === 'set_card_number') { setSetting('card_number', text); clearState(chatId); return bot.sendMessage(chatId, '✅ شماره کارت: ' + text, adminMenu); }
  if (st.step === 'set_card_owner') { setSetting('card_owner', text); clearState(chatId); return bot.sendMessage(chatId, '✅ نام صاحب کارت: ' + text, adminMenu); }
  if (st.step === 'set_plisio_key') { setSetting('plisio_api_key', text); clearState(chatId); return bot.sendMessage(chatId, '✅ API Key بروز شد.', adminMenu); }
}

async function handleReseller(chatId, text, st, reseller, msg) {
  if (text === '💰 کیف پول') {
    const txns = db.prepare('SELECT * FROM transactions WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 5').all(reseller.id);
    let txt = '💰 کیف پول\n\nموجودی: ' + formatNum(reseller.balance) + ' تومان\nگیگی: ' + formatNum(rateOf(reseller)) + ' تومان\nظرفیت باقی: ~' + Math.floor(reseller.balance / rateOf(reseller)) + ' GB\n\n';
    if (txns.length) {
      txt += 'آخرین تراکنش‌ها:\n';
      for (const t of txns) { txt += (t.type === 'credit' ? '💚 +' : '🔴 -') + formatNum(t.amount) + ' | ' + (t.description || '-') + '\n'; }
    }
    return bot.sendMessage(chatId, txt, resellerMenu());
  }
  if (text === '📊 آمار من') {
    const total = db.prepare('SELECT COUNT(*) as c FROM clients WHERE reseller_id=?').get(reseller.id).c;
    const active = db.prepare('SELECT COUNT(*) as c FROM clients WHERE reseller_id=? AND is_active=1').get(reseller.id).c;
    const traffic = db.prepare('SELECT SUM(traffic_used_gb) as t FROM clients WHERE reseller_id=?').get(reseller.id).t || 0;
    return bot.sendMessage(chatId,
      '📊 آمار من\n\nکاربران: ' + active + ' فعال / ' + total + ' کل\nمصرف: ' + Number(traffic).toFixed(2) + ' GB\nموجودی: ' + formatNum(reseller.balance) + ' تومان\nظرفیت باقی: ~' + Math.floor(reseller.balance / rateOf(reseller)) + ' GB',
      resellerMenu()
    );
  }
  if (text === '⚙️ حساب من') {
    return bot.sendMessage(chatId,
      '⚙️ حساب من\n\nنام: ' + reseller.name + '\nیوزر: ' + reseller.username + '\nپسورد: ' + (reseller.plain_password || 'نامشخص') + '\nموجودی: ' + formatNum(reseller.balance) + ' تومان\nپنل: http://panelsub.irsna.top/panel',
      resellerMenu()
    );
  }
  if (text === '📞 پشتیبانی') {
    return bot.sendMessage(chatId,
      botText('bot_support'),
      resellerMenu()
    );
  }
  if (text === '🛒 شارژ کیف پول') {
    // شارژِ کیف پول ربطی به پلن‌ها ندارد — مبالغش از settings.charge_amounts می‌آید
    // (نصب‌کننده می‌پرسد). قبلاً اشتباهاً پلن‌های فروشِ پنل را نشان می‌داد.
    const amounts = chargeAmounts();
    const rate = rateOf(reseller);
    return bot.sendMessage(chatId, '💳 مبلغ شارژ را انتخاب کن:', {
      reply_markup: {
        inline_keyboard: amounts.map(function(a) {
          return [{ text: '💰 ' + formatNum(a) + ' تومان', callback_data: 'recharge_' + a, style: 'success' }];
        })
      }
    });
  }
  if (text === '➕ کاربر جدید') {
    if (reseller.balance < rateOf(reseller)) {
      return bot.sendMessage(chatId, '❌ موجودی کافی نیست!\nحداقل ' + formatNum(rateOf(reseller)) + ' تومان نیاز داری.\nموجودی: ' + formatNum(reseller.balance) + ' تومان', resellerMenu());
    }
    let inbounds = [];
    try {
      const allInbounds = await getInbounds();
      const allowed = JSON.parse(reseller.allowed_inbounds || '[]');
      inbounds = allowed.length ? allInbounds.filter(function(i) { return allowed.includes(i.id); }) : allInbounds;
    } catch(e) {
      return bot.sendMessage(chatId, '❌ خطا در اتصال به سرور.', resellerMenu());
    }
    if (!inbounds.length) return bot.sendMessage(chatId, '❌ اینباندی در دسترس نیست.', resellerMenu());
    setState(chatId, { step: 'nc_username', inbounds: inbounds });
    return bot.sendMessage(chatId, '👤 نام کاربری مشتری (انگلیسی، عدد، _ و -):', cancelBtn);
  }
  if (st.step === 'nc_username') {
    if (!/^[a-zA-Z0-9_-]+$/.test(text)) return bot.sendMessage(chatId, '❌ فقط انگلیسی، عدد، _ و -:', cancelBtn);
    const exists = db.prepare('SELECT id FROM clients WHERE username = ? AND reseller_id = ?').get(text, reseller.id);
    if (exists) return bot.sendMessage(chatId, '❌ این نام قبلا استفاده شده:', cancelBtn);
    setState(chatId, { step: 'nc_traffic', inbounds: st.inbounds, username: text });
    return bot.sendMessage(chatId, '📶 حجم ترافیک (GB) — حداکثر با موجودی: ' + Math.floor(reseller.balance / rateOf(reseller)) + ' GB:', cancelBtn);
  }
  if (st.step === 'nc_traffic') {
    const gb = parseFloat(text);
    if (isNaN(gb) || gb <= 0) return bot.sendMessage(chatId, '❌ عدد معتبر:', cancelBtn);
    // ⚠️ ربات سهمیه را اصلاً چک نمی‌کرد و فقط پول را می‌دید؛ روی پنلی که
    //    نرخش صفر است (مثلِ پنلِ تستی) هزینه صفر می‌شد و هیچ محافظی نمی‌ماند.
    //    مثلِ reseller.js تخصیص‌یافته را می‌شماریم، نه مصرف‌شده.
    const avail = remainingQuota(reseller);
    if (avail !== null && gb > avail) {
      return bot.sendMessage(chatId, '❌ حجم کافی نیست!\nباقی‌مانده: ' + avail.toFixed(2) + ' GB از ' + reseller.traffic_limit_gb + ' GB', resellerMenu());
    }
    const cost = gb * rateOf(reseller);
    if (reseller.balance < cost) return bot.sendMessage(chatId, '❌ موجودی کافی نیست!\nهزینه: ' + formatNum(cost) + ' | موجودی: ' + formatNum(reseller.balance), resellerMenu());
    setState(chatId, { step: 'nc_days', inbounds: st.inbounds, username: st.username, traffic_gb: gb, cost: cost });
    return bot.sendMessage(chatId, '📅 اعتبار (روز) — 0 برای نامحدود:', cancelBtn);
  }
  if (st.step === 'nc_days') {
    const days = parseInt(text);
    if (isNaN(days) || days < 0) return bot.sendMessage(chatId, '❌ عدد معتبر:', cancelBtn);
    const inbound = st.inbounds[0];
    if (!inbound) { clearState(chatId); return bot.sendMessage(chatId, '❌ اینباندی در دسترس نیست.', resellerMenu()); }
    const inboundId = inbound.id;
    try {
      const uuid = uuidv4();
      const email = st.username + '_' + reseller.id;
      const expiryTime = days > 0 ? Date.now() + days * 86400000 : 0;
      await addClient(inboundId, { id: uuid, email: email, enable: true, expiryTime: expiryTime, totalGB: gbToBytes(st.traffic_gb), limitIp: 2, flow: '', tgId: 0, subId: uuid.replace(/-/g, '').substring(0, 16) });
      db.prepare('UPDATE resellers SET balance = balance - ?, current_clients = current_clients + 1 WHERE id = ?').run(st.cost, reseller.id);
      db.prepare('INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, ?, ?, ?)').run(reseller.id, 'debit', st.cost, 'کاربر: ' + st.username + ' (' + st.traffic_gb + 'GB)');
      db.prepare('INSERT INTO clients (reseller_id, xui_uuid, xui_inbound_id, username, traffic_limit_gb, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(reseller.id, uuid, inboundId, st.username, st.traffic_gb, days > 0 ? new Date(expiryTime).toISOString() : null);
      clearState(chatId);
      await bot.sendMessage(chatId, '✅ کاربر ساخته شد!\n\n👤 ' + st.username + '\n📶 ' + st.traffic_gb + ' GB\n📅 ' + (days > 0 ? days + ' روز' : 'نامحدود') + '\n💰 هزینه: ' + formatNum(st.cost) + '\n\n🔗 ساب:\nhttps://panelsub.irsna.top/sub/' + uuid, resellerMenu());
    } catch(err) {
      clearState(chatId);
      bot.sendMessage(chatId, '❌ خطا: ' + err.message, resellerMenu());
    }
    return;
  }
  if (text === '👥 کاربران من') {
    const clients = db.prepare('SELECT * FROM clients WHERE reseller_id = ? ORDER BY created_at DESC').all(reseller.id);
    if (!clients.length) return bot.sendMessage(chatId, 'هنوز کاربری نساختی.', resellerMenu());
    for (const c of clients) {
      const used = Number(c.traffic_used_gb || 0).toFixed(2);
      await bot.sendMessage(chatId,
        (c.is_active ? '🟢' : '🔴') + ' ' + c.username + '\n' +
        '📶 ' + used + ' / ' + c.traffic_limit_gb + ' GB\n' +
        '📅 ' + (c.expires_at ? c.expires_at.split('T')[0] : 'نامحدود'),
        {
          reply_markup: {
            inline_keyboard: [[
              { text: c.is_active ? '🔴 قطع' : '🟢 وصل', callback_data: 'c_toggle_' + c.id, style: c.is_active ? 'danger' : 'success' },
              { text: '🔗 لینک', callback_data: 'c_link_' + c.id, style: 'primary' },
              { text: '📊 مصرف', callback_data: 'c_usage_' + c.id, style: 'primary' },
            ]]
          }
        }
      );
    }
    return;
  }
  if (text === '🔗 لینک اشتراک') {
    return bot.sendMessage(chatId, '🔗 لینک‌ها\n\nپنل: http://panelsub.irsna.top/panel\nساب: ' + SUB_BASE_URL + '/\n\nبرای لینک کاربر خاص از «👥 کاربران من» استفاده کن.', resellerMenu());
  }
  if (st.step === 'reseller_waiting_receipt') {
    const req = st.purchase_req;
    db.prepare('UPDATE purchase_requests SET card_receipt = ?, status = ? WHERE id = ?').run(text, 'pending', req.id);
    clearState(chatId);
    const fromUser = msg.from;
    const userName = (fromUser.first_name || '') + (fromUser.last_name ? ' ' + fromUser.last_name : '');
    await bot.sendMessage(ADMIN_ID,
      '🔔 درخواست شارژ از نماینده!\n\n👤 ' + userName + '\n📱 ' + chatId + '\n📦 ' + req.plan_name + '\n💰 ' + formatNum(req.amount) + ' تومان\n🧾 رسید: ' + text,
      { reply_markup: { inline_keyboard: [[{ text: '✅ تایید', callback_data: 'approve_req_' + req.id, style: 'success' }, { text: '❌ رد', callback_data: 'reject_req_' + req.id, style: 'danger' }]] } }
    );
    return bot.sendMessage(chatId, '✅ رسید ثبت شد! در انتظار تایید...', resellerMenu());
  }
}

bot.on('callback_query', async function(query) {
  const chatId = query.message.chat.id;
  const data = query.data;
  const msgId = query.message.message_id;
  await bot.answerCallbackQuery(query.id);

  // گیتِ استارتِ متقابل با رباتِ رفرال
  if (data === 'refgate_check') {
    if (isAdmin(chatId) || refGatePassed(chatId))
      return bot.sendMessage(chatId, '✅ تأیید شد! حالا /start را بزن.');
    return sendRefGate(chatId);
  }
  if (!isAdmin(chatId) && !refGatePassed(chatId)) return sendRefGate(chatId);
  // گیتِ عضویتِ اجباریِ کانال
  if (data === 'chk_join') {
    if (isAdmin(chatId) || (await channelGatePassed(chatId)))
      return bot.sendMessage(chatId, '✅ عضویت تأیید شد! حالا /start را بزن.');
    return sendChannelGate(chatId);
  }
  if (!isAdmin(chatId) && !(await channelGatePassed(chatId))) return sendChannelGate(chatId);

  // ── تستِ رایگان: ساختِ پنل یا کانفیگ ──
  if (data === 'test_panel' || data === 'test_config') {
    const st = getState(chatId);
    if (st.step !== 'test_pick' || !st.phone) return;
    const phone = st.phone;
    // دوباره چک می‌کنیم: بینِ فرستادنِ شماره و زدنِ دکمه ممکن است رکورد
    // ساخته شده باشد (دو تب/دابل‌کلیک). UNIQUE هم پشتش هست.
    if (testClaimOf(phone)) {
      clearState(chatId);
      return bot.sendMessage(chatId, '❌ با این شماره قبلاً تست گرفته‌ای.', guestMenu());
    }
    clearState(chatId);
    const gb = testGb(), days = testDays();
    const tgId = String(query.from.id);
    const suffix = phone.slice(-6);

    try {
      if (data === 'test_panel') {
        if (getReseller(chatId)) return bot.sendMessage(chatId, '✅ تو از قبل پنل داری!', resellerMenu());
        const username = 'test_' + suffix;
        if (db.prepare('SELECT id FROM resellers WHERE username=?').get(username)) {
          return bot.sendMessage(chatId, '❌ پنلِ تستی با این شماره از قبل هست.', guestMenu());
        }
        const password = randomPass();
        const expires = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
        const r = db.prepare(`
          INSERT INTO resellers (username, password, plain_password, name, telegram_id, traffic_limit_gb,
                                 max_clients, price_per_gb, balance, expires_at, is_active, can_create_panels, allowed_inbounds)
          VALUES (?,?,?,?,?,?,?,?,0,?,1,0,'[]')
        `).run(username, bcrypt.hashSync(password, 10), password, 'کاربر تستی', tgId,
               gb, testMaxClients(), 0, expires);
        db.prepare('INSERT INTO test_claims (phone, telegram_id, kind, ref_id) VALUES (?,?,?,?)')
          .run(phone, tgId, 'panel', r.lastInsertRowid);
        await bot.sendMessage(chatId,
          '🎉 پنل تستی فعال شد!\n\n' +
          '👤 یوزر: ' + username + '\n' +
          '🔑 رمز: ' + password + '\n' +
          '📶 ' + gb + ' GB' + (days > 0 ? '\n📅 ' + days + ' روز' : '') + '\n' +
          '👥 تا ' + testMaxClients() + ' کاربر\n\n' +
          '🌐 https://panelsub.irsna.top/panel\n\n' +
          'قیمتِ هر گیگ صفر است، پس آزادانه تست کن. برای نسخهٔ کامل «🛒 خرید پنل نمایندگی» را بزن.',
          resellerMenu());
        tellAdmin('🧪 پنل تستی\n📱 ' + phone + '\n👤 ' + username);
      } else {
        // ⚠️ فعلاً غیرفعال: این مسیر مستقیم رو 3X-UI کلاینت می‌ساخت ولی هیچ‌وقت
        // تو جدولِ clients ثبت نمی‌شد، پس نه تو پنل نه تو گزارش‌ها دیده می‌شد.
        // تا وقتی این مسیر درست وصل نشده به دیتابیس، فقط «پنل تستی» فعاله —
        // از همون‌جا کاربر خودش هر کانفیگی خواست می‌سازه.
        clearState(chatId);
        return bot.sendMessage(chatId,
          '⚠️ فعلاً «کانفیگ تستی» غیرفعاله.\n\n' +
          '«📦 پنل تستی» رو بگیر — از توی خودِ پنل هر کانفیگی که بخوای می‌تونی بسازی.',
          guestMenu());
      }
    } catch (err) {
      // رکوردِ claim فقط بعد از موفقیت ثبت می‌شود، پس شکست شانسِ کاربر را نمی‌سوزاند
      await bot.sendMessage(chatId, '❌ خطا در ساخت تست: ' + err.message + '\nدوباره امتحان کن.', guestMenu());
    }
    return;
  }

  if (data.startsWith('buy_') || data.startsWith('recharge_')) {
    // خریدِ پلن و شارژِ کیف پول دو چیزِ متفاوت‌اند: buy_ کلیدِ پلن می‌فرستد،
    // recharge_ خودِ مبلغ را (از settings.charge_amounts).
    const isRecharge = data.startsWith('recharge_');
    let plan;
    if (isRecharge) {
      const amount = parseInt(data.replace('recharge_', ''), 10);
      if (!chargeAmounts().includes(amount)) return;   // فقط مبالغِ تعریف‌شده
      plan = { key: 'recharge', name: 'شارژ کیف پول', amount: amount };
    } else {
      const p = planByKey(data.replace('buy_', ''));
      if (!p || !p.is_active) return;
      plan = { key: p.key, name: p.name, amount: p.price };
    }
    const fromUser = query.from;
    const fullName = (fromUser.first_name || '') + (fromUser.last_name ? ' ' + fromUser.last_name : '');
    const reqId = db.prepare('INSERT INTO purchase_requests (telegram_id, telegram_username, full_name, plan_key, plan_name, amount, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)').run(String(chatId), fromUser.username || '', fullName, plan.key, plan.name, plan.amount, 'pending').lastInsertRowid;
    return bot.sendMessage(chatId,
      '💳 روش پرداخت:\n\n📦 پلن: ' + plan.name + '\n💰 مبلغ: ' + formatNum(plan.amount) + ' تومان',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💳 کارت به کارت', callback_data: 'pay_card_' + reqId, style: 'primary' }],
            [{ text: '🔗 پرداخت با ارز دیجیتال (Plisio)', callback_data: 'pay_crypto_' + reqId, style: 'primary' }],
            [{ text: '❌ انصراف', callback_data: 'cancel_req_' + reqId, style: 'danger' }],
          ]
        }
      }
    );
  }

  if (data.startsWith('pay_card_')) {
    const reqId = data.split('_')[2];
    const req = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(reqId);
    if (!req) return;
    db.prepare('UPDATE purchase_requests SET payment_method = ? WHERE id = ?').run('card', reqId);
    const cardNum = getSetting('card_number') || '—';
    const cardOwner = getSetting('card_owner') || '—';
    const reseller = getReseller(chatId);
    setState(chatId, { step: reseller ? 'reseller_waiting_receipt' : 'waiting_receipt', purchase_req: req });
    return bot.sendMessage(chatId,
      '💳 کارت به کارت\n\n' +
      '💰 مبلغ: ' + formatNum(req.amount) + ' تومان\n\n' +
      '🏦 شماره کارت:\n' + cardNum + '\n' +
      '👤 ' + cardOwner + '\n\n' +
      '⚠️ بعد از واریز، شماره پیگیری یا آخر 4 رقم کارت را ارسال کن:'
    );
  }

  if (data.startsWith('pay_crypto_')) {
    const reqId = data.split('_')[2];
    const req = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(reqId);
    if (!req) return;
    await bot.sendMessage(chatId, '⏳ در حال ساخت لینک پرداخت...');
    db.prepare('UPDATE purchase_requests SET payment_method = ? WHERE id = ?').run('crypto', reqId);
    const result = await createPlisioInvoice('req_' + reqId, req.amount, 'پنل نمایندگی - ' + req.plan_name);
    if (!result.success) {
      return bot.sendMessage(chatId, '❌ خطا در ساخت لینک: ' + result.error + '\n\nاز کارت به کارت استفاده کن.', {
        reply_markup: { inline_keyboard: [[{ text: '💳 کارت به کارت', callback_data: 'pay_card_' + reqId, style: 'primary' }]] }
      });
    }
    db.prepare('UPDATE purchase_requests SET plisio_invoice_id = ?, plisio_status = ? WHERE id = ?').run(result.txn_id, 'waiting', reqId);
    return bot.sendMessage(chatId,
      '🔗 لینک پرداخت آماده!\n\n💰 ' + formatNum(req.amount) + ' تومان\n⏱ 30 دقیقه معتبر\n\n' + result.invoice_url + '\n\n✅ بعد از پرداخت ادمین تایید میکنه.'
    );
  }

  if (data.startsWith('cancel_req_')) {
    const reqId = data.split('_')[2];
    db.prepare('UPDATE purchase_requests SET status = ? WHERE id = ?').run('cancelled', reqId);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
    const reseller = getReseller(chatId);
    return bot.sendMessage(chatId, 'درخواست لغو شد.', reseller ? resellerMenu() : guestMenu());
  }

  if (data.startsWith('approve_req_') && isAdmin(chatId)) {
    const reqId = data.split('_')[2];
    const req = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(reqId);
    if (!req) return bot.sendMessage(chatId, 'درخواست یافت نشد.');
    if (req.status !== 'pending') return bot.sendMessage(chatId, 'این درخواست قبلا پردازش شده.');
    const plan = planByKey(req.plan_key);
    if (!plan) return bot.sendMessage(chatId, '❌ پلنِ این درخواست دیگر وجود ندارد: ' + req.plan_key);
    const tgId = req.telegram_id;
    let existingReseller = db.prepare('SELECT * FROM resellers WHERE telegram_id = ?').get(tgId);
    if (existingReseller) {
      db.prepare('UPDATE resellers SET balance = balance + ? WHERE id = ?').run(req.amount, existingReseller.id);
      db.prepare('INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, ?, ?, ?)').run(existingReseller.id, 'credit', req.amount, 'شارژ - ' + req.plan_name);
      db.prepare('UPDATE purchase_requests SET status = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?').run('approved', reqId);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      await bot.sendMessage(chatId, '✅ کیف پول ' + existingReseller.name + ' شارژ شد!\n' + formatNum(req.amount) + ' تومان', adminMenu);
      try { await bot.sendMessage(tgId, '✅ کیف پول شارژ شد!\nمبلغ: ' + formatNum(req.amount) + ' تومان\nموجودی جدید: ' + formatNum(existingReseller.balance + req.amount) + ' تومان', resellerMenu()); } catch(e) {}
    } else {
      const username = 'r_' + tgId.toString().slice(-6);
      const password = randomPass();
      const hashed = bcrypt.hashSync(password, 10);
      const fullName = req.full_name || ('نماینده ' + tgId);
      // ⚠️ قبلاً max_clients=0 ست می‌شد و چون reseller.js شرطِ `current>=max` را
      //    چک می‌کرد، 0>=0 درست بود و پنل از لحظهٔ اول قفل می‌شد. حالا ۰ یعنی
      //    بی‌نهایت و مقدارها از پلن می‌آیند — همان منبعی که وب استفاده می‌کند.
      const f = resellerFieldsFromPlan(plan);
      const result = db.prepare('INSERT INTO resellers (username, password, plain_password, name, telegram_id, traffic_limit_gb, max_clients, price_per_gb, balance, expires_at, allowed_inbounds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(username, hashed, password, fullName, tgId, f.traffic_limit_gb, f.max_clients, f.price_per_gb, f.balance, f.expires_at, '[]');
      db.prepare('INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, ?, ?, ?)').run(result.lastInsertRowid, 'credit', req.amount, 'خرید پنل - ' + req.plan_name);
      db.prepare('UPDATE purchase_requests SET status = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?').run('approved', reqId);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      await bot.sendMessage(chatId, '✅ نماینده جدید: ' + fullName + '\nیوزر: ' + username + '\nموجودی: ' + formatNum(req.amount) + ' تومان', adminMenu);
      try {
        await bot.sendMessage(tgId,
          '🎉 پنل نمایندگی شما فعال شد!\n\n' +
          '👤 یوزر: ' + username + '\n' +
          '🔑 پسورد: ' + password + '\n' +
          '📦 ' + describePlan(plan) + '\n' +
          (f.balance > 0 ? '💰 موجودی: ' + formatNum(f.balance) + ' تومان\n' : '') +
          '\n' +
          '🌐 پنل: http://panelsub.irsna.top/panel\n\n' +
          'از همین ربات هم می‌تونی مدیریت کنی 👇',
          resellerMenu()
        );
      } catch(e) {}
    }
    return;
  }

  if (data.startsWith('reject_req_') && isAdmin(chatId)) {
    const reqId = data.split('_')[2];
    const req = db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(reqId);
    if (!req) return;
    db.prepare('UPDATE purchase_requests SET status = ? WHERE id = ?').run('rejected', reqId);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
    await bot.sendMessage(chatId, '❌ درخواست #' + reqId + ' رد شد.', adminMenu);
    try { await bot.sendMessage(req.telegram_id, '❌ درخواست خرید شما تایید نشد.\n\nبرای اطلاعات بیشتر با پشتیبانی تماس بگیر.'); } catch(e) {}
    return;
  }

  if (data.startsWith('toggle_r_') && isAdmin(chatId)) {
    const id = data.split('_')[2];
    const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(id);
    if (!r) return;
    db.prepare('UPDATE resellers SET is_active = ? WHERE id = ?').run(r.is_active ? 0 : 1, id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
    return bot.sendMessage(chatId, (r.is_active ? '🔴 غیرفعال' : '🟢 فعال') + ' شد: ' + r.name, adminMenu);
  }

  if (data.startsWith('del_r_') && isAdmin(chatId)) {
    const id = data.split('_')[2];
    const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(id);
    if (!r) return;
    return bot.sendMessage(chatId, 'حذف ' + r.name + '؟', {
      reply_markup: { inline_keyboard: [[{ text: '✅ بله', callback_data: 'confirm_del_r_' + id, style: 'danger' }, { text: '❌ نه', callback_data: 'cancel', style: 'primary' }]] }
    });
  }

  if (data.startsWith('confirm_del_r_') && isAdmin(chatId)) {
    const id = data.split('_')[3];
    const clients = db.prepare('SELECT * FROM clients WHERE reseller_id = ?').all(id);
    for (const c of clients) { try { await deleteClientXui(c.xui_inbound_id, c.xui_uuid); } catch(e) {} }
    db.prepare('DELETE FROM clients WHERE reseller_id = ?').run(id);
    db.prepare('DELETE FROM transactions WHERE reseller_id = ?').run(id);
    db.prepare('DELETE FROM resellers WHERE id = ?').run(id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
    return bot.sendMessage(chatId, '✅ حذف شد.', adminMenu);
  }

  if (data.startsWith('charge_') && isAdmin(chatId)) {
    const id = data.split('_')[1];
    const r = db.prepare('SELECT * FROM resellers WHERE id = ?').get(id);
    if (!r) return;
    setState(chatId, { step: 'charge_amount', reseller_id: id });
    return bot.sendMessage(chatId, 'مبلغ شارژ برای ' + r.name + ' (تومان):', cancelBtn);
  }

  if (data === 'set_card_number' && isAdmin(chatId)) { setState(chatId, { step: 'set_card_number' }); return bot.sendMessage(chatId, 'شماره کارت جدید:', cancelBtn); }
  if (data === 'set_card_owner' && isAdmin(chatId)) { setState(chatId, { step: 'set_card_owner' }); return bot.sendMessage(chatId, 'نام صاحب کارت:', cancelBtn); }
  if (data === 'set_plisio_key' && isAdmin(chatId)) { setState(chatId, { step: 'set_plisio_key' }); return bot.sendMessage(chatId, 'API Key پلیزیو:', cancelBtn); }

  if (data.startsWith('sel_inbound_')) {
    const reseller = getReseller(chatId);
    if (!reseller) return;
    const st = getState(chatId);
    if (st.step !== 'nc_inbound') return;
    const inboundId = parseInt(data.split('_')[2]);
    const inbound = st.inbounds.find(function(i) { return i.id === inboundId; });
    if (!inbound) return;
    try {
      const uuid = uuidv4();
      const email = st.username + '_' + reseller.id;
      const expiryTime = st.days > 0 ? Date.now() + st.days * 86400000 : 0;
      await addClient(inboundId, { id: uuid, email: email, enable: true, expiryTime: expiryTime, totalGB: gbToBytes(st.traffic_gb), limitIp: 2, flow: '', tgId: 0, subId: uuid.replace(/-/g, '').substring(0, 16) });
      db.prepare('UPDATE resellers SET balance = balance - ?, current_clients = current_clients + 1 WHERE id = ?').run(st.cost, reseller.id);
      db.prepare('INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, ?, ?, ?)').run(reseller.id, 'debit', st.cost, 'کاربر: ' + st.username + ' (' + st.traffic_gb + 'GB)');
      db.prepare('INSERT INTO clients (reseller_id, xui_uuid, xui_inbound_id, username, traffic_limit_gb, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(reseller.id, uuid, inboundId, st.username, st.traffic_gb, st.days > 0 ? new Date(expiryTime).toISOString() : null);
      const subId = uuid.replace(/-/g, '').substring(0, 16);
      clearState(chatId);
      await bot.sendMessage(chatId,
        '✅ کاربر ساخته شد!\n\n👤 ' + st.username + '\n📶 ' + st.traffic_gb + ' GB\n📅 ' + (st.days > 0 ? st.days + ' روز' : 'نامحدود') + '\n💰 هزینه: ' + formatNum(st.cost) + ' تومان\n💳 موجودی باقی: ' + formatNum(reseller.balance - st.cost) + ' تومان\n\n🔗 ساب:\n' + 'https://panelsub.irsna.top/anastia.html?t=' + uuid + '\n\n🌐 صفحه:\nhttp://panelsub.irsna.top/view/' + uuid,
        resellerMenu()
      );
    } catch(err) {
      clearState(chatId);
      bot.sendMessage(chatId, '❌ خطا: ' + err.message, resellerMenu());
    }
    return;
  }

  if (data.startsWith('c_toggle_')) {
    const reseller = getReseller(chatId);
    if (!reseller) return;
    const cId = data.split('_')[2];
    const c = db.prepare('SELECT * FROM clients WHERE id = ? AND reseller_id = ?').get(cId, reseller.id);
    if (!c) return;
    try {
      await toggleClient(c.xui_inbound_id, c.xui_uuid, !c.is_active);
      db.prepare('UPDATE clients SET is_active = ? WHERE id = ?').run(c.is_active ? 0 : 1, c.id);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
      bot.sendMessage(chatId, (c.is_active ? '🔴 قطع' : '🟢 وصل') + ' شد: ' + c.username, resellerMenu());
    } catch(err) { bot.sendMessage(chatId, '❌ خطا: ' + err.message); }
    return;
  }

  if (data.startsWith('c_link_')) {
    const reseller = getReseller(chatId);
    if (!reseller) return;
    const cId = data.split('_')[2];
    const c = db.prepare('SELECT * FROM clients WHERE id = ? AND reseller_id = ?').get(cId, reseller.id);
    if (!c) return;
    const subId = c.xui_uuid.replace(/-/g, '').substring(0, 16);
    bot.sendMessage(chatId, '🔗 لینک‌های ' + c.username + ':\n\nساب:\n' + 'https://panelsub.irsna.top/anastia.html?t=' + c.xui_uuid + '\n\nصفحه:\nhttp://panelsub.irsna.top/view/' + c.xui_uuid);
    return;
  }

  if (data.startsWith('c_usage_')) {
    const reseller = getReseller(chatId);
    if (!reseller) return;
    const cId = data.split('_')[2];
    const c = db.prepare('SELECT * FROM clients WHERE id = ? AND reseller_id = ?').get(cId, reseller.id);
    if (!c) return;
    try {
      const traffic = await getClientTraffic(c.username + '_' + reseller.id);
      const used = traffic ? bytesToGb(traffic.down + traffic.up) : Number(c.traffic_used_gb || 0).toFixed(2);
      bot.sendMessage(chatId, '📊 مصرف ' + c.username + ':\n\n⬇️ دانلود: ' + (traffic ? bytesToGb(traffic.down) : '-') + ' GB\n⬆️ آپلود: ' + (traffic ? bytesToGb(traffic.up) : '-') + ' GB\n📶 کل: ' + used + ' GB\n✅ باقی: ' + Math.max(0, c.traffic_limit_gb - parseFloat(used)).toFixed(2) + ' GB\n📦 کل حجم: ' + c.traffic_limit_gb + ' GB');
    } catch(err) { bot.sendMessage(chatId, '❌ خطا: ' + err.message); }
    return;
  }

  if (data === 'promo_send_confirm') {
    if (!isAdmin(chatId)) return;
    const st = getState(chatId);
    if (st.step !== 'promo_banner_confirm') return;
    clearState(chatId);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(function(){});
    db.prepare('INSERT INTO promo_banners (text, photo_file_id) VALUES (?, ?)').run(st.banner_text, st.banner_photo || null);
    const users = db.prepare('SELECT chat_id FROM bot_users').all();
    let sent = 0, failed = 0;
    for (const u of users) {
      try {
        if (st.banner_photo) await bot.sendPhoto(u.chat_id, st.banner_photo, { caption: st.banner_text, reply_markup: promoKeyboard(chatId) });
        else await bot.sendMessage(u.chat_id, st.banner_text, { reply_markup: promoKeyboard(chatId) });
        sent++;
      } catch (e) { failed++; }
      await new Promise(function(r) { setTimeout(r, 40); }); // رعایتِ محدودیتِ نرخِ ارسالِ تلگرام
    }
    return bot.sendMessage(chatId, '✅ ذخیره و ارسال شد!\nموفق: ' + sent + ' | ناموفق: ' + failed, adminMenu);
  }

  if (data === 'promo_save_only') {
    if (!isAdmin(chatId)) return;
    const st = getState(chatId);
    if (st.step !== 'promo_banner_confirm') return;
    clearState(chatId);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(function(){});
    db.prepare('INSERT INTO promo_banners (text, photo_file_id) VALUES (?, ?)').run(st.banner_text, st.banner_photo || null);
    return bot.sendMessage(chatId, '💾 ذخیره شد — از «📢 کانال من» می‌تونی به کانالت بفرستیش.', adminMenu);
  }

  if (data === 'promo_cancel') {
    clearState(chatId);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(function(){});
    return bot.sendMessage(chatId, 'لغو شد.', isAdmin(chatId) ? adminMenu : guestMenu());
  }

  if (data.startsWith('promo_pick_')) {
    const isAdm = isAdmin(chatId);
    const rs = getReseller(chatId);
    if (!isAdm && !rs) return;
    const channelId = isAdm ? getSetting('admin_promo_channel') : rs.promo_channel_id;
    if (!channelId) return bot.sendMessage(chatId, '❌ اول باید کانال رو ثبت کنی.', isAdm ? adminMenu : resellerMenu());
    const bannerId = data.replace('promo_pick_', '');
    const banner = db.prepare('SELECT * FROM promo_banners WHERE id=?').get(bannerId);
    if (!banner) return bot.sendMessage(chatId, '❌ این بنر دیگه موجود نیست.', isAdm ? adminMenu : resellerMenu());
    try {
      let sentResult;
      if (banner.photo_file_id) sentResult = await bot.sendPhoto(channelId, banner.photo_file_id, { caption: banner.text, reply_markup: promoKeyboard(chatId) });
      else sentResult = await bot.sendMessage(channelId, banner.text, { reply_markup: promoKeyboard(chatId) });
      setState(chatId, { step: "countdown_ask", channel_id: channelId, banner_text: banner.text, photo_file_id: banner.photo_file_id || null, sent_msg_id: sentResult ? sentResult.message_id : null });
      return bot.sendMessage(chatId, "✅ به کانال فرستاده شد!\n\n⏳ می‌خوای شمارش معکوس هم باشه؟", { reply_markup: { inline_keyboard: [
        [{ text: "✅ بله، شمارش معکوس بذار", callback_data: "countdown_yes" }],
        [{ text: "❌ نه، همینجا تموم", callback_data: "countdown_no" }]
      ] } });
    } catch (err) {
      return bot.sendMessage(chatId,
        '❌ ارسال به کانال شکست خورد: ' + err.message + '\n\nمطمئن شو ربات ادمینِ همون کانال و اجازهٔ پست‌کردن رو داره.',
        isAdm ? adminMenu : resellerMenu());
    }
  }

  if (data === 'promo_channel_reset') {
    const isAdm = isAdmin(chatId);
    const rs = getReseller(chatId);
    if (!isAdm && !rs) return;
    if (isAdm) setSetting('admin_promo_channel', '');
    else db.prepare('UPDATE resellers SET promo_channel_id=NULL WHERE id=?').run(rs.id);
    setState(chatId, { step: 'set_promo_channel' });
    return bot.sendMessage(chatId, '📢 آیدی/یوزرنیمِ کانالِ جدید رو بفرست:', cancelBtn);
  }

  if (data === 'promo_test') {
    if (getReseller(chatId)) return bot.sendMessage(chatId, '✅ تو از قبل پنل داری!', resellerMenu());
    if (!testEnabled()) return bot.sendMessage(chatId, '❌ تست رایگان فعلاً غیرفعال است.', guestMenu());
    setState(chatId, { step: 'test_phone' });
    return bot.sendMessage(chatId,
      '🧪 تست رایگان\n\n' +
      'برای جلوگیری از سوءاستفاده، هر شمارهٔ موبایل فقط یک‌بار می‌تواند تست بگیرد.\n' +
      'دکمهٔ زیر را بزن تا شماره‌ات از تلگرام تأیید شود 👇',
      contactBtn
    );
  }

  if (data === 'promo_buy') {
    if (getReseller(chatId)) return bot.sendMessage(chatId, '✅ تو از قبل پنل داری!', resellerMenu());
    const ps = activePlans();
    if (!ps.length) return bot.sendMessage(chatId, '❌ فعلاً پلنی برای فروش تعریف نشده. بعداً سر بزن.', guestMenu());
    return bot.sendMessage(chatId, '🛒 پلن مورد نظرت رو انتخاب کن:', {
      reply_markup: { inline_keyboard: ps.map(planButton('buy_')) }
    });
  }

  if (data === 'promo_custom') {
    return bot.sendMessage(chatId,
      '🎨 شخصی‌سازیِ کامل (رنگ، لوگو، دامنه‌ی اختصاصی) بعد از گرفتنِ پنل نمایندگی از داخلِ پنل خودت در دسترسه.',
      getReseller(chatId) ? resellerMenu() : guestMenu());
  }

  if (data === 'cancel') {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
  }

  if (data === 'countdown_no') {
    clearState(chatId);
    return bot.sendMessage(chatId, '✅ باشه، بنر فرستاده شد.', isAdmin(chatId) ? adminMenu : resellerMenu());
  }

  if (data === 'countdown_yes') {
    const st = getState(chatId);
    if (!st || st.step !== 'countdown_ask') return;
    setState(chatId, { ...st, step: 'countdown_end_time' });
    return bot.sendMessage(chatId,
      '⏰ ساعت پایان شمارش رو بنویس (مثلاً 17:05:05):',
      cancelBtn);
  }

  if (data === 'countdown_final_banner_skip') {
    const st = getState(chatId);
    if (!st) return;
    startCountdown(st, null);
    clearState(chatId);
    return bot.sendMessage(chatId, '✅ شمارش معکوس شروع شد!', isAdmin(chatId) ? adminMenu : resellerMenu());
  }

  if (data.startsWith('countdown_final_')) {
    const st = getState(chatId);
    if (!st) return;
    const finalBannerId = data.replace('countdown_final_', '');
    startCountdown(st, finalBannerId);
    clearState(chatId);
    return bot.sendMessage(chatId, '✅ شمارش معکوس شروع شد!', isAdmin(chatId) ? adminMenu : resellerMenu());
  }
});
// کارمزد ماهانه — هر ساعت چک می‌کنه
const MONTHLY_FEE = 50000;
const MS_30_DAYS = 30 * 24 * 60 * 60 * 1000;
const MS_1_HOUR  = 60 * 60 * 1000;
let feeRunning = false;

function deductMonthlyFees() {
  if (feeRunning) return;
  feeRunning = true;
  try {
    const list = db.prepare("SELECT id, name, telegram_id FROM resellers WHERE is_active=1").all();
    let n = 0;
    for (const r of list) {
      const cur = db.prepare("SELECT balance FROM resellers WHERE id=?").get(r.id);
      if (!cur || cur.balance <= 0) continue;
      const fee = Math.min(MONTHLY_FEE, cur.balance);
      db.prepare("UPDATE resellers SET balance = balance - ? WHERE id=?").run(fee, r.id);
      db.prepare("INSERT INTO transactions (reseller_id, type, amount, description) VALUES (?, 'debit', ?, ?)").run(r.id, fee, "کارمزد ماهانه نگهداری پنل");
      if (r.telegram_id) {
        try { bot.sendMessage(r.telegram_id, "\u{1F514} کارمزد ماهانه پنل\n\n\u{1F4B8} " + formatNum(fee) + " تومان کسر شد\n\u{1F4B0} موجودی: " + formatNum(Math.max(0, cur.balance - fee)) + " تومان"); } catch(e2) {}
      }
      n++;
    }
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('last_monthly_fee', ?)").run(String(Date.now()));
    if (n > 0) console.log("[Fee] done: " + n);
  } finally { feeRunning = false; }
}

setInterval(function() {
  const row = db.prepare("SELECT value FROM bot_settings WHERE key='last_monthly_fee'").get();
  const last = row ? parseInt(row.value) : 0;
  if (Date.now() - last >= MS_30_DAYS) deductMonthlyFees();
}, MS_1_HOUR);

bot.on('polling_error', function(err) { console.error('Polling error:', err.message); });
process.on('unhandledRejection', function(err) { console.error('Unhandled:', err.message); });
console.log('Bot started! Admin: ' + ADMIN_ID);
