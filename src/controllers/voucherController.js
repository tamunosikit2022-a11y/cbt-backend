const db   = require("../config/db");
const crypto = require("crypto");
const { serverError } = require('../utils/errors');

// ── PACKAGES (mirror from gemController) ─────────────────
const GEM_PACKAGES = [
  { id: "gem_50",    gems: 50,    price: 100,   label: "Starter Pack"   },
  { id: "gem_120",   gems: 120,   price: 200,   label: "Scholar Pack"   },
  { id: "gem_350",   gems: 350,   price: 500,   label: "Elite Pack"     },
  { id: "gem_800",   gems: 800,   price: 1000,  label: "Champion Pack"  },
  { id: "gem_1800",  gems: 1800,  price: 2000,  label: "Legend Pack"    },
  { id: "gem_5000",  gems: 5000,  price: 5000,  label: "Titan Pack"     },
  { id: "gem_17000", gems: 17000, price: 15000, label: "Metaverse Pack" },
];

// ── Ensure table exists ───────────────────────────────────
const ensureTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS gem_vouchers (
      id            SERIAL PRIMARY KEY,
      code          TEXT NOT NULL UNIQUE,
      package_id    TEXT NOT NULL,
      gems          INTEGER NOT NULL,
      price_naira   INTEGER NOT NULL,
      label         TEXT NOT NULL,
      created_by    TEXT DEFAULT 'admin',
      redeemed_by   INTEGER REFERENCES students(id) ON DELETE SET NULL,
      redeemed_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      is_active     BOOLEAN DEFAULT true,
      note          TEXT
    )
  `).catch(() => {});
};

// ── GENERATE voucher (admin only) ─────────────────────────
exports.generateVoucher = async (req, res) => {
  try {
    await ensureTable();
    const { package_id, note, quantity = 1 } = req.body;

    const pkg = GEM_PACKAGES.find(p => p.id === package_id);
    if (!pkg) return res.status(400).json({ error: "Invalid package" });

    const qty   = Math.min(parseInt(quantity) || 1, 50);
    const codes = [];

    for (let i = 0; i < qty; i++) {
      // Format: GEM-XXXX-XXXX (easy to read/type)
      const raw  = crypto.randomBytes(4).toString("hex").toUpperCase();
      const code = `GEM-${raw.slice(0,4)}-${raw.slice(4,8)}`;

      await db.query(
        `INSERT INTO gem_vouchers (code, package_id, gems, price_naira, label, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [code, pkg.id, pkg.gems, pkg.price, pkg.label, note || null]
      );
      codes.push({ code, gems: pkg.gems, label: pkg.label, price: pkg.price });
    }

    res.json({ success: true, vouchers: codes, count: codes.length });
  } catch (err) {
    serverError(res, err);
  }
};

// ── LIST vouchers (admin only) ────────────────────────────
exports.listVouchers = async (req, res) => {
  try {
    await ensureTable();
    const { status = "all", page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * 50;

    let where = "";
    if (status === "unused")   where = "WHERE v.is_active=true AND v.redeemed_by IS NULL";
    if (status === "redeemed") where = "WHERE v.redeemed_by IS NOT NULL";
    if (status === "inactive") where = "WHERE v.is_active=false";

    const { rows } = await db.query(`
      SELECT v.*, s.full_name as redeemed_by_name, s.email as redeemed_by_email
      FROM gem_vouchers v
      LEFT JOIN students s ON s.id = v.redeemed_by
      ${where}
      ORDER BY v.created_at DESC
      LIMIT 50 OFFSET $1
    `, [offset]).catch(() => ({ rows: [] }));

    const countRes = await db.query(`SELECT COUNT(*) FROM gem_vouchers v ${where}`).catch(() => ({ rows:[{count:0}] }));

    // Stats
    const statsRes = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN redeemed_by IS NOT NULL THEN 1 END) as redeemed,
        COUNT(CASE WHEN is_active=true AND redeemed_by IS NULL THEN 1 END) as available,
        SUM(CASE WHEN redeemed_by IS NOT NULL THEN price_naira ELSE 0 END) as revenue
      FROM gem_vouchers
    `).catch(() => ({ rows:[{}] }));

    res.json({
      vouchers: rows,
      total:    parseInt(countRes.rows[0]?.count) || 0,
      stats:    statsRes.rows[0] || {},
      packages: GEM_PACKAGES,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── DEACTIVATE voucher (admin only) ──────────────────────
exports.deactivateVoucher = async (req, res) => {
  try {
    await ensureTable();
    const { code } = req.params;
    await db.query("UPDATE gem_vouchers SET is_active=false WHERE code=$1", [code]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
};

// ── REDEEM voucher (student) ──────────────────────────────
exports.redeemVoucher = async (req, res) => {
  try {
    await ensureTable();
    const { code } = req.body;
    const sid = req.student.id;

    if (!code) return res.status(400).json({ error: "Enter a voucher code" });

    const clean = code.trim().toUpperCase();

    // Find voucher
    const { rows } = await db.query(
      "SELECT * FROM gem_vouchers WHERE code=$1", [clean]
    ).catch(() => ({ rows: [] }));

    if (!rows.length)
      return res.status(400).json({ error: "Invalid voucher code. Check and try again." });

    const voucher = rows[0];

    if (!voucher.is_active)
      return res.status(400).json({ error: "This voucher has been deactivated." });

    if (voucher.redeemed_by)
      return res.status(400).json({ error: "This voucher has already been used." });

    // Credit gems
    const { rows: updated } = await db.query(
      "UPDATE students SET gems = COALESCE(gems,0) + $1 WHERE id=$2 RETURNING COALESCE(gems,0) as gems",
      [voucher.gems, sid]
    );

    // Mark redeemed
    await db.query(
      "UPDATE gem_vouchers SET redeemed_by=$1, redeemed_at=NOW() WHERE code=$2",
      [sid, clean]
    ).catch(() => {});

    res.json({
      success:    true,
      gems_added: voucher.gems,
      total_gems: updated[0]?.gems || voucher.gems,
      label:      voucher.label,
      message:    `🎉 ${voucher.gems} Tokens added to your wallet!`,
    });
  } catch (err) {
    serverError(res, err);
  }
};

exports.GEM_PACKAGES = GEM_PACKAGES;
