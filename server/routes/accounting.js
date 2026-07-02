const router = require('express').Router();
const { getDB, audit, createLedgerEntry, createJournalEntry, backfillAccounting } = require('../db');
const { auth, adminOnly, adminOrAccounting } = require('../middleware/auth');

const ENTRY_LABEL = {
  invoice: 'فاکتور فروش',
  settlement: 'دریافت وجه',
  reversal: 'ابطال/اصلاح',
  opening: 'مانده اول دوره'
};

// Build a customer account statement (opening balance + period movements + running balance).
// Running balance is always computed from the very first entry; date/type filters only
// affect which rows are *returned*, so the opening balance reflects everything before `from`.
function buildStatement(db, customerId, { from, to, type } = {}) {
  const customer = db.prepare(
    'SELECT c.id,c.biz,c.owner,c.city,c.phone,c.balance,u.name as salesperson FROM customers c LEFT JOIN users u ON c.user_id=u.id WHERE c.id=?'
  ).get(customerId);
  if (!customer) return null;
  const all = db.prepare(`
    SELECT cl.*, u.name as user_name
    FROM customer_ledger cl LEFT JOIN users u ON cl.user_id=u.id
    WHERE cl.customer_id=?
    ORDER BY cl.created_at ASC, cl.id ASC
  `).all(customerId);

  let balance = 0, opening = 0, openingCounted = false;
  const entries = [];
  for (const e of all) {
    balance += (e.debit || 0) - (e.credit || 0);
    e.running_balance = balance;
    e.type_label = ENTRY_LABEL[e.entry_type] || e.entry_type || '-';
    e.reference = (e.ref_type ? e.ref_type + '-' : '') + (e.ref_id || '');
    // Everything strictly before the `from` date rolls into the opening balance
    if (from && (e.date || '') < from) { opening = balance; openingCounted = true; continue; }
    if (to && (e.date || '') > to) continue;
    if (type && e.entry_type !== type) continue;
    entries.push(e);
  }
  if (!openingCounted) opening = 0;
  const totalDebit = entries.reduce((a, e) => a + (e.debit || 0), 0);
  const totalCredit = entries.reduce((a, e) => a + (e.credit || 0), 0);
  return { customer, entries, opening, totalDebit, totalCredit, closing: balance };
}

// Overview stats for accounting dashboard
router.get('/overview', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const totalInvoiced = db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final'").get().s;
  const totalSettled = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM settlements").get().s;
  const pendingApproval = db.prepare("SELECT COUNT(*) c FROM invoices WHERE type='final' AND approved=0").get().c;
  const approvedCount = db.prepare("SELECT COUNT(*) c FROM invoices WHERE type='final' AND approved=1").get().c;
  res.json({ totalInvoiced, totalSettled, outstanding: totalInvoiced - totalSettled, pendingApproval, approvedCount });
});

// Receivables per customer (only customers with at least one final invoice)
router.get('/receivables', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  // Validate date strings to only allow digits and slashes (Jalali dates like 1403/04/01)
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(from), st = safeDate(to);
  const dateFilter = (sf || st)
    ? ` AND i.date >= '${sf || ''}' AND i.date <= '${st || '9999'}'`
    : '';
  const settDateFilter = (sf || st)
    ? ` AND s.date >= '${sf || ''}' AND s.date <= '${st || '9999'}'`
    : '';
  const rows = db.prepare(`
    SELECT c.id, c.biz, c.owner, c.city, c.phone,
      u.name as salesperson,
      COALESCE(SUM(i.final),0) as total_invoiced,
      COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.cust_id=c.id${settDateFilter}),0) as total_settled
    FROM customers c
    LEFT JOIN invoices i ON i.cust_id=c.id AND i.type='final'${dateFilter}
    LEFT JOIN users u ON c.user_id=u.id
    GROUP BY c.id
    HAVING total_invoiced > 0
    ORDER BY (total_invoiced - total_settled) DESC
  `).all();
  rows.forEach(r => { r.outstanding = r.total_invoiced - r.total_settled; });
  res.json(rows);
});

