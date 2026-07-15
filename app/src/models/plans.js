// ماژولِ پلن‌ها — تنها جایی که «یک پنل یعنی چه» تعریف می‌شود.
// قبلاً ربات و وب دو تعریفِ متفاوت داشتند: ربات موجودی می‌داد (balance=مبلغ،
// max_clients=0) و وب سهمیه (traffic_limit_gb + max_clients، بدونِ موجودی).
// حالا پلن هر دو را دارد و ادمین هرکدام را نخواست صفر می‌گذارد.
const { getDB } = require('./database');

const DEFAULT_RATE = 3500;

// نرخِ پیش‌فرضِ گیگ از settings (برای مهمان و fallback)
function defaultPricePerGb() {
  const r = getDB().prepare("SELECT value FROM settings WHERE key='panel_price_per_gb'").get();
  const v = r ? parseFloat(r.value) : NaN;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RATE;
}

// نرخِ گیگِ یک نمایندهٔ مشخص — نرخِ خودش، وگرنه پیش‌فرض
function rateOf(reseller) {
  const v = reseller && Number(reseller.price_per_gb);
  return Number.isFinite(v) && v > 0 ? v : defaultPricePerGb();
}

// نرخِ ماهانهٔ کاربرِ نامحدود (که نماینده برای کاربرانش می‌پردازد)
function unlimitedMonthly() {
  const r = getDB().prepare("SELECT value FROM settings WHERE key='unlimited_price'").get();
  const v = r ? parseInt(r.value) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 180000;
}

function activePlans() {
  return getDB().prepare('SELECT * FROM plans WHERE is_active=1 ORDER BY sort_order, price').all();
}
function allPlans() {
  return getDB().prepare('SELECT * FROM plans ORDER BY sort_order, price').all();
}
function planByKey(key) {
  return getDB().prepare('SELECT * FROM plans WHERE key=?').get(key);
}

// خلاصهٔ خواناىِ پلن برای ربات/وب — «۰» را به «نامحدود» ترجمه می‌کند
function describePlan(p) {
  const bits = [];
  bits.push(p.traffic_gb > 0 ? `📦 ${p.traffic_gb} GB` : '📦 ترافیک نامحدود');
  if (p.max_clients > 0) bits.push(`👥 تا ${p.max_clients} کاربر`);
  else bits.push('👥 کاربر نامحدود');
  if (p.initial_balance > 0) bits.push(`💰 شارژ اولیه ${Number(p.initial_balance).toLocaleString('fa-IR')} ت`);
  if (p.price_per_gb > 0) bits.push(`💎 هر گیگ ${Number(p.price_per_gb).toLocaleString('fa-IR')} ت`);
  if (p.duration_days > 0) bits.push(`📅 ${p.duration_days} روز`);
  if (p.billing === 'monthly') bits.push('🔄 ماهانه');
  return bits.join(' | ');
}

// مقادیرِ ستون‌های resellers برای یک پلن — تنها منبعِ حقیقت.
// هم admin.js (تأییدِ درخواستِ وب) و هم bot.js از همین استفاده می‌کنند.
function resellerFieldsFromPlan(plan) {
  const expires = plan.duration_days > 0
    ? new Date(Date.now() + plan.duration_days * 86400000).toISOString()
    : null;
  return {
    traffic_limit_gb: Number(plan.traffic_gb) || 0,   // ۰ = نامحدود
    max_clients: Number(plan.max_clients) || 0,       // ۰ = بی‌نهایت
    price_per_gb: Number(plan.price_per_gb) || 0,
    balance: Number(plan.initial_balance) || 0,
    expires_at: expires,
  };
}

module.exports = {
  defaultPricePerGb, rateOf, unlimitedMonthly,
  activePlans, allPlans, planByKey, describePlan, resellerFieldsFromPlan,
};
