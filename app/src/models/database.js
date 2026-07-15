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

  // ادمینِ پیش‌فرضِ admin/admin123 عمداً ساخته نمی‌شود: نصب‌کننده (30-app.sh)
  // ادمینِ واقعی را با رمزِ خودِ کاربر می‌سازد. وگرنه روی هر نصب یک حسابِ
  // پشتیِ با رمزِ شناخته‌شده می‌ماند.

  console.log('✅ Database initialized');
}

module.exports = { getDB, initDB };
