const router = require('express').Router();
const { getDB, audit, createLedgerEntry, createJournalEntry } = require('../db');
const { auth } = require('../middleware/auth');
const { todayJalali, addDaysToJalali } = require('../jalali');

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

// Validate & normalize invoice rows.
// Price is always editable by both admin and salesperson (Phase 2 change).
// product_id must be valid.
function buildRows(db, inputRows) {
  const out = [];
  let subtotal = 0;
  for (const r of (inputRows || [])) {
    const pid = parseInt(r.product_id);
    if (!pid) throw new Error('هر ردیف باید یک محصول معتبر داشته باشد');
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
    if (!prod) throw new Error('محصول یافت نشد (شناسه ' + pid + ')');
    const qty = Math.max(1, parseInt(r.qty) || 1);
    // Allow price override by anyone (Phase 2: price always editable)
    let price = prod.price;
    if (r.price !== undefined && r.price !== null && r.price !== '') {
      price = parseFloat(r.price) || 0;
    }
    const sum = qty * price;
    subtotal += sum;
    out.push({ product_id: pid, name: prod.name, qty, price, sum });
  }
  return { rows: out, subtotal };
}

// Deduct stock for each row; returns error message if stock insufficient
function deductStock(db, rows) {
  for (const r of rows) {
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(r.product_id);
    if (!prod) return `محصول شناسه ${r.product_id} یافت نشد`;
    if (prod.stock < r.qty) {
      return `موجودی ${prod.name} کافی نیست (موجود: ${prod.stock})`;
    }
  }
  // All checks passed — deduct
  for (const r of rows) {
    db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(r.qty, r.product_id);
    db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(
      r.product_id, 0, -r.qty, 'کسر موجودی از فاکتور رسمی'
    );
  }
  return null;
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

// Export invoices to Excel (must be before /:id to avoid route capture)
router.get('/export/excel', auth, (req, res) => {
  const XLSX = require('xlsx');
  const db = getDB();
  const scope = getScope(req);
  let rows;
  if (scope === null) {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz,u.name as salesperson FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id LEFT JOIN users u ON i.user_id=u.id ORDER BY i.created_at DESC').all();
  } else {
    rows = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.user_id=? ORDER BY i.created_at DESC').all(scope);
  }
  const data = rows.map(r => ({
    'شماره': r.num || '',
    'مشتری': r.cust_biz || '',
    'نوع': r.type === 'final' ? 'فاکتور رسمی' : 'پیش‌فاکتور',
    'تاریخ': r.date || '',
    'مبلغ کل (ت)': r.subtotal || 0,
    'تخفیف (٪)': r.disc || 0,
    'مبلغ نهایی (ت)': r.final || 0,
    'نوع پرداخت': r.pay_type === 'cheque' ? 'چک' : 'نقد',
    'تأیید شده': r.approved ? 'بله' : 'خیر',
    'کارشناس': r.salesperson || '',
    'یادداشت': r.note || ''
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [12,20,12,12,18,10,18,12,10,15,20].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'فاکتورها');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=invoices.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT i.*,c.biz as cust_biz,c.owner as cust_owner,c.city as cust_city,c.phone as cust_phone FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.post('/', auth, (req, res) => {
  const { cust_id, type, date, note, rows, disc, pay_type, cheque_duration, cheque_due_date, cheque_info } = req.body;
  if (!cust_id) return res.status(400).json({ error: 'مشتری الزامی است' });
  const db = getDB();
  let built;
  try { built = buildRows(db, rows); }
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

  const invType = type || 'proforma';
  let stockDeducted = 0;

  // Stock validation & deduction for final invoices
  if (invType === 'final') {
    const stockErr = deductStock(db, built.rows);
    if (stockErr) return res.status(400).json({ error: stockErr });
    stockDeducted = 1;
  }

  const result = db.prepare(
    'INSERT INTO invoices (user_id,cust_id,num,type,date,note,rows,subtotal,disc,disc_amt,final,seller_name,seller_phone,pay_type,cheque_duration,cheque_due_date,cheque_info,stock_deducted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, cust_id, num, invType, date || '', note || '',
        JSON.stringify(built.rows), subtotal, discPct, discAmt, final,
        seller ? seller.name : '', seller ? (seller.phone || '') : '',
        pay_type || 'cash', cheque_duration || '', cheque_due_date || '', cheque_info || '',
        stockDeducted);

  // Auto-update customer status to 'active' when a final invoice is issued
  if (invType === 'final') {
    db.prepare("UPDATE customers SET status='active' WHERE id=?").run(cust_id);
  }

  const row = db.prepare('SELECT i.*,c.biz as cust_biz FROM invoices i LEFT JOIN customers c ON i.cust_id=c.id WHERE i.id=?').get(result.lastInsertRowid);

  // Customer ledger + journal entries for final invoices
  if (invType === 'final') {
    const invId = result.lastInsertRowid;
    createLedgerEntry(db, {
      customer_id: cust_id, date: date || '', entry_type: 'invoice',
      ref_type: 'invoice', ref_id: invId,
      description: `فاکتور رسمی ${num}`,
      debit: final, credit: 0, user_id: req.user.id
    });
    const jLines = [
      { code: '1103', name: 'حساب‌های دریافتنی از مشتریان', debit: final, credit: 0 }
    ];
    if (discAmt > 0) jLines.push({ code: '4103', name: 'تخفیفات فروش', debit: discAmt, credit: 0, description: 'تخفیف فاکتور' });
    jLines.push({ code: '4101', name: 'درآمد فروش کالا', debit: 0, credit: subtotal });
    createJournalEntry(db, {
      date: date || '', description: `فاکتور رسمی ${num}`,
      ref_type: 'invoice', ref_id: invId, created_by: req.user.id, lines: jLines
    });
  }

  // Auto-create a 7-day quality follow-up for every new invoice
  try {
    const invoiceDate = date || todayJalali();
    const followupDate = addDaysToJalali(invoiceDate, 7);
    const productList = built.rows.map(r => r.name).join('، ') || '-';
    db.prepare(
      'INSERT INTO followups (user_id,cust_id,date,type,subject,note,next_date,status,priority) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(
      req.user.id, cust_id, invoiceDate,
      '🧾 پیگیری فاکتور',
      'بررسی رضایت از کیفیت کالا',
      `پیگیری پس از فاکتور ${num}\nمحصولات: ${productList}`,
      followupDate, 'open', 'mid'
    );
  } catch (e) {
    console.error('auto-followup error:', e.message);
  }

  res.json({ ...row, rows: JSON.parse(row.rows || '[]') });
});

router.put('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  const { cust_id, type, date, note, rows, disc, pay_type, cheque_duration, cheque_due_date, cheque_info } = req.body;
  let built;
  try { built = buildRows(db, rows); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const subtotal = built.subtotal;
  const discPct = parseFloat(disc) || 0;
  const discAmt = Math.round(subtotal * discPct / 100);
  const final = subtotal - discAmt;

  const newType = type || 'proforma';
  let stockDeducted = row.stock_deducted || 0;

  // Only deduct stock when transitioning TO final for the first time
  if (newType === 'final' && !stockDeducted) {
    const stockErr = deductStock(db, built.rows);
    if (stockErr) return res.status(400).json({ error: stockErr });
    stockDeducted = 1;
  }

  db.prepare('UPDATE invoices SET cust_id=?,type=?,date=?,note=?,rows=?,subtotal=?,disc=?,disc_amt=?,final=?,pay_type=?,cheque_duration=?,cheque_due_date=?,cheque_info=?,stock_deducted=? WHERE id=?')
    .run(cust_id, newType, date || '', note || '', JSON.stringify(built.rows), subtotal, discPct, discAmt, final,
         pay_type || 'cash', cheque_duration || '', cheque_due_date || '', cheque_info || '',
         stockDeducted, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });

  // Restore inventory when a final invoice with deducted stock is deleted
  if (row.stock_deducted) {
    const invRows = JSON.parse(row.rows || '[]');
    for (const r of invRows) {
      db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(r.qty, r.product_id);
      db.prepare('INSERT INTO stock_logs (product_id,user_id,change,note) VALUES (?,?,?,?)').run(
        r.product_id, req.user.id, r.qty, `بازگشت موجودی از حذف فاکتور ${row.num}`
      );
    }
  }

  // Reverse ledger + journal entries for deleted final invoices
  if (row.type === 'final') {
    createLedgerEntry(db, {
      customer_id: row.cust_id, date: row.date || '', entry_type: 'reversal',
      ref_type: 'invoice', ref_id: row.id,
      description: `ابطال فاکتور ${row.num}`,
      debit: 0, credit: row.final, user_id: req.user.id
    });
    const jLines = [
      { code: '4101', name: 'درآمد فروش کالا', debit: row.subtotal, credit: 0, description: 'ابطال' }
    ];
    if ((row.disc_amt || 0) > 0) jLines.push({ code: '4103', name: 'تخفیفات فروش', debit: 0, credit: row.disc_amt, description: 'ابطال تخفیف' });
    jLines.push({ code: '1103', name: 'حساب‌های دریافتنی از مشتریان', debit: 0, credit: row.final });
    createJournalEntry(db, {
      date: row.date || '', description: `ابطال فاکتور ${row.num}`,
      ref_type: 'invoice_reversal', ref_id: row.id, created_by: req.user.id, lines: jLines
    });
  }

  db.prepare('DELETE FROM invoices WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'invoice', req.params.id, `حذف فاکتور ${row.num}`);
  res.json({ ok: true });
});

// Convert proforma to official invoice (type='final')
router.post('/:id/convert', auth, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'یافت نشد' });
  if (req.user.role !== 'admin' && inv.user_id !== req.user.id) return res.status(403).json({ error: 'دسترسی ندارید' });
  if (inv.converted) return res.status(400).json({ error: 'قبلاً تبدیل شده' });
  if (inv.type === 'final') return res.status(400).json({ error: 'این فاکتور رسمی است' });

  const rows = JSON.parse(inv.rows || '[]');

  // Stock deduction if not already done
  let stockDeducted = inv.stock_deducted || 0;
  if (!stockDeducted) {
    const stockErr = deductStock(db, rows);
    if (stockErr) return res.status(400).json({ error: stockErr });
    stockDeducted = 1;
  }

  db.prepare('UPDATE invoices SET type=?,converted=1,stock_deducted=? WHERE id=?').run('final', stockDeducted, inv.id);
  // Auto-update customer status to 'active' when proforma is converted to final
  db.prepare("UPDATE customers SET status='active' WHERE id=?").run(inv.cust_id);
  audit(req.user.id, 'convert', 'invoice', inv.id, `تبدیل پیش‌فاکتور ${inv.num} به فاکتور رسمی`);

  // Customer ledger + journal entries on conversion
  createLedgerEntry(db, {
    customer_id: inv.cust_id, date: inv.date || '', entry_type: 'invoice',
    ref_type: 'invoice', ref_id: inv.id,
    description: `تبدیل پیش‌فاکتور ${inv.num} به فاکتور رسمی`,
    debit: inv.final, credit: 0, user_id: req.user.id
  });
  const cvLines = [
    { code: '1103', name: 'حساب‌های دریافتنی از مشتریان', debit: inv.final, credit: 0 }
  ];
  if ((inv.disc_amt || 0) > 0) cvLines.push({ code: '4103', name: 'تخفیفات فروش', debit: inv.disc_amt, credit: 0 });
  cvLines.push({ code: '4101', name: 'درآمد فروش کالا', debit: 0, credit: inv.subtotal });
  createJournalEntry(db, {
    date: inv.date || '', description: `فاکتور رسمی ${inv.num} (تبدیل از پیش‌فاکتور)`,
    ref_type: 'invoice', ref_id: inv.id, created_by: req.user.id, lines: cvLines
  });

  res.json({ ok: true });
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
  const paperSize = (req.query.paper || 'A4').toUpperCase() === 'A5' ? 'A5' : 'A4';

  const payTypeLabel = inv.pay_type === 'cheque' ? 'چک' : 'نقد';
  let payInfo = `<div><b>نوع پرداخت:</b> ${payTypeLabel}</div>`;
  if (inv.pay_type === 'cheque') {
    if (inv.cheque_duration) payInfo += `<div><b>مدت چک:</b> ${inv.cheque_duration} روز</div>`;
    if (inv.cheque_due_date) payInfo += `<div><b>سررسید:</b> ${inv.cheque_due_date}</div>`;
    if (inv.cheque_info) payInfo += `<div><b>اطلاعات چک:</b> ${inv.cheque_info}</div>`;
  }

  const rowsHtml = rows.map((r, i) => `
    <tr>
      <td>${faNum(i + 1)}</td>
      <td style="text-align:right">${r.name || ''}</td>
      <td>${faNum(r.qty)}</td>
      <td>${faNum(r.price)}</td>
      <td>${faNum(r.sum)}</td>
    </tr>`).join('');

  const sheetMaxWidth = paperSize === 'A5' ? '560px' : '800px';
  const baseFontSize = paperSize === 'A5' ? '11px' : '13px';
  const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${typeLabel} ${inv.num}</title>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Vazirmatn',sans-serif;background:#f3f4f6;color:#1f2937;padding:20px;font-size:${baseFontSize}}
  .sheet{max-width:${sheetMaxWidth};margin:0 auto;background:#fff;padding:${paperSize==='A5'?'20px':'34px'};border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #1A5C38;padding-bottom:16px;margin-bottom:18px}
  .logo{display:flex;align-items:center;gap:12px}
  .logo img{height:64px}
  .logo .emoji{font-size:46px}
  .logo h1{font-size:22px;color:#1A5C38}
  .logo p{font-size:12px;color:#6b7280;margin-top:4px}
  .meta{text-align:left;font-size:13px;line-height:1.9}
  .meta .num{font-size:18px;font-weight:800;color:#1A5C38}
  .tag{display:inline-block;background:#E8F5EE;color:#1A5C38;padding:4px 12px;border-radius:20px;font-weight:700;font-size:13px}
  .info{display:flex;justify-content:space-between;gap:16px;margin:18px 0;font-size:13px}
  .info .box{flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;line-height:2}
  .info .box b{color:#1A5C38}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th,td{border:1px solid #e5e7eb;padding:9px 8px;text-align:center}
  thead th{background:#1A5C38;color:#fff;font-weight:700}
  tbody tr:nth-child(even){background:#f4f7f5}
  .totals{margin-top:16px;margin-right:auto;width:300px;font-size:14px}
  .totals .line{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px dashed #e5e7eb}
  .totals .final{font-size:18px;font-weight:800;color:#059669;border:none;padding-top:10px}
  .note{margin-top:18px;font-size:12px;color:#6b7280;background:#f9fafb;border-radius:8px;padding:10px 14px}
  .footer{margin-top:26px;text-align:center;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:14px;line-height:2}
  .pbtn{display:block;margin:20px auto 0;background:#1A5C38;color:#fff;border:none;padding:11px 30px;border-radius:8px;font-family:inherit;font-size:14px;cursor:pointer}
  @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;border-radius:0;max-width:100%}.pbtn{display:none}@page{size:${paperSize};margin:10mm}}
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
        ${companyPhone ? `<div>تلفن شرکت: ${companyPhone}</div>` : ''}
      </div>
    </div>

    <div class="info">
      <div class="box">
        <div><b>نام فروشگاه:</b> ${inv.cust_biz || '-'}</div>
        <div><b>نام کامل:</b> ${inv.cust_owner || '-'}</div>
        <div><b>شهر:</b> ${inv.cust_city || '-'}</div>
        <div><b>تلفن:</b> ${inv.cust_phone || '-'}</div>
      </div>
      <div class="box">
        <div><b>فروشنده:</b> ${inv.seller_name || '-'}</div>
        <div><b>تلفن فروشنده:</b> ${inv.seller_phone || '-'}</div>
        <div><b>آدرس شرکت:</b> ${companyAddr || '-'}</div>
        ${payInfo}
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
