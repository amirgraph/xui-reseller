// ⚠️ override لازم است: dotenv طبق پیش‌فرض متغیری را که از قبل در process.env
//    هست بازنویسی نمی‌کند. pm2 مقدارِ زمانِ اولین استارت را ذخیره و در هر
//    ری‌استارت تزریق می‌کند — پس NAHAN_ADDRS=«خالی» برای همیشه می‌ماند و
//    updater.py هر ۶ ساعت .env را بی‌اثر آپدیت می‌کرد. نتیجه: کانفیگ‌ها روی
//    دامنه fallback می‌کردند و دامنه می‌سوخت. .env باید منبعِ حقیقت باشد.
require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const { initDB } = require('./models/database');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const resellerRoutes = require('./routes/reseller');
const subRoutes = require('./routes/sub');
const { syncUsersJob } = require('./services/syncService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb",  extended: true }));

// Serve manifest with correct MIME type for PWA
app.get('/reseller/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, '../public/reseller/manifest.json'));
});

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reseller', resellerRoutes);
const subinfoRoutes = require('./routes/subinfo');
app.use('/api/sub-info', subinfoRoutes);
app.get('/view/:uuid', (req, res) => res.sendFile(path.join(__dirname, '../public/sub-template.html')));
app.use('/sub', subRoutes);

// Admin Panel
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/index.html'));
});

// Mini App Telegram (__MAIN_DOMAIN__/mini)
app.get('/mini*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mini/index.html'));
});

// Reseller Panel
app.get('/panel*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/reseller/index.html'));
});

// Root
app.get('/', (req, res) => {
  res.redirect('/panel');
});

// Init DB and start
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ XUI Reseller Panel running on port ${PORT}`);
    console.log(`📊 Admin: http://localhost:${PORT}/admin`);
    console.log(`🏪 Reseller: http://localhost:${PORT}/panel`);
  });

  // Sync usage every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    syncUsersJob();
  });

  // Check expired accounts every hour
  cron.schedule('0 * * * *', () => {
    const { checkExpiredAccounts } = require('./services/syncService');
    checkExpiredAccounts();
  });
});
