const db = require("../config/db");
const { serverError } = require('../utils/errors');

// ── GEM PACKAGES ──────────────────────────────────────────
const GEM_PACKAGES = [
  { id: "gem_50",    gems: 50,    price: 100,   label: "Starter Pack",   icon: "💎", popular: false },
  { id: "gem_120",   gems: 120,   price: 200,   label: "Scholar Pack",   icon: "💎💎", popular: false },
  { id: "gem_350",   gems: 350,   price: 500,   label: "Elite Pack",     icon: "💎💎💎", popular: true  },
  { id: "gem_800",   gems: 800,   price: 1000,  label: "Champion Pack",  icon: "👑", popular: false },
  { id: "gem_1800",  gems: 1800,  price: 2000,  label: "Legend Pack",    icon: "🌟", popular: false },
  { id: "gem_5000",  gems: 5000,  price: 5000,  label: "Titan Pack",     icon: "⚡", popular: false },
  { id: "gem_17000", gems: 17000, price: 15000, label: "Metaverse Pack", icon: "🔱", popular: false },
];

// ── GET gem packages ──────────────────────────────────────
exports.getPackages = async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT COALESCE(gems,0) as gems, COALESCE(coins,0) as coins FROM students WHERE id=$1",
      [req.student.id]
    );
    res.json({
      packages: GEM_PACKAGES,
      gems:  rows[0]?.gems  || 0,
      coins: rows[0]?.coins || 0,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── PURCHASE gems (mock payment — integrate real gateway later) ──
exports.purchaseGems = async (req, res) => {
  try {
    const { package_id, payment_reference } = req.body;
    if (!package_id) return res.status(400).json({ error: "package_id required" });

    const pkg = GEM_PACKAGES.find(p => p.id === package_id);
    if (!pkg) return res.status(400).json({ error: "Invalid package" });

    // FIX BUG 29: This endpoint must only be called by admins or after verified payment.
    // It is now guarded by requireAdmin in gemRoutes.js.
    // Students purchase via WhatsApp + voucher redemption — see /vouchers/redeem.
    if (!payment_reference) {
      return res.status(400).json({ error: "Payment reference required. Purchase gems via the store and redeem your voucher code." });
    }
    const { rows } = await db.query(
      `UPDATE students SET gems = COALESCE(gems,0) + $1 WHERE id=$2
       RETURNING COALESCE(gems,0) as gems`,
      [pkg.gems, req.student.id]
    );

    // Log the transaction
    await db.query(
      `INSERT INTO gem_transactions (student_id, package_id, gems_awarded, amount_naira, payment_ref)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [req.student.id, pkg.id, pkg.gems, pkg.price, payment_reference || null]
    ).catch(() => {}); // table may not exist yet — safe fail

    res.json({
      success: true,
      gems_awarded: pkg.gems,
      total_gems: rows[0]?.gems || pkg.gems,
      message: `+${pkg.gems} Gems added to your wallet!`,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── SPEND gems (internal helper used by other controllers) ─
exports.spendGems = async (student_id, amount, reason) => {
  // FIX: atomic deduct — prevents race-condition double-spend
  const { rows } = await db.query(
    "UPDATE students SET gems = gems - $1 WHERE id=$2 AND COALESCE(gems,0) >= $1 RETURNING COALESCE(gems,0) as gems",
    [amount, student_id]
  );
  if (!rows.length) throw new Error("Insufficient gems");
  return rows[0].gems;
};

// ── SPEND coins (internal helper) ─────────────────────────
exports.spendCoins = async (student_id, amount) => {
  // FIX: atomic deduct — prevents race-condition double-spend
  const { rows } = await db.query(
    "UPDATE students SET coins = coins - $1 WHERE id=$2 AND COALESCE(coins,0) >= $1 RETURNING COALESCE(coins,0) as coins",
    [amount, student_id]
  );
  if (!rows.length) throw new Error("Insufficient coins");
  return rows[0].coins;
};