// Settlements list
router.get('/settlements', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push("s.date >= ?"); params.push(from); }
  if (to) { where.push("s.date <= ?"); params.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT s.*, c.biz as cust_biz, u.name as recorder_name
    FROM settlements s
    LEFT JOIN customers c ON s.cust_id=c.id
    LEFT JOIN users u ON s.user_id=u.id
    ${whereSql}
    ORDER BY s.created_at DESC
    LIMIT 300
  `).all(...params);
  res.json(rows);
});

// Add settlement
router.post('/settlements', auth, adminOrAccounting, (req, res) => {
  const { cust_id, invoice_id, amount, pay_type, date, note,
          cheque_bank, cheque_sayadi, cheque_number, cheque_account,
          cheque_amount, cheque_owner, cheque_due, cheque_status } = req.body;
  if (!cust_id || !amount) return res.status(400).json({ error: 'مشتری و مبلغ الزامی است' });
  const db = getDB();
  const result = db.prepare(
    `INSERT INTO settlements
      (user_id,cust_id,invoice_id,amount,pay_type,date,note,
       cheque_bank,cheque_sayadi,cheque_number,cheque_account,
       cheque_amount,cheque_owner,cheque_due,cheque_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(req.user.id, cust_id, invoice_id || null, parseFloat(amount), pay_type || 'cash',
        date || '', note || '',
        cheque_bank || '', cheque_sayadi || '', cheque_number || '', cheque_account || '',
        parseFloat(cheque_amount || 0), cheque_owner || '', cheque_due || '',
        cheque_status || 'pending');
  const settlementId = result.lastInsertRowid;
  audit(req.user.id, 'create', 'settlement', settlementId, `تسویه ${amount} تومان - مشتری ${cust_id}`);

  // Customer ledger entry
  const payLabel = (pay_type || 'cash') === 'cheque' ? 'چک' : 'نقد';
  createLedgerEntry(db, {
    customer_id: cust_id, date: date || '', entry_type: 'settlement',
    ref_type: 'settlement', ref_id: settlementId,
    description: `تسویه ${payLabel} - ${parseFloat(amount).toLocaleString('fa-IR')} تومان`,
    debit: 0, credit: parseFloat(amount), user_id: req.user.id
  });
  // Journal entry: Dr Cash/Bank / Cr Receivables
  const cashCode = (pay_type || 'cash') === 'cheque' ? '1102' : '1101';
  const cashName = (pay_type || 'cash') === 'cheque' ? 'موجودی بانک' : 'موجودی صندوق';
  createJournalEntry(db, {
    date: date || '', description: `تسویه ${payLabel} مشتری`,
    ref_type: 'settlement', ref_id: settlementId, created_by: req.user.id,
    lines: [
      { code: cashCode, name: cashName, debit: parseFloat(amount), credit: 0 },
      { code: '1103', name: 'حساب‌های دریافتنی از مشتریان', debit: 0, credit: parseFloat(amount) }
    ]
  });

  res.json({ id: settlementId, ok: true });
});

// Delete settlement
router.delete('/settlements/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const settlement = db.prepare('SELECT * FROM settlements WHERE id=?').get(req.params.id);
  if (!settlement) return res.status(404).json({ error: 'تسویه یافت نشد' });

  // Reversal ledger + journal entries
  const cashCode = settlement.pay_type === 'cheque' ? '1102' : '1101';
  const cashName = settlement.pay_type === 'cheque' ? 'موجودی بانک' : 'موجودی صندوق';
  createLedgerEntry(db, {
    customer_id: settlement.cust_id, date: settlement.date || '', entry_type: 'reversal',
    ref_type: 'settlement', ref_id: settlement.id,
    description: `ابطال تسویه شماره ${settlement.id}`,
    debit: settlement.amount, credit: 0, user_id: req.user.id
  });
  createJournalEntry(db, {
    date: settlement.date || '', description: `ابطال تسویه شماره ${settlement.id}`,
    ref_type: 'settlement_reversal', ref_id: settlement.id, created_by: req.user.id,
    lines: [
      { code: '1103', name: 'حساب‌های دریافتنی از مشتریان', debit: settlement.amount, credit: 0 },
      { code: cashCode, name: cashName, debit: 0, credit: settlement.amount }
    ]
  });

  db.prepare('DELETE FROM settlements WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'settlement', req.params.id, 'حذف تسویه');
  res.json({ ok: true });
});

