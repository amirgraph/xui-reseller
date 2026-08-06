require('dotenv').config({ path: '/opt/xui-reseller/.env', override: true });
const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

const CHANNEL = '@v28pn';

let BOT_USERNAME = null; // از خود API تلگرام گرفته می‌شه (bot.getMe())

function keyboard() {
  return {
    inline_keyboard: [
      [{ text: '🚀 خرید / شروع با ربات', url: `https://t.me/${BOT_USERNAME}`, style: 'primary' }],
    ],
  };
}

const ICONS = ['⏳', '⌛'];
const COLORS = ['🔴', '🟠', '🟡', '🟢'];
const msgId = 99; // همون پیامی که قبلاً فرستاده شده (t.me/v28pn/99) — دیگه پیام جدید نمی‌فرستیم
let iconIdx = 0;

// ایران دائم UTC+3:30 هست (از ۲۰۲۲ ساعت تابستانی حذف شده)
const IRAN_OFFSET_MIN = 3 * 60 + 30;

// همین الان به‌عنوان شروع شمارش
const START = new Date();

// پایان = امروز ساعت ۱۷:۰۰ به وقت ایران
function nextIranClock(hour, minute) {
  const now = new Date();
  // ساعت هدف به وقت ایران -> معادل UTC
  const utcHour = hour - Math.floor(IRAN_OFFSET_MIN / 60);
  const utcMinute = minute - (IRAN_OFFSET_MIN % 60);
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    utcHour, utcMinute, 0, 0
  ));
  if (target < now) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

const END = nextIranClock(17, 5); // 17:05 = 05:05 PM به وقت ایران

