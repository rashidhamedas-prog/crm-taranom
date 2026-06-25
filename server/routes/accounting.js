const router = require('express').Router();
const { getDB, audit } = require('../db');
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
  const rows = db.prepare(`
    SELECT c.id, c.biz, c.owner, c.city, c.phone,
      u.name as salesperson,
      COALESCE(SUM(i.final),0) as total_invoiced,
      COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.cust_id=c.id),0) as total_settled
    FROM customers c
    LEFT JOIN invoices i ON i.cust_id=c.id AND i.type='final'
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
  const rows = db.prepare(`
    SELECT s.*, c.biz as cust_biz, u.name as recorder_name
    FROM settlements s
    LEFT JOIN customers c ON s.cust_id=c.id
    LEFT JOIN users u ON s.user_id=u.id
    ORDER BY s.created_at DESC
    LIMIT 300
  `).all();
  res.json(rows);
});

// Add settlement
router.post('/settlements', auth, adminOnly, (req, res) => {
  const { cust_id, invoice_id, amount, pay_type, date, note } = req.body;
  if (!cust_id || !amount) return res.status(400).json({ error: 'مشتری و مبلغ الزامی است' });
  const db = getDB();
  const result = db.prepare(
    'INSERT INTO settlements (user_id,cust_id,invoice_id,amount,pay_type,date,note) VALUES (?,?,?,?,?,?,?)'
  ).run(req.user.id, cust_id, invoice_id || null, parseFloat(amount), pay_type || 'cash', date || '', note || '');
  audit(req.user.id, 'create', 'settlement', result.lastInsertRowid, `تسویه ${amount} تومان - مشتری ${cust_id}`);
  res.json({ id: result.lastInsertRowid, ok: true });
});

// Delete settlement
router.delete('/settlements/:id', auth, adminOnly, (req, res) => {
  const db = getDB();
  db.prepare('DELETE FROM settlements WHERE id=?').run(req.params.id);
  audit(req.user.id, 'delete', 'settlement', req.params.id, 'حذف تسویه');
  res.json({ ok: true });
});

// Commission report per salesperson (only approved invoices)
router.get('/commissions', auth, adminOnly, (req, res) => {
  const db = getDB();
  const users = db.prepare(
    "SELECT id,name,commission_cash,commission_cheque FROM users WHERE active=1 AND role='salesperson'"
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
  db.prepare('UPDATE invoices SET approved=1, approved_at=strftime("%s","now"), approved_by=? WHERE id=?')
    .run(req.user.id, inv.id);
  audit(req.user.id, 'approve', 'invoice', inv.id, `تأیید فاکتور ${inv.num} برای کمیسیون`);
  res.json({ ok: true });
});

module.exports = router;