// Cheque management list
router.get('/cheques', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to, status, bank } = req.query;
  const where = ["s.pay_type='cheque'"];
  const params = [];
  if (from) { where.push('s.cheque_due >= ?'); params.push(from); }
  if (to)   { where.push('s.cheque_due <= ?'); params.push(to); }
  if (status) { where.push('s.cheque_status = ?'); params.push(status); }
  if (bank)   { where.push('s.cheque_bank LIKE ?'); params.push('%' + bank + '%'); }
  const rows = db.prepare(`
    SELECT s.*, c.biz as cust_biz, u.name as salesperson_name
    FROM settlements s
    LEFT JOIN customers c ON s.cust_id=c.id
    LEFT JOIN users u ON c.user_id=u.id
    WHERE ${where.join(' AND ')}
    ORDER BY s.cheque_due ASC, s.created_at DESC
    LIMIT 500
  `).all(...params);
  res.json(rows);
});

// Update cheque status (pending → received/bounced/cancelled)
router.patch('/cheques/:id/status', auth, adminOrAccounting, (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'received', 'bounced', 'cancelled'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'وضعیت نامعتبر' });
  const db = getDB();
  const row = db.prepare('SELECT * FROM settlements WHERE id=? AND pay_type=?').get(req.params.id, 'cheque');
  if (!row) return res.status(404).json({ error: 'چک یافت نشد' });
  db.prepare('UPDATE settlements SET cheque_status=? WHERE id=?').run(status, req.params.id);
  audit(req.user.id, 'update', 'cheque', req.params.id, `وضعیت چک: ${status}`);
  res.json({ ok: true });
});

// Incentive (commission) report per salesperson (only approved invoices)
router.get('/commissions', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const users = db.prepare(
    "SELECT id,name,commission_cash,commission_cheque FROM users WHERE active=1 AND role='field_sales'"
  ).all();
  const result = users.map(u => {
    const cashSales = db.prepare(
      "SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND approved=1 AND pay_type='cash'"
    ).get(u.id).s;
    const chequeSales = db.prepare(
      "SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND approved=1 AND pay_type='cheque'"
    ).get(u.id).s;
    const cashComm = cashSales * (u.commission_cash || 0) / 100;
    const chequeComm = chequeSales * (u.commission_cheque || 0) / 100;
    const totalComm = cashComm + chequeComm;
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM incentive_payments WHERE rep_id=?').get(u.id).s;
    return { ...u, cashSales, chequeSales, cashComm, chequeComm, totalComm, paid, payable: totalComm - paid };
  });
  res.json(result);
});

// List incentive payments (optionally for a single rep)
router.get('/incentive-payments', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { rep_id } = req.query;
  const rows = rep_id
    ? db.prepare('SELECT ip.*, u.name as rep_name, r.name as recorder FROM incentive_payments ip LEFT JOIN users u ON ip.rep_id=u.id LEFT JOIN users r ON ip.created_by=r.id WHERE ip.rep_id=? ORDER BY ip.created_at DESC').all(rep_id)
    : db.prepare('SELECT ip.*, u.name as rep_name, r.name as recorder FROM incentive_payments ip LEFT JOIN users u ON ip.rep_id=u.id LEFT JOIN users r ON ip.created_by=r.id ORDER BY ip.created_at DESC LIMIT 300').all();
  res.json(rows);
});

