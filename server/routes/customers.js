const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');
const XLSX = require('xlsx');
const multer = require('multer');

const memUpload = multer({ storage: multer.memoryStorage() });

function getScope(req) {
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (req.user.role === 'admin') return null; // all
  return req.user.id;
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT c.*,u.name as salesperson FROM customers c LEFT JOIN users u ON c.user_id=u.id ORDER BY c.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT c.*,u.name as salesperson FROM customers c LEFT JOIN users u ON c.user_id=u.id WHERE c.user_id=? ORDER BY c.created_at DESC').all(scope);
  }
  res.json(rows);
});

router.post('/', auth, (req, res) => {
  const { biz, owner, city, phone, insta, type, status, note, source } = req.body;
  if (!biz) return res.status(400).json({ error: 'نام فروشگاه الزامی است' });
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO customers (user_id,biz,owner,city,phone,insta,type,status,note,source) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, biz, owner || '', city || '', phone || '', insta || '', type || 'بوتیک', status || 'new', note || '', source || '');
  const row = db.prepare('SELECT * FROM customers WHERE id=?').get(result.lastInsertRowid);
  res.json(row);
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { biz, owner, city, phone, insta, type, status, note, source } = req.body;
  db.prepare('UPDATE customers SET biz=?,owner=?,city=?,phone=?,insta=?,type=?,status=?,note=?,source=? WHERE id=?')
    .run(biz, owner || '', city || '', phone || '', insta || '', type || 'بوتیک', status || 'new', note || '', source || '', req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'customer', req.params.id, `حذف مشتری ${row.biz}`);
  res.json({ ok: true });
});

router.get('/export/excel', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT c.*,u.name as salesperson FROM customers c LEFT JOIN users u ON c.user_id=u.id ORDER BY c.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT * FROM customers WHERE user_id=? ORDER BY created_at DESC').all(scope);
  }
  const data = rows.map(r => ({
    'نام فروشگاه': r.biz, 'نام کامل': r.owner, 'شهر': r.city,
    'موبایل': r.phone, 'اینستاگرام': r.insta, 'نوع': r.type, 'وضعیت': r.status,
    'منبع آشنایی': r.source || '', 'کارشناس': r.salesperson || '',
    'یادداشت': r.note
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'مشتریان');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=customers.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Import customers from Excel
router.post('/import', auth, adminOnly, memUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'فایل آپلود نشد' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws);
    const db = getDB();
    let inserted = 0;
    const allUsers = db.prepare('SELECT id,name FROM users').all();
    const stmt = db.prepare(
      'INSERT INTO customers (user_id,biz,owner,city,phone,insta,type,status,source) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        const biz = row['نام فروشگاه'] || row['biz'] || row['نام کسب‌وکار'] || '';
        if (!biz) continue;
        // Resolve salesperson by name or id
        let targetUserId = req.user.id;
        const salesRep = row['کارشناس'] || row['نام کارشناس'] || row['salesperson'] || '';
        if (salesRep) {
          const found = allUsers.find(u => u.name === salesRep || String(u.id) === String(salesRep));
          if (found) targetUserId = found.id;
        } else if (row['user_id']) {
          targetUserId = parseInt(row['user_id']);
        }
        stmt.run(
          targetUserId, biz,
          row['نام کامل'] || row['owner'] || row['نام مالک'] || '',
          row['شهر'] || row['city'] || '',
          row['موبایل'] || row['phone'] || '',
          row['اینستاگرام'] || row['insta'] || '',
          row['نوع'] || row['type'] || 'بوتیک',
          row['وضعیت'] || row['status'] || 'new',
          row['منبع آشنایی'] || row['source'] || ''
        );
        inserted++;
      }
    });
    insertMany(data);
    audit(req.user.id, 'import', 'customer', null, `ورود ${inserted} مشتری از اکسل`);
    res.json({ ok: true, inserted });
  } catch (e) {
    res.status(400).json({ error: 'خطا در خواندن فایل: ' + e.message });
  }
});

// Downloadable Excel template for customer import
router.get('/template', auth, adminOnly, (req, res) => {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const data = [
    { 'نام فروشگاه': 'بوتیک بهار', 'نام کامل': 'زهره احمدی', 'شهر': 'مشهد', 'موبایل': '09151234567', 'اینستاگرام': 'bahar_boutique', 'نوع': 'بوتیک', 'وضعیت': 'active', 'منبع آشنایی': 'instagram', 'کارشناس': '' },
    { 'نام فروشگاه': 'فروشگاه نسیم', 'نام کامل': 'فاطمه حسینی', 'شهر': 'تهران', 'موبایل': '09121234567', 'اینستاگرام': 'nasim_shop', 'نوع': 'فروشگاه', 'وضعیت': 'new', 'منبع آشنایی': 'referral', 'کارشناس': '' },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  // Add column widths
  ws['!cols'] = [30,20,15,15,20,15,15,20,20].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb, ws, 'مشتریان');
  // Instructions sheet
  const info = [
    { 'راهنما': 'مقادیر مجاز برای وضعیت: new, active, vip, followup, silent' },
    { 'راهنما': 'مقادیر مجاز برای منبع آشنایی: instagram, referral, exhibition, store_front, online, other' },
    { 'راهنما': 'مقادیر مجاز برای نوع: بوتیک، عمده‌فروش، تولیدی، فروشگاه، آنلاین' },
    { 'راهنما': 'ستون کارشناس: نام کارشناس دقیقاً همانطور که در سیستم ثبت شده (اختیاری)' },
  ];
  const ws2 = XLSX.utils.json_to_sheet(info);
  ws2['!cols'] = [{wch:80}];
  XLSX.utils.book_append_sheet(wb, ws2, 'راهنما');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=customers-template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