function fmt(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function bar(pct) {
  const f = Math.floor(pct / 10);
  return '█'.repeat(f) + '░'.repeat(10 - f);
}

// تبدیل عدد/دو نقطه به کاراکتر فول‌ویدث یونیکد -> باعث می‌شه چند برابر بزرگ‌تر و توپرتر دیده بشه (استایل بنر)
const BIG_MAP = {
  '0': '０', '1': '１', '2': '２', '3': '３', '4': '４',
  '5': '５', '6': '６', '7': '７', '8': '８', '9': '９',
  ':': '：',
};
function big(str) {
  return str.split('').map((c) => BIG_MAP[c] || c).join('');
}

const PULSE = ['✨', '⚡️', '💫', '⭐️'];
const BAR_COLOR = ['🟥', '🟧', '🟨', '🟩']; // هماهنگ با COLORS: هرچی زمان کمتر، قرمزتر

function coloredBar(pct, colorIdx) {
  const filled = Math.floor(pct / 10);
  const square = BAR_COLOR[colorIdx];
  return square.repeat(filled) + '⬜️'.repeat(10 - filled);
}

// ۱۲ مربع = ۱۲ ساعت (۰۵:۰۵ AM تا ۰۵:۰۵ PM) — هر سر ساعت یکی پر می‌شه
const RANGE_MS = 12 * 60 * 60 * 1000;
const RANGE_START = new Date(END.getTime() - RANGE_MS);
function hourSquares() {
  const elapsed = Date.now() - RANGE_START.getTime();
  const filledHours = Math.min(12, Math.max(0, Math.floor(elapsed / (60 * 60 * 1000))));
  return '🟩'.repeat(filledHours) + '⬜️'.repeat(12 - filledHours);
}

const DIV = '▬▬▬▬▬▬▬▬▬▬▬▬▬▬';

function buildText() {
  const now = Date.now();
  const rem = END - now;
  const total = END - START;
  const pct = Math.min(100, Math.max(0, Math.floor(((total - rem) / total) * 100)));
  iconIdx = (iconIdx + 1) % 2;
  const colorIdx = rem < 30 * 60 * 1000 ? 0 : rem < 60 * 60 * 1000 ? 1 : rem < 2 * 60 * 60 * 1000 ? 2 : 3;
  const pulse = PULSE[iconIdx % PULSE.length];

  return `${COLORS[colorIdx]} <b>تخفیف ویژه</b> ${COLORS[colorIdx]}
${DIV}

${pulse} <b>تخفیف تکرار نشدنی در لحظه تکرار نشدنی</b> ${pulse}

${ICONS[iconIdx]} <b>پیشرفت شمارش:</b>
${coloredBar(pct, colorIdx)}
<b>${pct}%</b>
${DIV}

🕐 <b>پیشرفت ساعتی (۱۲ ساعته):</b>
${hourSquares()}

⏳ <b>از ۰۵/۰۵/۰۵ ۰۵:۰۵:۰۵ AM تا ۰۵/۰۵/۰۵ ۰۵:۰۵:۰۵ PM</b>
<b>${big(fmt(rem))}</b>
${DIV}

🚀 <b>پنل کاملاً نامحدود فقط ۹۹۰ هزار تومان</b>

✅ کاربران خودتان: نامحدود
✅ حجم مصرف: نامحدود
✅ قابلیت تنظیم تعداد IP مجاز
✅ امکان ساخت ۵ زیرپنل
✅ مجموع ظرفیت زیرپنل‌ها: ۵۰۰ کاربر

✅ مدیریت کامل زیرپنل‌ها
✅ کنترل زمان، حجم، پلن‌ها
${DIV}

⚠️ با پایان شمارش، این قیمت برای همیشه حذف می‌شود.`;
}

function scheduleTick() {
  const rem = END - Date.now();
  if (rem <= 0) {
    finish();
    return;
  }

  let tickMs;
  if (rem <= 5 * 60 * 1000) {
    // ۵ دقیقهٔ آخر: هر ۱ ثانیه
    tickMs = 1000;
  } else {
    // بقیهٔ زمان: دقیقاً لحظهٔ تعویض دقیقه بعدی (ثانیه = ۰۰) نه ۶۰ ثانیه ثابت از الان
    const now = new Date();
    tickMs = (60 - now.getUTCSeconds()) * 1000 - now.getUTCMilliseconds();
    if (tickMs <= 0) tickMs += 60 * 1000;
  }

  setTimeout(async () => {
    const remNow = END - Date.now();
    if (remNow <= 0) {
      finish();
      return;
    }
    try {
      await bot.editMessageText(buildText(), {
        chat_id: CHANNEL,
        message_id: msgId,
        parse_mode: 'HTML',
        reply_markup: keyboard(),
      });
    } catch (e) {
      if (!e.message.includes('not modified')) console.error('edit error:', e.message);
    }
    scheduleTick();
  }, tickMs);
}

async function finish() {
  try {
    await bot.editMessageText(
      '✅ <b>زمان پیشنهاد ویژه به پایان رسید.</b>\n\n🔔 برای پیشنهادهای بعدی در کانال بمانید.',
      { chat_id: CHANNEL, message_id: msgId, parse_mode: 'HTML' }
    );
    console.log('✅ تموم شد');
  } catch (e) {
    console.error('❌ خطا در پیام پایانی:', e.message);
  } finally {
    process.exit(0);
  }
}

(async () => {
  console.log('🚀 شروع...');
  try {
    const me = await bot.getMe();
    BOT_USERNAME = me.username;
    console.log('🤖 یوزرنیم ربات:', BOT_USERNAME);

    // پیام جدید نمی‌فرستیم؛ مستقیم همون پیام قبلی (msgId=99) رو ادیت می‌کنیم
    await bot.editMessageText(buildText(), {
      chat_id: CHANNEL,
      message_id: msgId,
      parse_mode: 'HTML',
      reply_markup: keyboard(),
    });
    console.log('✅ پیام قبلی ادیت شد، ادامهٔ شمارش...');
    scheduleTick();
  } catch (e) {
    console.error('❌ خطا:', e.message);
    process.exit(1);
  }
})();