// Record an incentive payment to a sales representative
router.post('/incentive-payments', auth, adminOrAccounting, (req, res) => {
  const { rep_id, amount, pay_type, date, note } = req.body;
  if (!rep_id || !amount) return res.status(400).json({ error: 'کارشناس و مبلغ الزامی است' });
  const db = getDB();
  const rep = db.prepare('SELECT id,name FROM users WHERE id=?').get(rep_id);
  if (!rep) return res.status(404).json({ error: 'کارشناس یافت نشد' });
  const result = db.prepare(
    'INSERT INTO incentive_payments (rep_id,amount,pay_type,date,note,created_by) VALUES (?,?,?,?,?,?)'
  ).run(rep_id, parseFloat(amount), pay_type || 'cash', date || '', note || '', req.user.id);
  audit(req.user.id, 'create', 'incentive_payment', result.lastInsertRowid, `پرداخت انگیزه ${amount} تومان به ${rep.name}`);
  // Background journal entry: Dr incentive expense / Cr cash or bank
  const cashCode = (pay_type || 'cash') === 'cheque' ? '1102' : '1101';
  const cashName = (pay_type || 'cash') === 'cheque' ? 'موجودی بانک' : 'موجودی صندوق';
  createJournalEntry(db, {
    date: date || '', description: `پرداخت انگیزه فروش به ${rep.name}`,
    ref_type: 'incentive_payment', ref_id: result.lastInsertRowid, created_by: req.user.id,
    lines: [
      { code: '6101', name: 'هزینه انگیزه فروش', debit: parseFloat(amount), credit: 0 },
      { code: cashCode, name: cashName, debit: 0, credit: parseFloat(amount) }
    ]
  });
  res.json({ id: result.lastInsertRowid, ok: true });
});

