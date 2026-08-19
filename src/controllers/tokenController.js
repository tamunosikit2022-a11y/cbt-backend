/**
 * tokenController.js
 * Token system: WhatsApp payment (primary) + Paystack (coming soon)
 * Premium-to-token migration warnings via email.
 */

const db    = require('../config/db');
const https = require('https');
const { serverError } = require('../utils/errors');

// ── Bundle definitions ─────────────────────────────────────
const BUNDLES = [
  { id:'micro',    tokens:10,   amount:10000,  label:'10 Tokens',    price:'₦100',   perToken:'₦10/token',  badge:'🎒 Try it' },
  { id:'starter',  tokens:30,   amount:12000,  label:'30 Tokens',    price:'₦120',   perToken:'₦4/token',   badge:'⚡ Starter' },
  { id:'basic',    tokens:100,  amount:20000,  label:'100 Tokens',   price:'₦200',   perToken:'₦2/token',   badge:'🔥 Popular' },
  { id:'value',    tokens:300,  amount:50000,  label:'300 Tokens',   price:'₦500',   perToken:'₦1.67/token', popular:true, badge:'💎 Best Value' },
  { id:'standard', tokens:700,  amount:100000, label:'700 Tokens',   price:'₦1,000', perToken:'₦1.43/token', badge:'🚀 Power' },
  { id:'pro',      tokens:2000, amount:200000, label:'2,000 Tokens', price:'₦2,000', perToken:'₦1/token',   badge:'👑 Pro' },
  { id:'elite',    tokens:6000, amount:500000, label:'6,000 Tokens', price:'₦5,000', perToken:'₦0.83/token', badge:'🏆 Elite' },
];

// ── Feature token costs ────────────────────────────────────
const TOKEN_COSTS = {
  ai_message:      1,
  arena_host:      2,
  extra_spin:      1,
  vault_download:  1,
  predicted_score: 3,
  examiner_breakdown: 1,
};

// ── Brevo email helper ─────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  if (!process.env.BREVO_API_KEY) return false;
  const body = JSON.stringify({
    sender:      { name:'Scholars Syndicate', email: process.env.EMAIL_USER || 'scholarssyndicate70@gmail.com' },
    to:          [{ email: to }],
    subject,
    htmlContent: html,
    textContent: html.replace(/<[^>]+>/g, ''),
  });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.on('data',()=>{}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false));
    req.write(body); req.end();
  });
}

// ── WhatsApp payment order ─────────────────────────────────
// Student clicks → opens WhatsApp with pre-filled message → admin manually credits tokens
exports.initWhatsAppPayment = async (req, res) => {
  try {
    const { bundleId } = req.body;
    const bundle = BUNDLES.find(b => b.id === bundleId);
    if (!bundle) return res.status(400).json({ error: 'Invalid bundle.' });

    const student = req.student;
    const ref     = `WA_${student.id}_${Date.now()}`;

    // Save as pending so admin can verify and credit
    await db.query(
      `INSERT INTO token_transactions (student_id, reference, bundle_id, tokens, amount_kobo, status)
       VALUES ($1,$2,$3,$4,$5,'whatsapp_pending') ON CONFLICT (reference) DO NOTHING`,
      [student.id, ref, bundle.id, bundle.tokens, bundle.amount]
    );

    const waNumber = process.env.BUSINESS_WHATSAPP || '2348000000000'; // Set in Render env
    const message  = encodeURIComponent(
      `Hi! I want to buy tokens on Scholars Syndicate.\n\n` +
      `Bundle: ${bundle.label} (${bundle.price})\n` +
      `My email: ${student.email}\n` +
      `Reference: ${ref}\n\n` +
      `Please confirm payment details.`
    );

    res.json({
      whatsapp_url: `https://wa.me/${waNumber}?text=${message}`,
      reference: ref,
      bundle,
    });
  } catch (err) {
    console.error('initWhatsAppPayment error:', err);
    res.status(500).json({ error: 'Failed to create order.' });
  }
};

