/**
 * adminParentInviteController.js — Scholars Syndicate
 * NEW FEATURE: Admin-generated unique parent portal links.
 *
 * Flow:
 *  1. Admin opens a student's profile in the admin panel
 *  2. Admin clicks "Generate Parent Link" (optionally pre-fills parent name/phone)
 *  3. Backend creates a one-time token valid for 7 days
 *  4. Admin copies the link (e.g. https://scholarssyndicate.app/parent-access/AB12CD34...)
 *     and shares it with the parent directly via WhatsApp/SMS
 *  5. Parent opens the link, sets a password, and is taken straight to their
 *     read-only performance portal — no student dashboard involvement at all.
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const db     = require("../config/db");
const { serverError } = require('../utils/errors');

const INVITE_EXPIRY_DAYS = 7;

function generateToken() {
  return crypto.randomBytes(24).toString("hex"); // 48-char URL-safe token
}

// ── ADMIN: GENERATE INVITE LINK ───────────────────────────
// POST /api/admin/students/:student_id/parent-invite
// Body: { parent_name?, parent_phone? }
exports.createInvite = async (req, res) => {
  const { student_id } = req.params;
  const { parent_name, parent_phone } = req.body || {};
  const admin_id = req.admin?.id || null;

  try {
    const studentRes = await db.query(
      "SELECT id, full_name FROM students WHERE id=$1",
      [student_id]
    );
    if (!studentRes.rows.length) {
      return res.status(404).json({ error: "Student not found." });
    }

    // Invalidate any previous unused invites for this student to avoid confusion
    await db.query(
      "UPDATE parent_invites SET used=true WHERE student_id=$1 AND used=false",
      [student_id]
    );

    const token      = generateToken();
    const expires_at = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO parent_invites (token, student_id, created_by, parent_name, parent_phone, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [token, student_id, admin_id, parent_name || null, parent_phone || null, expires_at]
    );

    const baseUrl = process.env.FRONTEND_URL || "https://scholarssyndicate.vercel.app";
    const link     = `${baseUrl}/parent-access/${token}`;

    res.json({
      ok:        true,
      link,
      token,
      student:   studentRes.rows[0].full_name,
      expires_at,
    });
  } catch (err) {
    console.error("createInvite error:", err.message);
    serverError(res, err);
  }
};

// ── ADMIN: LIST INVITES FOR A STUDENT ─────────────────────
// GET /api/admin/students/:student_id/parent-invites
exports.listInvites = async (req, res) => {
  const { student_id } = req.params;
  try {
    const r = await db.query(
      `SELECT id, token, parent_name, parent_phone, used, used_at, expires_at, created_at
       FROM parent_invites WHERE student_id=$1 ORDER BY created_at DESC`,
      [student_id]
    );
    res.json({ invites: r.rows });
  } catch (err) {
    serverError(res, err);
  }
};

// ── ADMIN: REVOKE INVITE ──────────────────────────────────
// DELETE /api/admin/parent-invites/:id
exports.revokeInvite = async (req, res) => {
  try {
    await db.query("UPDATE parent_invites SET used=true WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
  }
};

// ── PUBLIC: CHECK INVITE (before showing setup form) ──────
// GET /api/parent/invite/:token
exports.checkInvite = async (req, res) => {
  const { token } = req.params;
  try {
    const r = await db.query(
      `SELECT pi.id, pi.used, pi.expires_at, pi.parent_name, pi.parent_phone,
              s.full_name AS student_name, s.school_class
       FROM parent_invites pi
       JOIN students s ON s.id = pi.student_id
       WHERE pi.token = $1`,
      [token]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Invalid invite link." });

    const inv = r.rows[0];
    if (inv.used) return res.status(410).json({ error: "This invite link has already been used." });
    if (new Date(inv.expires_at) < new Date()) {
      return res.status(410).json({ error: "This invite link has expired. Please request a new one." });
    }

    res.json({
      valid:         true,
      student_name:  inv.student_name,
      school_class:  inv.school_class,
      parent_name:   inv.parent_name,
      parent_phone:  inv.parent_phone,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── PUBLIC: ACCEPT INVITE — create parent account ─────────
// POST /api/parent/invite/:token/accept
// Body: { full_name, email, phone, password }
exports.acceptInvite = async (req, res) => {
  const { token } = req.params;
  const { full_name, email, phone, password } = req.body;

  if (!full_name?.trim()) return res.status(400).json({ error: "Full name is required." });
  if (!email?.trim())     return res.status(400).json({ error: "Email is required." });
  if (!password || password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  try {
    const invRes = await db.query(
      "SELECT * FROM parent_invites WHERE token=$1",
      [token]
    );
    if (!invRes.rows.length) return res.status(404).json({ error: "Invalid invite link." });

    const invite = invRes.rows[0];
    if (invite.used) return res.status(410).json({ error: "This invite link has already been used." });
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: "This invite link has expired." });
    }

    // Check email not already used
    const existing = await db.query(
      "SELECT id FROM parents WHERE LOWER(email)=LOWER($1)",
      [email.trim()]
    );
    if (existing.rows.length) {
      return res.status(400).json({ error: "An account with this email already exists. Please log in instead." });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      `INSERT INTO parents (full_name, email, phone, password_hash, student_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, full_name, email, student_id`,
      [full_name.trim(), email.trim().toLowerCase(), phone || invite.parent_phone || null, hash, invite.student_id]
    );

    // Mark invite as used
    await db.query(
      "UPDATE parent_invites SET used=true, used_at=NOW() WHERE id=$1",
      [invite.id]
    );

    const parent = result.rows[0];
    const jwtToken = jwt.sign(
      { id: parent.id, role: "parent", student_id: invite.student_id },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.status(201).json({
      token:  jwtToken,
      parent,
      message: "Parent portal set up successfully!",
    });
  } catch (err) {
    console.error("acceptInvite error:", err.message);
    serverError(res, err);
  }
};
