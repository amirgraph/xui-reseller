const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || './data/reseller.db';

let db;

function getDB() {
  if (!db) {
    db = new Database(path.resolve(DB_PATH));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

async function initDB() {
  const db = getDB();

  // Admins table
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      telegram_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Resellers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS resellers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      telegram_id TEXT,
      balance REAL DEFAULT 0,
      traffic_limit_gb REAL DEFAULT 0,
      traffic_used_gb REAL DEFAULT 0,
      max_clients INTEGER DEFAULT 0,
      current_clients INTEGER DEFAULT 0,
      allowed_inbounds TEXT DEFAULT '[]',
      brand_name TEXT DEFAULT '',
      brand_logo TEXT DEFAULT '',
      brand_color TEXT DEFAULT '#6C63FF',
      brand_bg_color TEXT DEFAULT '#0a0a0f',
      sub_domain TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      price_per_gb REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    )
  `);

  // Clients table
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reseller_id INTEGER NOT NULL,
      xui_uuid TEXT UNIQUE NOT NULL,
      xui_inbound_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      email TEXT,
      telegram_id TEXT,
      traffic_limit_gb REAL DEFAULT 0,
      traffic_used_gb REAL DEFAULT 0,
      ip_limit INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      last_sync DATETIME,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id)
    )
  `);

  // Transactions table (wallet)
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reseller_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      client_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id)
    )
  `);

  // Inbounds cache table
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbounds_cache (
      id INTEGER PRIMARY KEY,
      tag TEXT,
      protocol TEXT,
      port INTEGER,
      remark TEXT,
      data TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Bot settings table
  // bot.js از این جدول می‌خواند/می‌نویسد ولی هیچ‌جا نمی‌ساختش — روی سرورِ قدیمی
  // دستی ساخته شده بود، پس هر نصبِ تازه بدونِ آن می‌مرد.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Panel orders — درخواستِ پنل از صفحهٔ وب (نام کاربری/رمز/رسیدِ کارت)
  // نبودش باعثِ «no such table: panel_orders» و ارسال‌نشدنِ رسید می‌شد.
  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      telegram_id TEXT,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      plain_password TEXT,
      card_receipt TEXT,
      amount REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME
    )
  `);

  // Charge requests — شارژِ کیف پولِ نماینده با رسیدِ کارت
  db.exec(`
    CREATE TABLE IF NOT EXISTS charge_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reseller_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      card_receipt TEXT,
      status TEXT DEFAULT 'pending',
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME,
      FOREIGN KEY (reseller_id) REFERENCES resellers(id)
    )
  `);

  // Purchase requests — خریدِ پلن از داخلِ ربات (کارت یا کریپتو/Plisio)
  db.exec(`
    CREATE TABLE IF NOT EXISTS purchase_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      telegram_username TEXT,
      full_name TEXT,
      plan_key TEXT,
      plan_name TEXT,
      amount REAL DEFAULT 0,
      payment_method TEXT,
      card_receipt TEXT,
      status TEXT DEFAULT 'pending',
      plisio_invoice_id TEXT,
      plisio_status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME
    )
  `);

  // Plans — بسته‌هایی که *پنلِ نمایندگی* با آن‌ها فروخته می‌شود (وب + ربات).
  // ربطی به قیمت‌گذاریِ نماینده برای کاربرانِ خودش ندارد؛ آن از
  // resellers.price_per_gb و settings.unlimited_price می‌آید.
  // قبلاً در bot.js هاردکد بود (bronze/silver/gold) و هیچ‌جا قابلِ تغییر نبود.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price REAL NOT NULL DEFAULT 0,           -- چقدر می‌پردازد
      traffic_gb REAL NOT NULL DEFAULT 0,      -- سهمیهٔ ترافیک | ۰ = نامحدود
      max_clients INTEGER NOT NULL DEFAULT 0,  -- سقفِ کاربر | ۰ = بی‌نهایت
      duration_days INTEGER NOT NULL DEFAULT 0,-- ۰ = بدونِ انقضا
      billing TEXT NOT NULL DEFAULT 'once',    -- once | monthly
      price_per_gb REAL DEFAULT 0,             -- نرخی که نماینده بابتِ هر گیگِ کاربرش می‌دهد
      initial_balance REAL DEFAULT 0,          -- شارژِ اولیهٔ کیف پول
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Test claims — تستِ رایگان، هر شمارهٔ تلگرام فقط یک‌بار.
  // شماره از خودِ تلگرام (request_contact) می‌آید و تأییدشده است، نه تایپی؛
  // پس UNIQUE روی phone واقعاً جلوی تکرار را می‌گیرد.
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      telegram_id TEXT NOT NULL,
      kind TEXT NOT NULL,            -- panel | config
      ref_id INTEGER,                -- id نمایندهٔ تستی یا کلاینتِ تستی
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // پیش‌فرض‌های تست — ادمین از پنل عوضشان می‌کند. INSERT OR IGNORE تا
  // مقدارِ ویرایش‌شده را بازنویسی نکند.
  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  seed.run('test_enabled', '1');
  seed.run('test_traffic_gb', '10');
  seed.run('test_days', '1');
  seed.run('test_max_clients', '5');

  // ── مهاجرتِ ستون‌ها ──
  // CREATE TABLE IF NOT EXISTS روی جدولِ *موجود* هیچ ستونی اضافه نمی‌کند، پس
  // ستون‌هایی که کد لازم دارد ولی در schema نبودند باید با ALTER اضافه شوند.
  // این روی نصبِ تازه و نصبِ قدیمی هر دو کار می‌کند.
  const ensureColumn = (table, column, def) => {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
    if (!has) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      console.log(`  ↑ sotune ${table}.${column} ezafe shod`);
    }
  };
  ensureColumn('resellers', 'plain_password', "TEXT");
  ensureColumn('resellers', 'telegram_support', "TEXT DEFAULT ''");
  ensureColumn('resellers', 'brand_motion', "TEXT DEFAULT 'hearts'");
  // کدامین پلن خریداری شده — تا تأییدِ ادمین بداند چه ظرفیتی بدهد
  ensureColumn('panel_orders', 'plan_key', "TEXT");

  // ── زیرنمایندگی ──
  // نماینده می‌تواند خودش پنل بسازد و بابتش از موجودی‌اش کم شود.
  // پیش‌فرضِ هر دو صفر است: اجازه را ادمین می‌دهد، و زیرنماینده‌ای که
  // ساخته می‌شود خودش اجازهٔ ساخت ندارد مگر ادمین روشن کند.
  ensureColumn('resellers', 'parent_id', "INTEGER");             // سازندهٔ این پنل
  ensureColumn('resellers', 'discount_percent', "REAL DEFAULT 0"); // تخفیفِ شخصی روی قیمتِ پلن
  ensureColumn('resellers', 'can_create_panels', "INTEGER DEFAULT 0");
  // کدام پلن‌ها را نماینده حق دارد بفروشد (ادمین تیک می‌زند)
  ensureColumn('plans', 'resellable', "INTEGER DEFAULT 0");

  // ادمینِ پیش‌فرضِ admin/admin123 عمداً ساخته نمی‌شود: نصب‌کننده (30-app.sh)
  // ادمینِ واقعی را با رمزِ خودِ کاربر می‌سازد. وگرنه روی هر نصب یک حسابِ
  // پشتیِ با رمزِ شناخته‌شده می‌ماند.

  console.log('✅ Database initialized');
}

module.exports = { getDB, initDB };
