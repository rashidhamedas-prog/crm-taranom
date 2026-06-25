const router = require('express').Router();
const { getDB, audit } = require('../db');
const { auth } = require('../middleware/auth');

function getScope(req) {
  if (req.user.role === 'admin' && req.query.user_id) return parseInt(req.query.user_id);
  if (req.user.role === 'admin') return null;
  return req.user.id;
}

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return r ? r.value : '';
}

function faNum(n) {
  return Number(n || 0).toLocaleString('fa-IR');
}

// Validate & normalize invoice rows. Salesperson price always comes from
// the products table; admin may override. Every row needs a valid product_id.
function buildRows(db, inputRows, isAdmin) {
  const out = [];
  let subtotal = 0;
  for (const r of (inputRows || [])) {
    const pid = parseInt(r.product_id);
    if (!pid) throw new Error('هر ردیف باید یک محصول معتبر داشته باشد');
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
    if (!prod) throw new Error('محصول یافت نشد (شناسه ' + pid + ')');
    const qty = Math.max(1, parseInt(r.qty) || 1);
    // Price: salesperson => product price; admin => may override if provided
    let price = prod.price;
    if (isAdmin && r.price !== undefined && r.price !== null && r.price !== '') {
      price = parseFloat(r.price) || 0;
    }
    const sum = qty * price;
    subtotal += sum;
    out.push({ product_id: pid, name: prod.name, qty, price, sum });
  }
  return { rows: out, subtotal };
}

router.get('/', auth, (req, res) => {
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz,u.name as salesperson FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id LEFT JOIN users u ON i.user_id=u.id ORDER BY i.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.user_id=? ORDER BY i.created_at DESC').all(scope);
  }
  rows = rows.map(r => ({ ...r, rows: JSON.parse(r.rows || '[]') }));
  res.json(rows);
});

