const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'crm.db');
let db;

function getDB() {
  if (!db) db = new Database(DB_PATH);
  return db;
}

// Add a column only if it does not already exist (safe migration helper)
function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function initDB() {
  const db = getDB();
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'salesperson',
      phone TEXT,
      active INTEGER DEFAULT 1,
      last_login INTEGER,
      commission_cash REAL DEFAULT 0,
      commission_cheque REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      biz TEXT NOT NULL,
      owner TEXT,
      city TEXT,
      phone TEXT,
      insta TEXT,
      type TEXT DEFAULT 'بوتیک',
      status TEXT DEFAULT 'new',
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      product_id INTEGER,
      date TEXT,
      type TEXT,
      qty INTEGER DEFAULT 0,
      total REAL DEFAULT 0,
      paid REAL DEFAULT 0,
      pay TEXT,
      deliver TEXT,
      status TEXT DEFAULT 'pending',
      note TEXT,
      stock_deducted INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      date TEXT,
      time TEXT,
      type TEXT,
      subject TEXT,
      note TEXT,
      action TEXT,
      next_date TEXT,
      status TEXT DEFAULT 'open',
      priority TEXT DEFAULT 'mid',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      num TEXT,
      type TEXT DEFAULT 'proforma',
      date TEXT,
      note TEXT,
      rows TEXT,
      subtotal REAL DEFAULT 0,
      disc REAL DEFAULT 0,
      disc_amt REAL DEFAULT 0,
      final REAL DEFAULT 0,
      seller_name TEXT,
      seller_phone TEXT,
      converted INTEGER DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      cheque_duration TEXT DEFAULT '',
      cheque_due_date TEXT DEFAULT '',
      cheque_info TEXT DEFAULT '',
      stock_deducted INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT,
      code TEXT,
      name TEXT NOT NULL,
      price REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      stock_alert INTEGER DEFAULT 5,
      image TEXT,
      unit TEXT DEFAULT 'عدد',
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS stock_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      change INTEGER NOT NULL,
      note TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL,
      to_id INTEGER,
      body TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(from_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER,
      title TEXT NOT NULL,
      body TEXT,
      remind_at TEXT NOT NULL,
      done INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sms_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER,
      phone TEXT,
      body TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT,
      entity TEXT,
      entity_id INTEGER,
      detail TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      cust_id INTEGER NOT NULL,
      invoice_id INTEGER,
      amount REAL DEFAULT 0,
      pay_type TEXT DEFAULT 'cash',
      date TEXT,
      note TEXT,
      cheque_bank TEXT DEFAULT '',
      cheque_sayadi TEXT DEFAULT '',
      cheque_number TEXT DEFAULT '',
      cheque_account TEXT DEFAULT '',
      cheque_amount REAL DEFAULT 0,
      cheque_owner TEXT DEFAULT '',
      cheque_due TEXT DEFAULT '',
      cheque_status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(cust_id) REFERENCES customers(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT
    );
  `);

  // ---- Safe migrations for databases created by v2 ----
  ensureColumn(db, 'users', 'phone', 'TEXT');
  ensureColumn(db, 'users', 'last_login', 'INTEGER');
  ensureColumn(db, 'users', 'commission_cash', 'REAL DEFAULT 0');
  ensureColumn(db, 'users', 'commission_cheque', 'REAL DEFAULT 0');
  ensureColumn(db, 'products', 'image', 'TEXT');
  ensureColumn(db, 'products', 'unit', "TEXT DEFAULT 'عدد'");
  ensureColumn(db, 'products', 'note', 'TEXT');
  ensureColumn(db, 'products', 'stock_alert', 'INTEGER DEFAULT 5');
  ensureColumn(db, 'followups', 'time', 'TEXT');
  ensureColumn(db, 'invoices', 'seller_name', 'TEXT');
  ensureColumn(db, 'invoices', 'seller_phone', 'TEXT');
  ensureColumn(db, 'invoices', 'converted', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'invoices', 'pay_type', "TEXT DEFAULT 'cash'");
  ensureColumn(db, 'invoices', 'cheque_duration', "TEXT DEFAULT ''");
  ensureColumn(db, 'invoices', 'cheque_due_date', "TEXT DEFAULT ''");
  ensureColumn(db, 'invoices', 'cheque_info', "TEXT DEFAULT ''");
  ensureColumn(db, 'invoices', 'stock_deducted', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'invoices', 'approved', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'invoices', 'approved_at', 'INTEGER');
  ensureColumn(db, 'invoices', 'approved_by', 'INTEGER');
  ensureColumn(db, 'orders', 'product_id', 'INTEGER');
  ensureColumn(db, 'orders', 'stock_deducted', 'INTEGER DEFAULT 0');
  ensureColumn(db, 'settlements', 'cheque_bank', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_sayadi', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_number', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_account', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_amount', 'REAL DEFAULT 0');
  ensureColumn(db, 'settlements', 'cheque_owner', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_due', "TEXT DEFAULT ''");
  ensureColumn(db, 'settlements', 'cheque_status', "TEXT DEFAULT 'pending'");
  // Followup CRM pipeline fields
  ensureColumn(db, 'followups', 'interest_level', "TEXT DEFAULT 'mid'");
  ensureColumn(db, 'followups', 'purchase_prob', 'INTEGER DEFAULT 50');
  ensureColumn(db, 'followups', 'pipeline_stage', "TEXT DEFAULT 'lead'");
  ensureColumn(db, 'followups', 'tags', "TEXT DEFAULT ''");
  ensureColumn(db, 'followups', 'lost_reason', "TEXT DEFAULT ''");
  ensureColumn(db, 'followups', 'assigned_to', 'INTEGER');
  // Customer CRM fields
  ensureColumn(db, 'customers', 'source', "TEXT DEFAULT ''");

  // ---- Indexes ----
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customers_user ON customers(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_cust ON orders(cust_id);
    CREATE INDEX IF NOT EXISTS idx_followups_user ON followups(user_id);
    CREATE INDEX IF NOT EXISTS idx_followups_cust ON followups(cust_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_cust ON invoices(cust_id);
    CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity);
  `);

  // ---- Default admin ----
  const admin = db.prepare('SELECT id FROM users WHERE username=?').get('admin');
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (name,username,password,role) VALUES (?,?,?,?)')
      .run('حامد رشید', 'admin', hash, 'admin');
    console.log('✅ ادمین پیش‌فرض ساخته شد (admin / admin123)');
  }

  // ---- Default settings ----
  const defaults = {
    company_name: 'پوشاک ترنم',
    company_address: 'مشهد',
    company_phone: '',
    telegram_bot_token: '',
    telegram_chat_id: '',
    sms_provider: 'melipayamak',
    sms_api_key: '',
    sms_from: ''
  };
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);

  console.log('✅ دیتابیس آماده شد');
}

// Helper used across routes to record audit entries
function audit(userId, action, entity, entityId, detail) {
  try {
    getDB().prepare('INSERT INTO audit_log (user_id,action,entity,entity_id,detail) VALUES (?,?,?,?,?)')
      .run(userId || null, action, entity, entityId || null, detail || '');
  } catch (e) { /* never let audit failures break a request */ }
}

module.exports = { getDB, initDB, audit };
