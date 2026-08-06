require('dotenv').config({ path: '/opt/xui-reseller/.env', override: true });
const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

const CHANNEL = '@v28pn';

const TEXT = `⚡️ 05/05/05 — 05:05:05 ⚡️

🔥 تخفیف تکرار نشدنی در لحظه تکرار نشدنی 🔥

🚀 پنل کاملاً نامحدود فقط ۹۹۰ هزار تومان

✅ کاربران خودتان: نامحدود
✅ حجم مصرف: نامحدود
✅ قابلیت تنظیم تعداد IP مجاز برای هر کاربر
✅ امکان ساخت ۵ زیرپنل
✅ مجموع ظرفیت کاربران زیرپنل‌ها: ۵۰۰ کاربر

⚠️ توجه: ظرفیت ۵۰۰ کاربر مربوط به مجموع کاربران ساخته‌شده در زیرپنل‌ها است و کاربران اصلی پنل شما شامل این تعداد نمی‌شوند.

✅ مدیریت کامل زیرپنل‌ها
✅ کنترل زمان، حجم، پلن‌ها و کاربران زیرمجموعه‌ها

⏳ 03:00:00

⚠️ این قیمت فقط تا ۳ ساعت فعال است.`;

const ICONS = ['⏳','⌛'];
const COLORS = ['🔴','🟠','🟡','🟢'];
let msgId = null;
let iconIdx = 0;
let colorIdx = 0;

// ساعت پایان = 08:05:05 ایران = 04:35:05 UTC
const END = new Date();
END.setUTCHours(4, 35, 5, 0);
if (END < new Date()) END.setDate(END.getDate() + 1);

function fmt(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms/1000);
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const sec = s%60;
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(sec).padStart(2,'0');
}

function bar(pct) {
  const f = Math.floor(pct/10);
  return '█'.repeat(f)+'░'.repeat(10-f);
}

function buildText() {
  const now = Date.now();
  const rem = END - now;
  const total = 3*60*60*1000;
  const pct = Math.min(100, Math.floor(((total-rem)/total)*100));
  iconIdx = (iconIdx+1)%2;
  colorIdx = rem < 30*60*1000 ? 0 : rem < 60*60*1000 ? 1 : rem < 2*60*60*1000 ? 2 : 3;

  return `${COLORS[colorIdx]} <b>05/05/05 — 05:05:05</b> ${COLORS[colorIdx]}

🔥 <b>تخفیف تکرار نشدنی در لحظه تکرار نشدنی</b> 🔥

${ICONS[iconIdx]} شمارش معکوس...
<code>${bar(pct)} ${pct}%</code>

⏳ <b>زمان باقی‌مانده:</b>
<code>${fmt(rem)}</code>

🚀 <b>پنل کاملاً نامحدود فقط ۹۹۰ هزار تومان</b>

✅ کاربران خودتان: نامحدود
✅ حجم مصرف: نامحدود
✅ قابلیت تنظیم تعداد IP مجاز
✅ امکان ساخت ۵ زیرپنل
✅ مجموع ظرفیت زیرپنل‌ها: ۵۰۰ کاربر

✅ مدیریت کامل زیرپنل‌ها
✅ کنترل زمان، حجم، پلن‌ها

⚠️ با پایان شمارش، این قیمت حذف می‌شود.`;
}

// صبر تا ۵:۰۵:۰۵ ایران = ۰۱:۳۵:۰۵ UTC
const START = new Date();
START.setUTCHours(1, 35, 5, 0);
if (START < new Date()) START.setUTCMinutes(START.getUTCMinutes());

const msUntil = START - Date.now();
console.log('⏰ شروع در', Math.floor(msUntil/1000), 'ثانیه دیگه...');

setTimeout(async () => {
  console.log('🚀 ارسال پیام...');
  try {
    const sent = await bot.sendMessage(CHANNEL, buildText(), { parse_mode: 'HTML' });
    msgId = sent.message_id;
    console.log('✅ ارسال شد! ID:', msgId);

    const interval = setInterval(async () => {
      const rem = END - Date.now();
      if (rem <= 0) {
        clearInterval(interval);
        await bot.editMessageText(
          '✅ <b>زمان پیشنهاد ویژه به پایان رسید.</b>\n\n🔔 برای پیشنهادهای بعدی در کانال بمانید.',
          { chat_id: CHANNEL, message_id: msgId, parse_mode: 'HTML' }
        );
        console.log('✅ تموم شد');
        process.exit(0);
        return;
      }

      // نیم ساعت مونده — سرعت آپدیت رو بیشتر کن
      const tickMs = rem <= 5*60*1000 ? 1000 : 10000;

      try {
        await bot.editMessageText(buildText(), {
          chat_id: CHANNEL, message_id: msgId, parse_mode: 'HTML'
        });
      } catch(e) {
        if (!e.message.includes('not modified')) console.error('edit error:', e.message);
      }
    }, 10000);

  } catch(e) {
    console.error('❌ خطا:', e.message);
    process.exit(1);
  }
}, Math.max(0, msUntil));