// ── Admin: manually credit tokens after WhatsApp payment ───
exports.adminCreditTokens = async (req, res) => {
  try {
    const { reference } = req.params;
    const { rows } = await db.query(
      `SELECT t.*, s.full_name, s.email FROM token_transactions t
       JOIN students s ON s.id = t.student_id
       WHERE t.reference=$1`, [reference]
    );
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found.' });
    const tx = rows[0];
    if (tx.status === 'completed') return res.json({ message: 'Already credited.' });

    await db.query(
      `UPDATE token_transactions SET status='completed', completed_at=NOW() WHERE reference=$1`, [reference]
    );
    await db.query(
      `UPDATE students SET token_balance=COALESCE(token_balance,0)+$1 WHERE id=$2`,
      [tx.tokens, tx.student_id]
    );

    // Send confirmation email
    if (tx.email) {
      await sendEmail({
        to: tx.email,
        subject: `✅ ${tx.tokens} Tokens Added — Scholars Syndicate`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;">
          <h2 style="color:#6c63ff;">🎓 Scholars Syndicate</h2>
          <p>Hi <strong>${tx.full_name}</strong>, your payment has been confirmed!</p>
          <div style="background:#f0edff;border-radius:12px;padding:20px;text-align:center;margin:16px 0;">
            <div style="font-size:42px;font-weight:900;color:#6c63ff;">+${tx.tokens}</div>
            <div style="color:#636e72;">tokens added to your account</div>
          </div>
          <p style="color:#636e72;font-size:13px;">Use tokens for AI Tutor, Arena hosting, extra spins, PDF downloads and more.</p>
          <p style="color:#636e72;font-size:12px;">Thank you for supporting Scholars Syndicate! 🚀</p>
        </div>`,
      });
    }

    res.json({ success: true, tokens_credited: tx.tokens, student: tx.full_name });
  } catch (err) {
    console.error('adminCreditTokens error:', err);
    serverError(res, err);
  }
};

// ── Paystack: initialize (for when verified) ───────────────
exports.initializePayment = async (req, res) => {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(503).json({ error: 'Paystack not yet enabled. Please use WhatsApp payment.' });
  }
  try {
    const { bundleId } = req.body;
    const bundle = BUNDLES.find(b => b.id === bundleId);
    if (!bundle) return res.status(400).json({ error: 'Invalid bundle.' });

    const student = req.student;
    const ref     = `SS_TOK_${student.id}_${Date.now()}`;

    const body = JSON.stringify({
      email: student.email, amount: bundle.amount, reference: ref,
      metadata: {
        student_id: student.id, bundle_id: bundle.id, tokens: bundle.tokens,
        custom_fields: [
          { display_name:'Student', variable_name:'student', value: student.full_name },
          { display_name:'Bundle',  variable_name:'bundle',  value: bundle.label },
        ],
      },
      callback_url: `${process.env.FRONTEND_URL || 'https://cbt-frontend-umber.vercel.app'}/dashboard?payment=success`,
    });

    const result = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname:'api.paystack.co', path:'/transaction/initialize', method:'POST',
        headers: { Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, ps => { let d=''; ps.on('data',c=>d+=c); ps.on('end',()=>{ try{resolve(JSON.parse(d))}catch{reject(new Error('parse error'))} }); });
      r.on('error', reject); r.write(body); r.end();
    });

    if (!result.status) return res.status(400).json({ error: result.message || 'Paystack error' });

    await db.query(
      `INSERT INTO token_transactions (student_id, reference, bundle_id, tokens, amount_kobo, status)
       VALUES ($1,$2,$3,$4,$5,'pending') ON CONFLICT (reference) DO NOTHING`,
      [student.id, ref, bundle.id, bundle.tokens, bundle.amount]
    );

    res.json({ authorization_url: result.data.authorization_url, reference: ref });
  } catch (err) {
    console.error('initializePayment error:', err);
    res.status(500).json({ error: 'Payment initialization failed.' });
  }
};

// ── Paystack: verify payment ───────────────────────────────
exports.verifyPayment = async (req, res) => {
  try {
    const { reference } = req.params;
    const result = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname:'api.paystack.co', path:`/transaction/verify/${encodeURIComponent(reference)}`, method:'GET',
        headers: { Authorization:`Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      }, ps => { let d=''; ps.on('data',c=>d+=c); ps.on('end',()=>{ try{resolve(JSON.parse(d))}catch{reject(new Error('parse error'))} }); });
      r.on('error',reject); r.end();
    });

    if (!result.status || result.data?.status !== 'success')
      return res.status(400).json({ error: 'Payment not successful.' });

    const { student_id: sid, tokens } = result.data.metadata;
    if (!tokens || !sid) return res.status(400).json({ error: 'Invalid metadata.' });

    const tx = await db.query(
      `UPDATE token_transactions SET status='completed', completed_at=NOW()
       WHERE reference=$1 AND status='pending' RETURNING id`, [reference]
    );
    if (!tx.rows.length) return res.json({ message: 'Already processed.' });

    await db.query(
      `UPDATE students SET token_balance=COALESCE(token_balance,0)+$1 WHERE id=$2`, [tokens, sid]
    );

    const { rows } = await db.query('SELECT full_name, email FROM students WHERE id=$1', [sid]);
    if (rows[0]?.email) {
      await sendEmail({
        to: rows[0].email,
        subject: `✅ ${tokens} Tokens Added — Scholars Syndicate`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;">
          <h2 style="color:#6c63ff;">🎓 Scholars Syndicate</h2>
          <p>Hi <strong>${rows[0].full_name}</strong>, payment confirmed! <strong>${tokens} tokens</strong> added.</p>
        </div>`,
      });
    }
    res.json({ success: true, tokens_added: tokens });
  } catch (err) {
    console.error('verifyPayment error:', err);
    res.status(500).json({ error: 'Verification failed.' });
  }
};

// ── Paystack webhook ───────────────────────────────────────
exports.webhook = async (req, res) => {
  try {
    const crypto = require('crypto');
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '')
      .update(JSON.stringify(req.body)).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) return res.status(401).send('Invalid signature');
    if (req.body.event === 'charge.success') {
      await exports.verifyPayment({ params: { reference: req.body.data.reference } }, { json:()=>{}, status:()=>({json:()=>{}}) });
    }
    res.sendStatus(200);
  } catch { res.sendStatus(200); }
};

// ── Get token balance + bundles ────────────────────────────
exports.getBalance = async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT COALESCE(token_balance,0) as token_balance FROM students WHERE id=$1', [req.student.id]
    );
    res.json({
      token_balance: parseInt(rows[0]?.token_balance || 0),
      costs:   TOKEN_COSTS,
      bundles: BUNDLES,
      paystack_enabled: !!process.env.PAYSTACK_SECRET_KEY,
      whatsapp_number:  process.env.BUSINESS_WHATSAPP || '',
    });
  } catch (err) { serverError(res, err); }
};

// ── Spend tokens (internal) ────────────────────────────────
exports.spendTokens = async (studentId, feature) => {
  const cost = TOKEN_COSTS[feature];
  if (!cost) throw new Error(`Unknown feature: ${feature}`);

  const { rows } = await db.query(
    `UPDATE students SET token_balance=COALESCE(token_balance,0)-$1
     WHERE id=$2 AND COALESCE(token_balance,0)>=$1 RETURNING token_balance`,
    [cost, studentId]
  );
  if (!rows.length) {
    const err = new Error('Insufficient tokens.');
    err.code = 'INSUFFICIENT_TOKENS'; err.cost = cost; err.feature = feature;
    throw err;
  }
  // FIX: wrap in .catch so a log failure never causes the caller to 500
  // after the balance has already been deducted
  await db.query(
    `INSERT INTO token_transactions (student_id, feature, tokens, amount_kobo, status, reference, completed_at)
     VALUES ($1,$2,$3,0,'spent',$4,NOW())`,
    [studentId, feature, -cost, `SPEND_${feature}_${Date.now()}`]
  ).catch(() => {});
  return rows[0].token_balance;
};

// ── Transaction history ────────────────────────────────────
exports.getHistory = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, bundle_id, feature, tokens, amount_kobo, status, completed_at, created_at
       FROM token_transactions WHERE student_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.student.id]
    );
    res.json({ transactions: rows });
  } catch (err) { serverError(res, err); }
};

// ── Premium migration warning (called on login) ────────────
exports.checkPremiumMigration = async (studentId) => {
  try {
    const { rows } = await db.query(
      `SELECT id, full_name, email, is_premium, premium_expires_at, migration_warned FROM students WHERE id=$1`,
      [studentId]
    );
    const s = rows[0];
    if (!s?.is_premium || !s.premium_expires_at || s.migration_warned) return null;

    const daysLeft = (new Date(s.premium_expires_at) - new Date()) / (1000*60*60*24);
    if (daysLeft > 2) return null;

    await db.query('UPDATE students SET migration_warned=true WHERE id=$1', [studentId]);
    const daysText = daysLeft < 1 ? 'less than 24 hours' : `${Math.ceil(daysLeft)} day(s)`;

    if (s.email) {
      await sendEmail({
        to: s.email,
        subject: '⚠️ Your Scholars Syndicate Premium is Expiring — Switch to Tokens',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px;">
          <h2 style="color:#6c63ff;">🎓 Scholars Syndicate</h2>
          <p>Hi <strong>${s.full_name}</strong>,</p>
          <p>Your Premium membership expires in <strong>${daysText}</strong>.</p>
          <p>We've moved to a flexible <strong>Token System</strong>. Buy tokens and use only what you need:</p>
          <ul style="line-height:2;">
            <li>🤖 AI Tutor message = <strong>1 token</strong></li>
            <li>⚔️ Host Arena battle = <strong>2 tokens</strong></li>
            <li>🎰 Extra daily spin = <strong>1 token</strong></li>
            <li>📄 PDF download = <strong>1 token</strong></li>
            <li>📊 Predicted score = <strong>3 tokens</strong></li>
          </ul>
          <p>Starting from just <strong>₦200 for 50 tokens</strong>. Pay via WhatsApp — quick and easy.</p>
          <a href="${process.env.FRONTEND_URL||'https://cbt-frontend-umber.vercel.app'}/tokens"
             style="display:inline-block;padding:12px 24px;background:#6c63ff;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;">
            Get Tokens →
          </a>
        </div>`,
      });
    }

    return {
      warned: true, daysLeft,
      message: `Your premium expires in ${daysText}. Switch to tokens to keep using AI Tutor and premium features.`,
    };
  } catch (err) {
    console.error('checkPremiumMigration error:', err);
    return null;
  }
};