router.get('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.post('/', auth, (req, res) => {
  const { cust_id, type, date, note, rows, disc } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'مشتری الزامی است' });
  const db = getDB();
  const isAdmin = req.user.role === 'admin';
  let built;
  try { built = buildRows(db, rows, isAdmin); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const subtotal = built.subtotal;
  const discPct = parseFloat(disc) || 0;
  const discAmt = Math.round(subtotal * discPct / 100);
  const final = subtotal - discAmt;

  // sequential global invoice number
  const count = db.prepare('SELECT COUNT(*) as c FROM invoices').get().c;
  const num = 'T-' + String(count + 1).padStart(4, '0');

  // capture seller info from the user record
  const seller = db.prepare('SELECT name,phone FROM users WHERE id=?').get(req.user.id);

  const result = db.prepare(
    'INSERT INTO invoices (user_id,cust_id,num,type,date,note,rows,subtotal,disc,disc_amt,final,seller_name,seller_phone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, cust_id, num, type || 'proforma', date || '', note || '',
        JSON.stringify(built.rows), subtotal, discPct, discAmt, final,
        seller ? seller.name : '', seller ? (seller.phone || '') : '');
  const row = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(result.lastInsertRowid);
  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { cust_id, type, date, note, rows, disc } = req.body;
  const isAdmin = req.user.role === 'admin';
  let built;
  try { built = buildRows(db, rows, isAdmin); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const subtotal = built.subtotal;
  const discPct = parseFloat(disc) || 0;
  const discAmt = Math.round(subtotal * discPct / 100);
  const final = subtotal - discAmt;
  db.prepare('UPDATE invoices SET cust_id=?,type=?,date=?,note=?,rows=?,subtotal=?,disc=?,disc_amt=?,final=? WHERE id=?')
    .run(cust_id, type || 'proforma', date || '', note || '', JSON.stringify(built.rows), subtotal, discPct, discAmt, final, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  db.prepare('DELETE FROM invoices WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'invoice', req.params.id, `حذف فاکتور ${row.num}`);
  res.json({ ok: true });
});

// Convert proforma to order
router.post('/:id/convert', auth, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && inv.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  if (inv.converted) return res.status(400).json({ error: 'قبلاً به سفارش تبدیل شده' });
  const rows = JSON.parse(inv.rows || '[]');
  const itemDesc = rows.map(r => r.name).join(' / ');
  const totalQty = rows.reduce((a, r) => a + (r.qty || 0), 0);
  const result = db.prepare(
    'INSERT INTO orders (user_id,cust_id,date,type,qty,total,paid,pay,deliver,status,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(inv.user_id, inv.cust_id, inv.date, itemDesc || 'از پیش‌فاکتور', totalQty, inv.final, 0, 'نسیه', '', 'pending', `تبدیل از پیش‌فاکتور ${inv.num}`);
  db.prepare('UPDATE invoices SET converted=1 WHERE id=?').run(inv.id);
  res.json({ ok: true, order_id: result.lastInsertRowid });
});

// Standalone printable HTML page
router.get('/:id/print', auth, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(req.params.id);
  if (!inv) return res.status(404).send('فاکتور یافت نشد');
  if (req.user.role !== 'admin' && inv.user_id !== req.user.id) return res.status(403).send('دسترسی ندارید');
  const rows = JSON.parse(inv.rows || '[]');
  const companyName = getSetting(db, 'company_name') || 'پوشاک ترنم';
  const companyAddr = getSetting(db, 'company_address') || '';
  const companyPhone = getSetting(db, 'company_phone') || '';
  const typeLabel = inv.type === 'final' ? 'فاکتور رسمی' : 'پیش‌فاکتور';

  const rowsHtml = rows.map((r, i) => `
    <tr>
      <td>${faNum(i + 1)}</td>
      <td style="text-align:right">${r.name || ''}</td>
      <td>${faNum(r.qty)}</td>
      <td>${faNum(r.price)}</td>
      <td>${faNum(r.sum)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${typeLabel} ${inv.num}</title>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Vazirmatn',sans-serif;background:#f3f4f6;color:#1f2937;padding:20px}
  .sheet{max-width:800px;margin:0 auto;background:#fff;padding:34px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #6B21A8;padding-bottom:16px;margin-bottom:18px}
  .logo{display:flex;align-items:center;gap:12px}
  .logo img{height:64px}
  .logo .emoji{font-size:46px}
  .logo h1{font-size:22px;color:#6B21A8}
  .logo p{font-size:12px;color:#6b7280;margin-top:4px}
  .meta{text-align:left;font-size:13px;line-height:1.9}
  .meta .num{font-size:18px;font-weight:800;color:#6B21A8}
  .tag{display:inline-block;background:#EDE9FE;color:#6B21A8;padding:4px 12px;border-radius:20px;font-weight:700;font-size:13px}
  .info{display:flex;justify-content:space-between;gap:16px;margin:18px 0;font-size:13px}
  .info .box{flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;line-height:2}
  .info .box b{color:#6B21A8}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th,td{border:1px solid #e5e7eb;padding:9px 8px;text-align:center}
  thead th{background:#6B21A8;color:#fff;font-weight:700}
  tbody tr:nth-child(even){background:#faf8ff}
  .totals{margin-top:16px;margin-right:auto;width:300px;font-size:14px}
  .totals .line{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px dashed #e5e7eb}
  .totals .final{font-size:18px;font-weight:800;color:#059669;border:none;padding-top:10px}
  .note{margin-top:18px;font-size:12px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:10px 14px}
  .footer{margin-top:26px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:14px;line-height:2}
  .pbtn{display:block;margin:20px auto 0;background:#6B21A8;color:#fff;border:none;padding:11px 30px;border-radius:8px;font-family:inherit;font-size:14px;cursor:pointer}
  @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0;max-width:100%}.pbtn{display:none}}
</style>
</head>
<body>
  <div class="sheet">
    <div class="head">
      <div class="logo">
        <img src="/logo.png" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
        <span class="emoji" style="display:none">🌸</span>
        <div>
          <h1>${companyName}</h1>
          <p>تولیدی پوشاک زنانه</p>
        </div>
      </div>
      <div class="meta">
        <div class="num">${inv.num || ''}</div>
        <div class="tag">${typeLabel}</div>
        <div>تاریخ: ${inv.date || '-'}</div>
      </div>
    </div>

    <div class="info">
      <div class="box">
        <div><b>مشتری:</b> ${inv.cust_biz || '-'}</div>
        <div><b>مالک:</b> ${inv.cust_owner || '-'}</div>
        <div><b>شهر:</b> ${inv.cust_city || '-'}</div>
        <div><b>تلفن:</b> ${inv.cust_phone || '-'}</div>
      </div>
      <div class="box">
        <div><b>فروشنده:</b> ${inv.seller_name || '-'}</div>
        <div><b>تلفن فروشنده:</b> ${inv.seller_phone || '-'}</div>
        <div><b>آدرس:</b> ${companyAddr || '-'}</div>
        <div><b>تلفن شرکت:</b> ${companyPhone || '-'}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr><th>ردیف</th><th>شرح کالا</th><th>تعداد</th><th>قیمت واحد (تومان)</th><th>جمع (تومان)</th></tr>
      </thead>
      <tbody>${rowsHtml || '<tr><td colspan="5">بدون ردیف</td></tr>'}</tbody>
    </table>

    <div class="totals">
      <div class="line"><span>جمع کل:</span><span>${faNum(inv.subtotal)} تومان</span></div>
      <div class="line"><span>تخفیف (${faNum(inv.disc)}٪):</span><span>${faNum(inv.disc_amt)} تومان</span></div>
      <div class="line final"><span>مبلغ نهایی:</span><span>${faNum(inv.final)} تومان</span></div>
    </div>

    ${inv.note ? `<div class="note"><b>توضیحات:</b> ${inv.note}</div>` : ''}

    <div class="footer">
      <div>این ${typeLabel} در تاریخ ${inv.date || ''} صادر شده است.</div>
      <div>${companyName} ${companyAddr ? '- ' + companyAddr : ''} ${companyPhone ? '- ' + companyPhone : ''}</div>
    </div>

    <button class="pbtn" onclick="window.print()">چاپ فاکتور 🖨️</button>
  </div>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
