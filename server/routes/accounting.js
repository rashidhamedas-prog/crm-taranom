const router = require('express').Router();
const { getDB, audit, createLedgerEntry, createJournalEntry } = require('../db');
const { auth, adminOnly } = require('../middleware/auth');

// Overview stats for accounting dashboard
router.get('/overview', auth, adminOnly, (req, res) => {
  const db = getDB();
  const totalInvoiced = db.prepare("SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final'").get().s;
  const totalSettled = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM settlements").get().s;
  const pendingApproval = db.prepare("SELECT COUNT(*) c FROM invoices WHERE type='final' AND approved=0").get().c;
  const approvedCount = db.prepare("SELECT COUNT(*) c FROM invoices WHERE type='final' AND approved=1").get().c;
  res.json({ totalInvoiced, totalSettled, outstanding: totalInvoiced - totalSettled, pendingApproval, approvedCount });
});

// Receivables per customer (only customers with at least one final invoice)
router.get('/receivables', auth, adminOnly, (req, res) => {
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
router.get('/settlements', auth, adminOnly, (req, res) => {
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
router.post('/settlements', auth, adminOnly, (req, res) => {
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
router.delete('/settlements/:id', auth, adminOnly, (req, res) => {
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
router.get('/cheques', auth, adminOnly, (req, res) => {
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
router.patch('/cheques/:id/status', auth, adminOnly, (req, res) => {
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
router.get('/commissions', auth, adminOnly, (req, res) => {
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
    return { ...u, cashSales, chequeSales, cashComm, chequeComm, totalComm: cashComm + chequeComm };
  });
  res.json(result);
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
router.get('/pending-approvals', auth, adminOnly, (req, res) => {
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
router.post('/invoices/:id/approve', auth, adminOnly, (req, res) => {
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
router.get('/general', auth, adminOnly, (req, res) => {
  const db = getDB();
  const { from, to } = req.query;
  const safeDate = v => (v && /^[\d/]+$/.test(v)) ? v : null;
  const sf = safeDate(from), st = safeDate(to);
  const invDateWhere = sf || st ? `AND date >= '${sf||''}' AND date <= '${st||'9999'}'` : '';
  const settDateWhere = sf || st ? `AND date >= '${sf||''}' AND date <= '${st||'9999'}'` : '';

  const revenue     = db.prepare(`SELECT COALESCE(SUM(final),0) s FROM invoices WHERE type='final' ${invDateWhere}`).get().s;
  const subtotal    = db.prepare(`SELECT COALESCE(SUM(subtotal),0) s FROM invoices WHERE type='final' ${invDateWhere}`).get().s;
  const discAmt     = db.prepare(`SELECT COALESCE(SUM(disc_amt),0) s FROM invoices WHERE type='final' ${invDateWhere}`).get().s;
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
    commExpense,
    netProfit: revenue - commExpense,
    monthlyInv, monthlySett, journal
  });
});

// Customer ledger (transaction history)
router.get('/ledger/:customerId', auth, adminOnly, (req, res) => {
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
router.get('/chart-of-accounts', auth, adminOnly, (req, res) => {
  const db = getDB();
  const accounts = db.prepare('SELECT * FROM chart_of_accounts WHERE is_active=1 ORDER BY code').all();
  res.json(accounts);
});

// Journal entries with lines (paginated, date-filtered)
router.get('/journal', auth, adminOnly, (req, res) => {
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

module.exports = router;