exports.BUNDLES     = BUNDLES;
exports.TOKEN_COSTS = TOKEN_COSTS;


// ── REWARD AD CREDIT ──────────────────────────────────────
// POST /api/tokens/reward-ad
// Called by the frontend after a student completes watching a reward ad.
// Rate-limited to 5 times per day per student to prevent abuse.
exports.rewardAdCredit = async (req, res) => {
  const student_id = req.student.id;
  const TOKENS_PER_AD = 5;
  const DAILY_LIMIT   = 5; // max 25 tokens/day from ads

  try {
    // Check how many times they've earned ad tokens today
    const today = new Date().toISOString().split("T")[0];
    const countRes = await db.query(
      `SELECT COUNT(*) FROM token_transactions
       WHERE student_id=$1 AND type='reward_ad' AND created_at::date=$2::date`,
      [student_id, today]
    );
    const todayCount = parseInt(countRes.rows[0].count);
    if (todayCount >= DAILY_LIMIT) {
      return res.status(429).json({
        error: `You've reached the daily limit of ${DAILY_LIMIT} reward ads. Come back tomorrow!`
      });
    }

    // Credit tokens
    await db.query(
      "UPDATE students SET token_balance = token_balance + $1 WHERE id = $2",
      [TOKENS_PER_AD, student_id]
    );
    await db.query(
      `INSERT INTO token_transactions (student_id, amount, type, description, created_at)
       VALUES ($1,$2,'reward_ad','Earned from watching a reward ad',NOW())`,
      [student_id, TOKENS_PER_AD]
    ).catch(() => {}); // silent if table schema differs

    const bal = await db.query("SELECT token_balance FROM students WHERE id=$1", [student_id]);
    res.json({
      ok: true,
      tokens_earned: TOKENS_PER_AD,
      new_balance:   bal.rows[0]?.token_balance ?? 0,
      ads_today:     todayCount + 1,
      ads_remaining: DAILY_LIMIT - todayCount - 1,
    });
  } catch (err) {
    serverError(res, err);
  }
};