// Delete an incentive payment
router.delete('/incentive-payments/:id', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const row = db.prepare('SELECT * FROM incentive_payments WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'یافت نشد' });
  db.prepare('DELETE FROM incentive_payments WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'incentive_payment', req.params.id, 'حذف پرداخت انگیزه فروش');
  res.json({ ok: true });
});

// My commission — salesperson views their own (no adminOnly)
router.get('/my-commission', auth, (req, res) => {
  const db = getDB();
  const u = db.prepare('SELECT id,name,commission_cash,commission_cheque FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.json({ cashComm: 0, chequeComm: 0, totalComm: 0, commRate: { cash: 0, cheque: 0 } });
  const cashSales = db.prepare(
    "SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND approved=1 AND pay_type='cash'"
  ).get(u.id).s;
  const chequeSales = db.prepare(
    "SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND approved=1 AND pay_type='cheque'"
  ).get(u.id).s;
  const cashComm = cashSales * (u.commission_cash || 0) / 100;
  const chequeComm = chequeSales * (u.commission_cheque || 0) / 100;
  res.json({
    cashSales, chequeSales, cashComm, chequeComm,
    totalComm: cashComm + chequeComm,
    commRate: { cash: u.commission_cash || 0, cheque: u.commission_cheque || 0 }
  });
});

// Invoices pending approval
router.get('/pending-approvals', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT i.id, i.num, i.date, i.final, i.pay_type,
      c.biz as cust_biz, u.name as salesperson
    FROM invoices i
    LEFT JOIN customers c ON i.cust_id=c.id
    LEFT JOIN users u ON i.user_id=u.id
    WHERE i.type='final' AND i.approved=0
    ORDER BY i.created_at DESC
  `).all();
  res.json(rows);
});

// Approve invoice for commission
router.post('/invoices/:id/approve', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const inv = db.prepare('SELECT * FROM invoices WHERE id=?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: 'یافت نشد' });
  if (inv.type !== 'final') return res.status(400).json({ error: 'فقط فاکتور رسمی قابل تأیید است' });
  db.prepare('UPDATE invoices SET approved=1, approved_at=?, approved_by=? WHERE id=?')
    .run(Math.floor(Date.now() / 1000), req.user.id, inv.id);
  audit(req.user.id, 'approve', 'invoice', inv.id, `تأیید فاکتور ${inv.num} برای انگیزه فروش`);
  res.json({ ok: true });
});

// General Accounting — P&L, cash flow, ledger summary
router.get('/general', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(from), st = safeDate(to);
  const invDateWhere = sf || st ? `AND date >= '${sf||''}' AND date <= '${st||'9999'}'` : '';
  const settDateWhere = sf || st ? `AND date >= '${sf||''}' AND date <= '${st||'9999'}'` : '';

  const revenue     = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final' ${invDateWhere}`).get().s;
  const subtotal    = db.prepare(`SELECT COALESCE(SUM(subtotal),0) s FROM invoices WHERE type='final' ${invDateWhere}`).get().s;
  const discAmt     = db.prepare(`SELECT COALESCE(SUM(disc_amt),0) s FROM invoices WHERE type='final' ${invDateWhere}`).get().s;

  // Cost of goods sold: sum of (qty × unit cost) across all final invoice rows in range
  const costMap = {};
  db.prepare('SELECT id,cost FROM products').all().forEach(p => { costMap[p.id] = p.cost || 0; });
  let cogs = 0;
  const finalInvRows = db.prepare(`SELECT rows FROM invoices WHERE type='final' ${invDateWhere}`).all();
  for (const inv of finalInvRows) {
    let parsed = [];
    try { parsed = JSON.parse(inv.rows || '[]'); } catch (e) { parsed = []; }
    for (const r of parsed) cogs += (r.qty || 0) * (costMap[r.product_id] || 0);
  }
  cogs = Math.round(cogs);
  const grossProfit = revenue - cogs;
  const settled     = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE 1=1 ${settDateWhere}`).get().s;
  const cashSettled = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE pay_type='cash' ${settDateWhere}`).get().s;
  const cheqSettled = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM settlements WHERE pay_type='cheque' ${settDateWhere}`).get().s;
  const commExpense = (() => {
    const users = db.prepare("SELECT id,commission_cash,commission_cheque FROM users WHERE active=1").all();
    let total = 0;
    for (const u of users) {
      const cs = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND approved=1 AND pay_type='cash' ${invDateWhere}`).get(u.id).s;
      const qs = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE user_id=? AND type='final' AND approved=1 AND pay_type='cheque' ${invDateWhere}`).get(u.id).s;
      total += cs * (u.commission_cash || 0) / 100 + qs * (u.commission_cheque || 0) / 100;
    }
    return Math.round(total);
  })();

  // Monthly revenue & collections for chart
  const monthlyInv = db.prepare(`SELECT substr(date,1,7) ym, SUM(final) rev FROM invoices WHERE type='final' AND date<>'' GROUP BY ym ORDER BY ym DESC LIMIT 12`).all();
  const monthlySett = db.prepare(`SELECT substr(date,1,7) ym, SUM(amount) col FROM settlements WHERE date<>'' GROUP BY ym ORDER BY ym DESC LIMIT 12`).all();

  // Recent transactions journal
  const invJournal = db.prepare(`SELECT 'invoice' as entry_type, num ref, date, final amount, cust_id, 0 is_credit FROM invoices WHERE type='final' ORDER BY created_at DESC LIMIT 30`).all();
  const settJournal = db.prepare(`SELECT 'settlement' as entry_type, id||'' ref, date, amount, cust_id, 1 is_credit FROM settlements ORDER BY created_at DESC LIMIT 30`).all();
  const journal = [...invJournal, ...settJournal].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 50);

  // Enrich journal with customer name
  const custMap = {};
  db.prepare('SELECT id,biz FROM customers').all().forEach(c => { custMap[c.id] = c.biz; });
  journal.forEach(j => { j.cust_biz = custMap[j.cust_id] || '-'; });

  res.json({
    revenue, subtotal, discAmt, settled, cashSettled, cheqSettled,
    outstanding: revenue - settled,
    cogs, grossProfit,
    commExpense,
    netProfit: grossProfit - commExpense,
    monthlyInv, monthlySett, journal
  });
});

// Customer ledger (transaction history)
router.get('/ledger/:customerId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const customer = db.prepare('SELECT id,biz,owner,phone FROM customers WHERE id=?').get(req.params.customerId);
  if (!customer) return res.status(404).json({ error: 'مشتری یافت نشد' });
  const entries = db.prepare(`
    SELECT cl.*, u.name as user_name
    FROM customer_ledger cl LEFT JOIN users u ON cl.user_id=u.id
    WHERE cl.customer_id=?
    ORDER BY cl.created_at ASC, cl.id ASC
  `).all(req.params.customerId);
  let balance = 0;
  entries.forEach(e => { balance += (e.debit || 0) - (e.credit || 0); e.running_balance = balance; });
  res.json({ customer, entries, balance });
});

// Chart of accounts
router.get('/chart-of-accounts', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const accounts = db.prepare('SELECT * FROM chart_of_accounts WHERE is_active=1 ORDER BY code').all();
  res.json(accounts);
});

// Journal entries with lines (paginated, date-filtered)
router.get('/journal', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to, page = '1' } = req.query;
  const pageNum = Math.max(1, parseInt(page));
  const limit = 50, offset = (pageNum - 1) * limit;
  const where = [], params = [];
  if (from) { where.push('je.entry_date >= ?'); params.push(from); }
  if (to)   { where.push('je.entry_date <= ?'); params.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM journal_entries je ${whereSql}`).get(...params).c;
  const entries = db.prepare(`
    SELECT je.*, u.name as created_by_name FROM journal_entries je
    LEFT JOIN users u ON je.created_by=u.id
    ${whereSql} ORDER BY je.entry_date DESC, je.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const ids = entries.map(e => e.id);
  const lines = ids.length
    ? db.prepare(`SELECT * FROM journal_lines WHERE entry_id IN (${ids.join(',')}) ORDER BY entry_id,id`).all()
    : [];
  entries.forEach(e => { e.lines = lines.filter(l => l.entry_id === e.id); });
  res.json({ entries, total, page: pageNum, limit });
});

// Customer account statement (JSON) — filters: from, to, type
router.get('/statement/:customerId', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to, type } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : undefined;
  const data = buildStatement(db, req.params.customerId, { from: safeDate(from), to: safeDate(to), type: type || undefined });
  if (!data) return res.status(404).json({ error: 'مشتری یافت نشد' });
  res.json(data);
});

// Customer account statement export — format: excel | csv | pdf
router.get('/statement/:customerId/export', auth, adminOrAccounting, (req, res) => {
  const db = getDB();
  const { from, to, type, format = 'excel' } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : undefined;
  const data = buildStatement(db, req.params.customerId, { from: safeDate(from), to: safeDate(to), type: type || undefined });
  if (!data) return res.status(404).json({ error: 'مشتری یافت نشد' });
  const faNum = n => Number(n || 0).toLocaleString('fa-IR');
  const rows = data.entries.map(e => ({
    'تاریخ': e.date || '', 'نوع تراکنش': e.type_label, 'شرح': e.description || '',
    'بدهکار (ت)': e.debit || 0, 'بستانکار (ت)': e.credit || 0,
    'مانده (ت)': e.running_balance || 0, 'مرجع': e.reference || '', 'ثبت‌کننده': e.user_name || ''
  }));

  if (format === 'csv') {
    const headers = Object.keys(rows[0] || { 'تاریخ': '', 'نوع تراکنش': '', 'شرح': '', 'بدهکار (ت)': '', 'بستانکار (ت)': '', 'مانده (ت)': '', 'مرجع': '', 'ثبت‌کننده': '' });
    const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(','));
    lines.push('');
    lines.push([esc('مانده اول دوره'), '', '', '', '', esc(data.opening)].join(','));
    lines.push([esc('جمع دوره'), '', '', esc(data.totalDebit), esc(data.totalCredit), esc(data.closing)].join(','));
    res.setHeader('Content-Disposition', `attachment; filename=statement-${data.customer.id}.csv`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send('﻿' + lines.join('\n')); // BOM for Excel UTF-8
  }

  if (format === 'pdf') {
    // Printable HTML — user prints to PDF from the browser
    const rowsHtml = data.entries.map((e, i) => `
      <tr>
        <td>${faNum(i + 1)}</td><td>${e.date || '-'}</td><td>${e.type_label}</td>
        <td style="text-align:right">${(e.description || '-').replace(/</g, '&lt;')}</td>
        <td>${e.debit > 0 ? faNum(e.debit) : '-'}</td>
        <td>${e.credit > 0 ? faNum(e.credit) : '-'}</td>
        <td>${faNum(Math.abs(e.running_balance || 0))} ${(e.running_balance || 0) > 0 ? 'بد' : 'بس'}</td>
      </tr>`).join('');
    const company = (db.prepare("SELECT value FROM settings WHERE key='company_name'").get() || {}).value || 'پوشاک ترنم';
    const html = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8">
<title>صورت‌حساب ${data.customer.biz}</title>
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:'Vazirmatn',sans-serif}
body{background:#f3f4f6;color:#1f2937;padding:20px;font-size:12px}
.sheet{max-width:900px;margin:0 auto;background:#fff;padding:28px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.head{display:flex;justify-content:space-between;border-bottom:3px solid #1A5C38;padding-bottom:14px;margin-bottom:16px}
h1{font-size:20px;color:#1A5C38}.sub{color:#6b7280;font-size:12px;margin-top:4px}
.info{display:flex;gap:24px;margin-bottom:14px;font-size:13px}.info b{color:#1A5C38}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{border:1px solid #e5e7eb;padding:7px 6px;text-align:center}
thead th{background:#1A5C38;color:#fff}tbody tr:nth-child(even){background:#f4f7f5}
.tot{margin-top:14px;margin-right:auto;width:320px;font-size:13px}
.tot .l{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #e5e7eb}
.tot .f{font-weight:800;color:#1A5C38;border:none;font-size:15px;padding-top:8px}
.pbtn{display:block;margin:18px auto 0;background:#1A5C38;color:#fff;border:none;padding:10px 28px;border-radius:8px;font-size:14px;cursor:pointer}
@media print{body{background:#fff;padding:0}.sheet{box-shadow:none}.pbtn{display:none}@page{size:A4;margin:10mm}}
</style></head><body><div class="sheet">
<div class="head"><div><h1>صورت‌حساب مشتری</h1><div class="sub">${company}</div></div>
<div style="text-align:left"><div><b>مشتری:</b> ${data.customer.biz}</div><div><b>کارشناس:</b> ${data.customer.salesperson || '-'}</div>${(from || to) ? `<div><b>دوره:</b> ${from || '...'} تا ${to || '...'}</div>` : ''}</div></div>
<div class="info"><div><b>نام کامل:</b> ${data.customer.owner || '-'}</div><div><b>شهر:</b> ${data.customer.city || '-'}</div><div><b>تلفن:</b> ${data.customer.phone || '-'}</div></div>
<table><thead><tr><th>ردیف</th><th>تاریخ</th><th>نوع</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th></tr></thead>
<tbody>${rowsHtml || '<tr><td colspan="7">تراکنشی ثبت نشده</td></tr>'}</tbody></table>
<div class="tot">
<div class="l"><span>مانده اول دوره</span><span>${faNum(Math.abs(data.opening))} ${data.opening > 0 ? 'بدهکار' : 'بستانکار'}</span></div>
<div class="l"><span>جمع بدهکار دوره</span><span>${faNum(data.totalDebit)} ت</span></div>
<div class="l"><span>جمع بستانکار دوره</span><span>${faNum(data.totalCredit)} ت</span></div>
<div class="l f"><span>مانده نهایی</span><span>${faNum(Math.abs(data.closing))} ${data.closing > 0 ? 'بدهکار' : 'بستانکار'}</span></div>
</div>
<button class="pbtn" onclick="window.print()">چاپ / ذخیره PDF 🖨️</button>
</div></body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }

  // default: excel
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const sheetData = [...rows,
    {},
    { 'تاریخ': 'مانده اول دوره', 'مانده (ت)': data.opening },
    { 'تاریخ': 'جمع دوره', 'بدهکار (ت)': data.totalDebit, 'بستانکار (ت)': data.totalCredit, 'مانده (ت)': data.closing }
  ];
  const ws = XLSX.utils.json_to_sheet(sheetData);
  ws['!cols'] = [14, 14, 30, 16, 16, 16, 14, 16].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'صورت‌حساب');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename=statement-${data.customer.id}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Manually re-sync accounting entries for all prior operations (idempotent).
router.post('/backfill', auth, adminOnly, (req, res) => {
  const db = getDB();
  // clear the one-time flag so the routine re-scans; existence checks prevent duplicates
  db.prepare("INSERT INTO settings (key,value) VALUES ('accounting_backfill_v1','0') ON CONFLICT(key) DO UPDATE SET value='0'").run();
  backfillAccounting(db);
  audit(req.user.id, 'backfill', 'accounting', null, 'همگام‌سازی حسابداری عملیات گذشته');
  res.json({ ok: true });
});

module.exports = router;
