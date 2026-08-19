/**
 * paystackController.js — Scholars Syndicate
 * Handles Paystack payment initialization and webhook verification.
 * Supported products: token bundles, gem packages.
 *
 * Setup:
 *   PAYSTACK_SECRET_KEY=sk_live_xxx   (or sk_test_xxx for dev)
 *   PAYSTACK_PUBLIC_KEY=pk_live_xxx
 *   FRONTEND_URL=https://cbt-frontend-umber.vercel.app
 */

const db    = require('../config/db');
const https = require('https');
const crypto = require('crypto');
const { serverError } = require('../utils/errors');

// ── Token bundle definitions (must match tokenController) ─
const TOKEN_BUNDLES = [
  { id:'starter',  tokens:50,   amount:20000,  label:'50 Tokens',    price:'₦200'  },
  { id:'basic',    tokens:150,  amount:50000,  label:'150 Tokens',   price:'₦500'  },
  { id:'standard', tokens:400,  amount:100000, label:'400 Tokens',   price:'₦1,000', popular:true },
  { id:'pro',      tokens:1000, amount:200000, label:'1,000 Tokens', price:'₦2,000' },
];

function paystackRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req  = https.request({
      hostname: 'api.paystack.co',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type':  'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Invalid Paystack response')); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── INITIALIZE PAYMENT ────────────────────────────────────
exports.initializePayment = async (req, res) => {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(503).json({ error: 'Paystack not configured. Use WhatsApp payment instead.' });
  }

  const { bundle_id, product_type = 'tokens' } = req.body;
  const student = req.student;

  let bundle;
  if (product_type === 'tokens') {
    bundle = TOKEN_BUNDLES.find(b => b.id === bundle_id);
  }
  if (!bundle) return res.status(400).json({ error: 'Invalid bundle' });

  // Persist pending transaction
  const ref = `SS-${Date.now()}-${student.id}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
  await db.query(`
    INSERT INTO paystack_transactions (reference, student_id, bundle_id, product_type, amount, status)
    VALUES ($1,$2,$3,$4,$5,'pending')
  `, [ref, student.id, bundle.id, product_type, bundle.amount]);

  try {
    const response = await paystackRequest('POST', '/transaction/initialize', {
      email:     student.email,
      amount:    bundle.amount,
      reference: ref,
      callback_url: `${process.env.FRONTEND_URL}/payment/verify?ref=${ref}`,
      metadata: {
        student_id:   student.id,
        bundle_id:    bundle.id,
        product_type,
        custom_fields: [{
          display_name: 'Student',
          variable_name: 'student_name',
          value: student.full_name || student.email,
        }],
      },
    });

    if (!response.status) throw new Error(response.message || 'Paystack error');
    res.json({ authorization_url: response.data.authorization_url, reference: ref });
  } catch (err) {
    await db.query(`UPDATE paystack_transactions SET status='failed' WHERE reference=$1`, [ref]);
    res.status(502).json({ error: err.message });
  }
};

// ── VERIFY PAYMENT (called by frontend after redirect, and by webhook) ────
// SAFETY: webhook + frontend polling can call this concurrently for the same
// reference. We use an atomic claim (UPDATE ... WHERE status='pending') so
// only ONE caller ever proceeds to credit the student — closes the
// double-credit race that existed when both callers could read status
// as 'pending' before either had written 'success'.
exports.verifyPayment = async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ error: 'reference required' });

  try {
    // Atomically claim the transaction — flips pending -> verifying.
    // Only the request that actually performs this UPDATE gets rows back;
    // any concurrent caller gets 0 rows and falls through to the status check below.
    const claim = await db.query(
      `UPDATE paystack_transactions SET status='verifying'
       WHERE reference=$1 AND status='pending'
       RETURNING *`,
      [reference]
    );

    let tx;
    if (claim.rows.length) {
      tx = claim.rows[0];
    } else {
      // Someone else already claimed it, or it's already resolved — check current state.
      const existing = await db.query(
        'SELECT * FROM paystack_transactions WHERE reference=$1',
        [reference]
      );
      if (!existing.rows.length) return res.status(404).json({ error: 'Transaction not found' });

      tx = existing.rows[0];
      if (tx.status === 'success') {
        return res.json({ status: 'success', already_credited: true });
      }
      if (tx.status === 'verifying') {
        // Another request is actively verifying this reference right now.
        return res.json({ status: 'pending', message: 'Verification in progress, please retry shortly.' });
      }
      // status === 'failed' — surface as failed rather than re-attempting.
      return res.json({ status: 'failed', message: 'Payment not successful' });
    }

    // From here on, this request is the sole owner of this transaction —
    // safe to verify with Paystack and credit without any race.
    const response = await paystackRequest('GET', `/transaction/verify/${reference}`);
    if (!response.status || response.data.status !== 'success') {
      await db.query(`UPDATE paystack_transactions SET status='failed' WHERE reference=$1`, [reference]);
      return res.json({ status: 'failed', message: response.data?.gateway_response || 'Payment not successful' });
    }

    // Credit student
    if (tx.product_type === 'tokens') {
      const bundle = TOKEN_BUNDLES.find(b => b.id === tx.bundle_id);
      if (bundle) {
        await db.query(
          `UPDATE students SET token_balance = COALESCE(token_balance,0) + $1 WHERE id = $2`,
          [bundle.tokens, tx.student_id]
        );
        // Log token credit (reference is UNIQUE, so this is a second safety net)
        await db.query(`
          INSERT INTO token_transactions (student_id, amount, type, description, reference)
          VALUES ($1,$2,'credit','Paystack purchase — ${bundle.label}',$3)
          ON CONFLICT DO NOTHING
        `, [tx.student_id, bundle.tokens, reference]).catch(() => {});
      }
    }

    await db.query(
      `UPDATE paystack_transactions SET status='success', verified_at=NOW() WHERE reference=$1`,
      [reference]
    );

    res.json({ status: 'success', bundle_id: tx.bundle_id, product_type: tx.product_type });
  } catch (err) {
    console.error('verifyPayment error:', err.message);
    // Best-effort: don't leave the transaction stuck in 'verifying' on unexpected errors.
    await db.query(
      `UPDATE paystack_transactions SET status='pending' WHERE reference=$1 AND status='verifying'`,
      [reference]
    ).catch(() => {});
    serverError(res, err);
  }
};

// ── WEBHOOK (server-to-server from Paystack) ─────────────
exports.webhook = async (req, res) => {
  const secret    = process.env.PAYSTACK_SECRET_KEY || '';
  const signature = req.headers['x-paystack-signature'];
  const hash      = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');

  if (hash !== signature) return res.status(401).send('Invalid signature');

  const { event, data } = req.body;
  if (event === 'charge.success') {
    // Idempotent — verifyPayment handles deduplication
    const ref = data.reference;
    const txRes = await db.query(
      'SELECT status FROM paystack_transactions WHERE reference=$1',
      [ref]
    ).catch(() => ({ rows: [] }));

    if (txRes.rows[0]?.status !== 'success') {
      // Re-use the verify logic
      const fakeReq = { query: { reference: ref } };
      const fakeRes = { json: () => {}, status: () => ({ json: () => {} }) };
      await exports.verifyPayment(fakeReq, fakeRes).catch(() => {});
    }
  }

  res.sendStatus(200);
};

// ── GET PUBLIC KEY (for frontend Paystack JS) ────────────
exports.getPublicKey = (_req, res) => {
  res.json({ public_key: process.env.PAYSTACK_PUBLIC_KEY || '' });
};
