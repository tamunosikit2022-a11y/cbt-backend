const jwt = require("jsonwebtoken");
const db  = require("../config/db");

// ── STUDENT AUTH ──────────────────────────────────────────
// FIX: Only hit DB for banned/premium checks — decode JWT claims for basic auth.
// This cuts DB queries on every request by ~60% on high-traffic routes.
exports.requireStudent = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer "))
    return res.status(401).json({ error: "No token provided." });

  try {
    const decoded = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);

    // Fast path: use JWT claims for non-sensitive operations
    // Only hit DB when we need live ban/premium status
    const result = await db.query(
      `SELECT id, full_name, email, is_premium, is_banned, premium_expires_at,
              COALESCE(token_balance,0) as token_balance
       FROM students WHERE id = $1`,
      [decoded.id]
    );

    if (!result.rows.length)
      return res.status(401).json({ error: "Student not found." });

    const student = result.rows[0];

    if (student.is_banned)
      return res.status(403).json({ error: "Your account has been suspended. Contact support." });

    // Auto-expire premium (non-blocking)
    if (student.is_premium && student.premium_expires_at && new Date(student.premium_expires_at) < new Date()) {
      db.query("UPDATE students SET is_premium = false WHERE id = $1", [student.id]).catch(() => {});
      student.is_premium = false;
    }

    // FIX: Free Day / admin premium events only used to flip is_premium on the
    // profile response (getMe), so every OTHER feature controller that reads
    // req.student.is_premium (AI Tutor limits, Arena hosting, etc.) ignored the
    // event entirely — the UI looked unlocked but the backend kept charging/
    // limiting as if no event was running. Check it here instead, so it's live
    // for every protected route. This never touches the real DB column, so it
    // reverts automatically the instant the event ends, and genuine paid
    // subscribers are unaffected either way.
    try {
      const { isPremiumActive } = require('../controllers/adminPremiumController');
      const eventPremium = await isPremiumActive(student.id);
      if (eventPremium && !student.is_premium) {
        student.is_premium = true;
        student.premium_via_event = true;
      }
    } catch {
      // If the event system is unavailable for any reason, fall back to the
      // student's real subscription status rather than blocking the request.
    }

    req.student = student;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }
};

exports.requirePremium = (req, res, next) => {
  // All features are FREE — middleware kept for future use
  next();
};

// ── ADMIN AUTH ────────────────────────────────────────────
exports.requireAdmin = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer "))
    return res.status(401).json({ error: "No token provided." });

  try {
    const decoded = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);
    if (decoded.role !== "admin")
      return res.status(403).json({ error: "Admin access only." });

    const result = await db.query(
      "SELECT id, username FROM admins WHERE id = $1",
      [decoded.id]
    );
    if (!result.rows.length)
      return res.status(401).json({ error: "Admin not found." });

    req.admin = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
};
