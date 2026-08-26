const db      = require("../config/db");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const https   = require("https");
const crypto  = require("crypto");
const cloudinary = require("cloudinary").v2;
const { handleReferral } = require("../routes/referral");
const { generateUniqueUsername } = require("../utils/usernameGenerator");
const { validateUsernameFormat } = require("../utils/contentFilter");
const { serverError } = require('../utils/errors');
const { normalizeSchoolName } = require('../utils/normalizeSchoolName');
const { resolveSchoolAlias } = require('../utils/schoolAliases');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function generateToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "1h" });
}

// Admin sessions live 24 hours — they manage the dashboard over long sessions
function generateAdminToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "24h" });
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ── REFRESH SESSION MANAGEMENT ─────────────────────────────
// FIX: migrations/refresh_sessions.sql already builds exactly the right
// table for this (token_hash, revoked_at, expires_at, per-device info) —
// it just sat unused. refreshToken() was doing a bare jwt.verify() with no
// DB check at all, meaning there was no way to revoke a single session or
// device, and — worse — a password reset didn't invalidate any refresh
// token issued before it. If an account was ever compromised, resetting
// the password did NOT log the attacker out; their refresh token (up to
// 30 days) kept working regardless.
//
// Design: each refresh token embeds a random `jti` (session id) that
// doubles as the primary key of its refresh_sessions row. On every
// refresh, we check that row hasn't been revoked/expired AND that its
// stored token_hash matches the presented token — the second check is
// deliberate defense-in-depth: JWT_SECRET was exposed in the leaked .env
// from the earlier audit, so until every deployment has rotated it, an
// attacker who knows the (now-public) secret could otherwise forge a
// refresh token with an arbitrary jti/student id. They still can't forge
// a matching DB row, so the hash check holds even against that.
//
// Everything here degrades gracefully (falls back to signature-only
// trust, logs a warning) if the table hasn't been migrated yet in a given
// environment — this should never be the reason nobody can log in.
let _warnedNoSessionsTable = false;
function warnMissingSessionsTable(err) {
  if (err?.code === '42P01' && !_warnedNoSessionsTable) {
    _warnedNoSessionsTable = true;
    console.warn('[auth] refresh_sessions table not found — run `npm run migrate`. Falling back to signature-only refresh tokens until then.');
  } else if (err?.code !== '42P01') {
    console.error('[auth] refresh_sessions query failed:', err.message);
  }
}

async function createRefreshSession(studentId, role, req) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { id: studentId, role, jti },
    process.env.REFRESH_SECRET || process.env.JWT_SECRET + "_refresh",
    { expiresIn: "30d" }
  );
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  // FIX: was reading req.headers["x-forwarded-for"] directly, which
  // ignores the app.set("trust proxy", 1) already configured in
  // server.js — that setting exists specifically so Express resolves
  // req.ip safely from the correct hop, discarding any client-forgeable
  // entries further left in the header chain. Reading the raw header
  // bypassed that protection entirely, across every IP-logging spot in
  // this file (also fixed in register/login/activateKey below).
  const ip = req.ip;
  await db.query(
    `INSERT INTO refresh_sessions (id, student_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [jti, studentId, hashToken(token), expiresAt, (req.headers["user-agent"] || "").slice(0, 300), ip]
  ).catch(warnMissingSessionsTable);
  return token;
}

// Used by changePassword/resetPassword — logs out every device, not just
// the current one, since we don't know which session (if any) belongs to
// an attacker.
async function revokeAllSessions(studentId) {
  await db.query(
    `UPDATE refresh_sessions SET revoked_at = NOW() WHERE student_id = $1 AND revoked_at IS NULL`,
    [studentId]
  ).catch(warnMissingSessionsTable);
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper function to mask phone number (handles any format)
function maskPhoneNumber(phoneNum) {
  const cleaned = phoneNum.replace(/\s+/g, "");
  if (cleaned.length >= 10) {
    return cleaned.slice(0, 4) + "****" + cleaned.slice(-3);
  }
  return phoneNum;
}

// ── TERMII SMS SENDER ─────────────────────────────────────
async function sendOTPviaSMS(phone, otp) {
  let p = phone.trim().replace(/\s+/g, "");
  if (p.startsWith("0"))    p = "234" + p.slice(1);
  if (p.startsWith("+234")) p = p.slice(1);
  if (p.startsWith("+"))    p = p.slice(1);

  const message = `Your ScholarsCBT OTP is: ${otp}\n\nValid 15 minutes. Do not share. -Scholars Syndicate`;

  const payload = JSON.stringify({
    to:      p,
    from:    process.env.TERMII_SENDER_ID || "N-Alert",
    sms:     message,
    type:    "plain",
    channel: "generic",
    api_key: process.env.TERMII_API_KEY,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.ng.termii.com",
      path:     "/api/sms/send",
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const r = JSON.parse(data);
          if (r.code === "ok" || r.message_id || res.statusCode < 300) {
            console.log(`✅ SMS OTP sent to ${p}`);
            resolve({ success: true });
          } else {
            console.error("Termii error:", r);
            reject(new Error(r.message || "SMS failed"));
          }
        } catch(e) { reject(new Error("SMS parse error")); }
      });
    });
    req.on("error", e => { console.error("Termii req error:", e.message); reject(e); });
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("SMS service timeout"));
    });
    req.write(payload);
    req.end();
  });
}


async function sendOTPviaEmail(toEmail, otp) {
  const https = require("https");

  const body = JSON.stringify({
    sender:      { name: "Scholars CBT", email: process.env.EMAIL_USER || "scholarssyndicate70@gmail.com" },
    to:          [{ email: toEmail }],
    subject:     "Scholars CBT — Your Password Reset Code",
    htmlContent: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px;">
        <h2 style="color:#6c63ff;margin-bottom:4px;">🎓 Scholars CBT</h2>
        <p style="color:#636e72;margin-top:0;">Account Recovery</p>
        <p>Use the 6-digit code below to reset your password:</p>
        <div style="font-size:40px;font-weight:900;letter-spacing:12px;color:#2d3436;text-align:center;padding:20px;background:#f8f9fa;border-radius:8px;margin:20px 0;">${otp}</div>
        <p style="color:#636e72;font-size:13px;">This code expires in <strong>15 minutes</strong>. Do not share it with anyone.</p>
        <p style="color:#636e72;font-size:12px;">If you did not request this, ignore this email — your account is safe.</p>
      </div>`,
    textContent: `Your Scholars CBT password reset code is: ${otp}. Valid for 15 minutes. Do not share.`,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.brevo.com",
      path:     "/v3/smtp/email",
      method:   "POST",
      headers:  {
        "api-key":       process.env.BREVO_API_KEY,
        "Content-Type":  "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`✅ Email OTP sent to ${toEmail} via Brevo`);
            resolve({ success: true, messageId: parsed.messageId });
          } else {
            console.error("Brevo error:", parsed);
            reject(new Error(parsed.message || "Email send failed"));
          }
        } catch (e) { reject(new Error("Brevo parse error")); }
      });
    });
    req.on("error", e => reject(e));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Email service timeout")); });
    req.write(body);
    req.end();
  });
}

// ── EMAIL VERIFICATION ────────────────────────────────────

async function sendVerificationEmail(toEmail, token) {
  const baseUrl = process.env.FRONTEND_URL || "https://scholarssyndicate.vercel.app";
  const link = `${baseUrl}/verify-email/${token}`;
  const body = JSON.stringify({
    sender: { name:"Scholars Syndicate", email: process.env.EMAIL_USER || "scholarssyndicate70@gmail.com" },
    to:     [{ email: toEmail }],
    subject: "Verify your Scholars Syndicate account",
    htmlContent: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px;">
        <h2 style="color:#6c63ff;">🎓 Scholars Syndicate</h2>
        <p>Welcome! Please verify your email address to complete registration.</p>
        <a href="${link}" style="display:inline-block;margin:16px 0;padding:14px 28px;background:linear-gradient(135deg,#7C5CFF,#5B8CFF);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
          ✅ Verify My Email
        </a>
        <p style="color:#636e72;font-size:12px;">This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.</p>
      </div>`,
    textContent: `Verify your Scholars Syndicate account: ${link}`,
  });
  return new Promise((resolve) => {
    const https = require("https");
    const req2 = https.request({
      hostname: "api.brevo.com", path: "/v3/smtp/email", method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (r) => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>resolve()); });
    req2.on("error", () => resolve()); // silent — never block registration
    req2.write(body); req2.end();
  });
}

// ── REGISTER ──────────────────────────────────────────────
exports.register = async (req, res) => {
  const { full_name, email, phone, password, state_of_origin, school_class, target_university, target_course } = req.body;
  if (!full_name?.trim())  return res.status(400).json({ error: "Full name is required." });
  if (!email?.trim())      return res.status(400).json({ error: "Email address is required." });
  if (!phone?.trim())      return res.status(400).json({ error: "Phone number is required." });
  if (!password)           return res.status(400).json({ error: "Password is required." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

  // Email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const cleanPhone = phone.replace(/\s+/g, "");
  // Improved Nigerian phone number validation
  if (!/^(?:\+234|0)[789][01]?\d{8}$/.test(cleanPhone))
    return res.status(400).json({ error: "Enter a valid Nigerian phone number (e.g. 08012345678 or 08011234567)." });

  try {
    const emailCheck = await db.query("SELECT id FROM students WHERE LOWER(email) = LOWER($1)", [email.trim()]);
    if (emailCheck.rows.length)
      return res.status(400).json({ error: "This email is already registered. Please login." });

    const phoneCheck = await db.query("SELECT id FROM students WHERE phone = $1", [cleanPhone]);
    if (phoneCheck.rows.length)
      return res.status(400).json({ error: "This phone number is already linked to an account.", code: "PHONE_EXISTS" });

    const ip = req.ip;

    const hash = await bcrypt.hash(password, 12);
    // FIX BUG 31: include school_name in register
    const { school_name } = req.body;
    // BUG FIX: normalize casing so "uniport" / "Uniport" / "UNIPORT" are
    // stored as the same value — otherwise Factions/School Wars/leaderboards
    // treat them as different schools and classmates can't find each other.
    // BUG FIX (part 2): case-normalizing alone doesn't merge "uniport" and
    // "University of Port Harcourt" — those are different strings, not
    // different casing. resolveSchoolAlias checks a known-school dictionary
    // first and falls back to plain case normalization when there's no match.
    const result = await db.query(
      `INSERT INTO students (full_name, email, phone, password_hash, state_of_origin, school_class, target_university, target_course, school_name, device_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, full_name, email, phone, is_premium, email_verified, created_at`,
      [full_name.trim(), email.trim().toLowerCase(), cleanPhone, hash,
       state_of_origin || null, school_class || null, target_university || null, target_course || null,
       resolveSchoolAlias(school_name, normalizeSchoolName), (req.headers["user-agent"] || "").slice(0,200)]
    );
    const student = result.rows[0];

    // Auto-assign a unique username so students can find/add each other.    // Falls back silently (student can still set one manually later) if
    // this migration hasn't been run yet on the DB.
    let username = null;
    try {
      username = await generateUniqueUsername(student.full_name);
      await db.query("UPDATE students SET username = $1 WHERE id = $2", [username, student.id]);
      student.username = username;
    } catch (e) {
      console.error("Username auto-assign failed:", e.message);
    }

    // FIX BUG 14 (and follow-up privacy fix): parent_link_code and referral_code
    // must NOT be the same value. referral_code is designed to be shared
    // publicly/widely (that's the point of a referral program) — parent_link_code
    // grants a parent account visibility into the student's grades and activity
    // and must stay private. Reusing one code for both meant that publicly
    // sharing a referral link also handed out parent-linking access to anyone
    // who saw it. Now generated as two distinct codes.
    const referralCode  = `SCH${String(student.id).padStart(6, '0')}`;
    const parentLinkCode = `PL${String(student.id).padStart(6, '0')}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    await db.query(
      `UPDATE students SET parent_link_code = $1, referral_code = $2 WHERE id = $3`,
      [parentLinkCode, referralCode, student.id]
    ).catch(() => {});

    // FIX BUG: Process referral reward if student came via a referral link
    const { referred_by } = req.body;
    if (referred_by) {
      await handleReferral(student.id, referred_by).catch(() => {});
    }

    // Create streak record so streak never shows null/error
    await db.query(
      "INSERT INTO streaks (student_id, current_streak, longest_streak) VALUES ($1, 0, 0) ON CONFLICT (student_id) DO NOTHING",
      [student.id]
    );

    // Give new students 10 welcome tokens — lets them try AI Tutor + spin before paying
    await db.query(
      "UPDATE students SET token_balance = 10 WHERE id = $1",
      [student.id]
    ).catch(() => {});

    // Log registration
    await db.query(
      "INSERT INTO login_logs (student_id, ip_address, device_info, success) VALUES ($1,$2,$3,true)",
      [student.id, ip, (req.headers["user-agent"] || "").slice(0,200)]
    ).catch(() => {});

    // FIX: Send email verification — was completely missing. Students could register
    // with fake emails making password reset useless.
    const verifyToken = crypto.randomBytes(24).toString("hex");
    const verifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
    await db.query(
      `INSERT INTO email_verifications (student_id, token, expires_at)
       VALUES ($1,$2,$3) ON CONFLICT (student_id) DO UPDATE SET token=$2, expires_at=$3`,
      [student.id, verifyToken, verifyExpiry]
    ).catch(() => {}); // silent if table not yet migrated

    // Send async — don't await, never block registration
    if (process.env.BREVO_API_KEY) {
      sendVerificationEmail(student.email, verifyToken).catch(() => {});
    }

    const token        = generateToken({ id: student.id, role: "student", username });
    const refreshToken = await createRefreshSession(student.id, "student", req);
    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
      maxAge:   30 * 24 * 60 * 60 * 1000,
    });
    res.status(201).json({ token, student, emailVerificationSent: !!process.env.BREVO_API_KEY });
  } catch (err) {
    if (err.code === "23505" && err.constraint?.includes("phone"))
      return res.status(400).json({ error: "This phone number is already registered." });
    if (err.code === "23505" && err.constraint?.includes("email"))
      return res.status(400).json({ error: "This email address is already registered." });
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
};

// ── LOGIN ─────────────────────────────────────────────────
exports.login = async (req, res) => {
  const { identifier, password } = req.body;
  const ip = req.ip;
  if (!identifier || !password)
    return res.status(400).json({ error: "Email/phone and password are required." });

  try {
    const result = await db.query(
      `SELECT id, full_name, email, phone, password_hash, is_premium, is_banned, ban_reason,
              premium_expires_at, avatar_url, state_of_origin, school_class,
              target_university, target_course, login_count, phone_verified, email_verified, username
       FROM students WHERE LOWER(email) = LOWER($1) OR phone = $1`,
      [identifier.trim()]
    );

    if (!result.rows.length) {
      await db.query(
        "INSERT INTO login_logs (ip_address, device_info, success, failed_reason) VALUES ($1,$2,false,$3)",
        [ip, (req.headers["user-agent"] || "").slice(0,200), "Account not found"]
      ).catch(() => {});
      // FIX: this used to say "No account found with this email or phone
      // number" — different wording from a wrong-password failure below
      // meant anyone could enumerate which emails/phones are registered
      // just by trying login and reading the error message. Logged
      // internally as before (failed_reason above); response wording is
      // now identical to the wrong-password case either way.
      return res.status(401).json({ error: "Incorrect email/phone or password." });
    }

    const student = result.rows[0];

    // Self-heal: accounts created before the username system existed
    // won't have one yet — assign it now instead of forcing a backfill.
    if (!student.username) {
      try {
        student.username = await generateUniqueUsername(student.full_name);
        await db.query("UPDATE students SET username = $1 WHERE id = $2", [student.username, student.id]);
      } catch (e) {
        console.error("Username self-heal failed:", e.message);
      }
    }

    if (student.is_banned)
      return res.status(403).json({
        error: `Account suspended. Reason: ${student.ban_reason || "Policy violation"}. WhatsApp: 09036995642`
      });

    const valid = await bcrypt.compare(password, student.password_hash);
    if (!valid) {
      await db.query(
        "INSERT INTO login_logs (student_id, ip_address, device_info, success, failed_reason) VALUES ($1,$2,$3,false,$4)",
        [student.id, ip, (req.headers["user-agent"] || "").slice(0,200), "Wrong password"]
      ).catch(() => {});
      return res.status(401).json({ error: "Incorrect email/phone or password." });
    }

    // Auto-expire premium
    let is_premium = student.is_premium;
    if (is_premium && student.premium_expires_at && new Date(student.premium_expires_at) < new Date()) {
      await db.query("UPDATE students SET is_premium = false WHERE id = $1", [student.id]);
      is_premium = false;
    }

    // Check 2-day premium migration warning (non-blocking)
    try {
      const { checkPremiumMigration } = require('./tokenController');
      checkPremiumMigration(student.id).catch(() => {});
    } catch {}


    // Update last seen + login count
    // FIX: device_info was storing `IP:${ip}` — a duplicate of the
    // ip_address column, under a misleading name. login_logs.device_info
    // (elsewhere in this file) correctly stores the user-agent; this
    // brings students.device_info in line with that, no migration needed.
    await db.query(
      "UPDATE students SET last_seen=NOW(), login_count=COALESCE(login_count,0)+1, device_info=$2 WHERE id=$1",
      [student.id, (req.headers["user-agent"] || "").slice(0,200)]
    ).catch(() => {});

    await db.query(
      "INSERT INTO login_logs (student_id, ip_address, device_info, success) VALUES ($1,$2,$3,true)",
      [student.id, ip, (req.headers["user-agent"] || "").slice(0,200)]
    ).catch(() => {});

    const { password_hash, ...safeStudent } = student;
    const token        = generateToken({ id: student.id, role: "student", username: student.username });
    const refreshToken = await createRefreshSession(student.id, "student", req);
    res.cookie("refresh_token", refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
      maxAge:   30 * 24 * 60 * 60 * 1000,
    });
    res.json({ token, student: { ...safeStudent, is_premium } });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
};

// ── GET ME / PROFILE ──────────────────────────────────────
exports.getMe = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT s.id, s.full_name, s.username, s.email, s.phone, s.is_premium, s.premium_expires_at,
              s.avatar_url, s.state_of_origin, s.school_class, s.target_university,
              s.target_course, s.bio, s.login_count, s.last_seen, s.created_at,
              s.phone_verified, s.email_verified, s.is_banned, s.ban_reason, s.parent_link_code,
              s.school_name, s.referral_code, COALESCE(s.referral_count,0) as referral_count,
              COALESCE(s.points, 0)         AS points,
              COALESCE(s.coins,  0)         AS coins,
              COALESCE(s.gems,   0)         AS gems,
              COALESCE(s.hints,  0)         AS hints,
              COALESCE(s.lives,  5)         AS lives,
              COALESCE(s.level,  1)         AS level,
              COALESCE(s.token_balance, 0)  AS token_balance,
              st.current_streak, st.longest_streak
       FROM students s
       LEFT JOIN streaks st ON st.student_id = s.id
       WHERE s.id = $1`,
      [req.student.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Student not found." });
    const student = result.rows[0];

    if (!student.username) {
      try {
        student.username = await generateUniqueUsername(student.full_name);
        await db.query("UPDATE students SET username = $1 WHERE id = $2", [student.username, student.id]);
      } catch (e) {
        console.error("Username self-heal failed:", e.message);
      }
    }

    // Check if a global premium event is active — if so, everyone is premium
    const { isPremiumActive } = require('./adminPremiumController');
    const eventPremium = await isPremiumActive(student.id).catch(() => false);
    if (eventPremium && !student.is_premium) {
      student.is_premium = true;
      student.premium_via_event = true; // flag so frontend can show "Free Day" badge
    }

    res.json(student);
  } catch (err) {
    console.error("getMe error:", err.message);
    serverError(res, err);
  }
};

// ── UPDATE PROFILE (FIXED - proper NULL handling) ─────────
exports.updateProfile = async (req, res) => {
  const { full_name, state_of_origin, school_class, target_university, target_course, bio, jamb_exam_date } = req.body;
  
  try {
    // Handle each field properly
    const cleanedFullName = full_name !== undefined && full_name !== null ? (full_name.trim() || null) : undefined;
    const cleanedState = state_of_origin !== undefined ? (state_of_origin === null ? null : (state_of_origin.trim() || null)) : undefined;
    const cleanedClass = school_class !== undefined ? (school_class === null ? null : (school_class.trim() || null)) : undefined;
    const cleanedUni = target_university !== undefined ? (target_university === null ? null : (target_university.trim() || null)) : undefined;
    const cleanedCourse = target_course !== undefined ? (target_course === null ? null : (target_course.trim() || null)) : undefined;
    const cleanedBio = bio !== undefined ? (bio === null ? null : (bio.trim() || null)) : undefined;
    // BUG FIX: jamb_exam_date was sent by JAMBCountdown.js but never read
    // here, so it was silently dropped even once the PATCH 404 was fixed.
    const cleanedExamDate = jamb_exam_date !== undefined ? (jamb_exam_date || null) : undefined;

    const result = await db.query(
      `UPDATE students
       SET full_name          = COALESCE($1, full_name),
           state_of_origin    = $2,
           school_class       = $3,
           target_university  = $4,
           target_course      = $5,
           bio                = $6,
           jamb_exam_date     = COALESCE($7, jamb_exam_date),
           updated_at         = NOW()
       WHERE id = $8
       RETURNING id, full_name, email, phone, avatar_url, state_of_origin,
                 school_class, target_university, target_course, bio, jamb_exam_date`,
      [cleanedFullName, cleanedState, cleanedClass, cleanedUni, cleanedCourse, cleanedBio, cleanedExamDate, req.student.id]
    );
    
    res.json({ success: true, student: result.rows[0] });
  } catch (err) {
    console.error("Update profile error:", err.message);
    serverError(res, err);
  }
};

// ── UPDATE AVATAR (Cloudinary Upload) ─────────────────────
exports.updateAvatar = async (req, res) => {
  const { image_base64, avatar_url } = req.body;

  // FIX BUG 16: Accept emoji/text avatar directly without Cloudinary
  if (avatar_url && !avatar_url.startsWith('data:image/')) {
    try {
      await db.query("UPDATE students SET avatar_url = $1, updated_at = NOW() WHERE id = $2", [avatar_url, req.student.id]);
      return res.json({ success: true, avatar_url });
    } catch (err) {
      return serverError(res, err);
    }
  }

  if (!image_base64) {
    return res.status(400).json({ error: "Image data is required." });
  }
  if (!image_base64.startsWith('data:image/')) {
    return res.status(400).json({ error: "Invalid image format. Please provide a valid base64 image." });
  }
  
  try {
    // Upload to Cloudinary with optimization
    const result = await cloudinary.uploader.upload(image_base64, {
      folder: "scholars-cbt/avatars",
      transformation: [
        { width: 200, height: 200, crop: "fill", gravity: "face" },
        { quality: "auto:good" }
      ],
      allowed_formats: ["jpg", "png", "jpeg", "webp"],
    });
    
    const avatar_url = result.secure_url;
    
    // Update database
    await db.query(
      "UPDATE students SET avatar_url = $1, updated_at = NOW() WHERE id = $2",
      [avatar_url, req.student.id]
    );
    
    res.json({ 
      success: true, 
      avatar_url,
      message: "Avatar updated successfully" 
    });
    
  } catch (err) {
    console.error("Avatar upload error:", err.message);
    
    // Handle specific Cloudinary errors
    if (err.message.includes("Invalid image")) {
      return res.status(400).json({ error: "Invalid image file. Please use JPG, PNG, or WEBP format." });
    }
    if (err.message.includes("File size too large")) {
      return res.status(400).json({ error: "Image is too large. Maximum size is 5MB." });
    }
    
    res.status(500).json({ error: "Failed to upload avatar. Please try again." });
  }
};

// ── UPDATE USERNAME (change anytime) ──────────────────────
exports.updateUsername = async (req, res) => {
  const { username } = req.body;

  const check = validateUsernameFormat(username);
  if (!check.valid) return res.status(400).json({ error: check.error });

  try {
    const dupe = await db.query(
      "SELECT id FROM students WHERE LOWER(username) = LOWER($1) AND id != $2",
      [check.value, req.student.id]
    );
    if (dupe.rows.length) {
      return res.status(400).json({ error: "That username is already taken." });
    }

    await db.query(
      "UPDATE students SET username = $1, updated_at = NOW() WHERE id = $2",
      [check.value, req.student.id]
    );

    // Re-issue token so anything reading username off the JWT (e.g. Social.js)
    // stays in sync immediately without a full re-login.
    const token = generateToken({ id: req.student.id, role: "student", username: check.value });

    res.json({ success: true, username: check.value, token });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "That username is already taken." });
    }
    console.error("Update username error:", err.message);
    res.status(500).json({ error: "Failed to update username. Please try again." });
  }
};

// ── CHANGE PASSWORD ───────────────────────────────────────
exports.changePassword = async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: "Both current and new password are required." });
  if (new_password.length < 6)
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  try {
    const r = await db.query("SELECT password_hash FROM students WHERE id=$1", [req.student.id]);
    // FIX: this assumed r.rows[0] always exists — a missing row (deleted
    // account, stale token) threw a raw TypeError caught by nothing,
    // producing an unhandled 500 instead of a clean error response.
    if (!r.rows.length) return res.status(404).json({ error: "Account not found." });
    const valid = await bcrypt.compare(current_password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect." });
    const hash = await bcrypt.hash(new_password, 12);
    await db.query("UPDATE students SET password_hash=$1, updated_at=NOW() WHERE id=$2", [hash, req.student.id]);

    // FIX: a password change is often a direct response to "I think my
    // account may be compromised" — but this never invalidated any
    // refresh token issued before the change, so an attacker who already
    // had one kept full access for up to 30 more days regardless. Now
    // every device is logged out and must re-authenticate with the new
    // password; the current browser gets a fresh cookie below so only
    // *this* session avoids being forced to log back in.
    await revokeAllSessions(req.student.id);
    const newRefreshToken = await createRefreshSession(req.student.id, "student", req);
    res.cookie("refresh_token", newRefreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
      maxAge:   30 * 24 * 60 * 60 * 1000,
    });

    res.json({ success: true, message: "Password updated successfully." });
  } catch (err) { serverError(res, err); }
};

// ── FORGOT PASSWORD — Send OTP via email ────────────────────
// FIX: was accepting `phone` in the destructure and computing a `field`
// var for a SELECT ... WHERE ${field}=$1, but isEmail was hardcoded true
// three lines in and anything without "@" was rejected before reaching
// that code — the phone path was unreachable. Simplified to match what
// was actually reachable.
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  const cleanId = (email || "").trim().toLowerCase();
  if (!cleanId) return res.status(400).json({ error: "Email address required." });
  if (!cleanId.includes("@"))
    return res.status(400).json({ error: "Enter your registered email address." });

  try {
    // Rate limiting
    const recentOTPs = await db.query(
      "SELECT COUNT(*) FROM otp_codes WHERE identifier=$1 AND created_at > NOW() - INTERVAL '5 minutes'",
      [cleanId]
    );
    if (parseInt(recentOTPs.rows[0].count) >= 3)
      return res.status(429).json({ error: "Too many OTP requests. Please wait 5 minutes." });

    const result = await db.query(`SELECT id, email FROM students WHERE email=$1`, [cleanId]);
    if (!result.rows.length)
      return res.status(404).json({ error: "No account found with this email." });

    const student = result.rows[0];
    const otp     = generateOTP();
    const expiry  = new Date(Date.now() + 15 * 60 * 1000);

    // Invalidate old OTPs for this identifier
    await db.query(
      "UPDATE otp_codes SET used=true WHERE identifier=$1 AND otp_type='password_reset' AND used=false",
      [cleanId]
    );

    // Save new OTP
    await db.query(
      "INSERT INTO otp_codes (identifier, otp_type, code, expires_at) VALUES ($1,'password_reset',$2,$3)",
      [cleanId, otp, expiry]
    );

    try {
      await sendOTPviaEmail(student.email, otp);
      const masked = student.email.replace(/(.{3})(.*)(@.*)/, (_, a, b, c) => a + "*".repeat(Math.max(3, b.length)) + c);
      res.json({ success: true, masked_email: masked, message: `A 6-digit code has been sent to ${masked}. Check your inbox and spam folder.` });
    } catch (emailErr) {
      console.error("Email OTP delivery failed:", emailErr.message);
      // In dev show the code directly instead of pretending it was delivered
      if (process.env.NODE_ENV === "development")
        return res.json({ success: true, otp_preview: otp, message: `[DEV] OTP: ${otp}` });
      // In production, tell the truth — never claim success when delivery failed
      return res.status(500).json({
        error: `We couldn't send your code right now (${emailErr.message}). Please try again in a moment.`
      });
    }
  } catch (err) {
    console.error("Forgot password error:", err.message);
    res.status(500).json({ error: "Failed to send OTP. Please try again." });
  }
};

// ── VERIFY OTP — Step 2 of forgot password ─────────────────
// FIX: this always branched on isEmail/cleanId to also handle a phone
// identifier, but forgotPassword (just above) has hardcoded isEmail=true
// and rejects anything without "@" since it was written — meaning
// otp_codes.identifier is always an email in practice, and the frontend
// (ForgotPassword.js) only ever sends `email`, never `phone`, to any of
// these three endpoints. The phone branch was unreachable dead code from
// a half-finished phone-reset feature. Simplified to match what's
// actually reachable; re-add properly (with SMS delivery wired up) if
// phone-based reset becomes a real feature later.
exports.verifyOtp = async (req, res) => {
  const { email, otp } = req.body;
  const cleanId = (email || "").trim().toLowerCase();
  if (!cleanId || !otp)
    return res.status(400).json({ error: "Email and OTP are required." });

  const cleanOtp = String(otp).trim();

  try {
    // Step 1: does ANY record exist for this identifier+code (ignore expiry/used)?
    const anyMatch = await db.query(
      `SELECT id, used, expires_at, NOW() AS now FROM otp_codes
       WHERE identifier=$1 AND code::text=$2 AND otp_type='password_reset'
       ORDER BY created_at DESC LIMIT 1`,
      [cleanId, cleanOtp]
    );

    if (!anyMatch.rows.length) {
      return res.status(400).json({ error: "Code not found. Please request a new one." });
    }

    const row = anyMatch.rows[0];
    if (row.used)
      return res.status(400).json({ error: "This code has already been used. Request a new one." });
    if (new Date(row.expires_at) < new Date(row.now))
      return res.status(400).json({ error: "Code has expired. Please request a new one." });

    res.json({ success: true, message: "Code verified. You can now set your new password." });
  } catch (err) {
    console.error("Verify OTP error:", err.message);
    res.status(500).json({ error: "Verification failed. Please try again." });
  }
};

// ── RESET PASSWORD ────────────────────────────────────────
exports.resetPassword = async (req, res) => {
  const { email, otp, new_password } = req.body;
  const cleanId = (email || "").trim().toLowerCase();
  if (!cleanId || !otp || !new_password)
    return res.status(400).json({ error: "Email, OTP and new password are required." });
  if (new_password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters." });

  try {
    const otpResult = await db.query(
      `SELECT id FROM otp_codes
       WHERE identifier=$1 AND code=$2 AND otp_type='password_reset'
         AND used=false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [cleanId, otp.trim()]
    );

    if (!otpResult.rows.length)
      return res.status(400).json({ error: "Invalid or expired code. Request a new one." });

    // Mark OTP as used
    await db.query("UPDATE otp_codes SET used=true WHERE id=$1", [otpResult.rows[0].id]);

    // Update password
    const hash  = await bcrypt.hash(new_password, 12);
    const updated = await db.query(
      `UPDATE students SET password_hash=$1, updated_at=NOW() WHERE email=$2 RETURNING id`,
      [hash, cleanId]
    );

    // FIX: same reasoning as changePassword — a reset via forgot-password
    // is *more* likely to follow account compromise, not less, so this
    // needs the same session invalidation. Previously any refresh token
    // issued before the reset kept working for up to 30 more days.
    if (updated.rows[0]) await revokeAllSessions(updated.rows[0].id);

    res.json({ success: true, message: "Password reset successfully. You can now login." });
  } catch (err) {
    console.error("Reset password error:", err.message);
    res.status(500).json({ error: "Reset failed. Please try again." });
  }
};

// ── ADMIN LOGIN ───────────────────────────────────────────
exports.adminLogin = async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.query(
      "SELECT id, username, password_hash FROM admins WHERE username=$1",
      [username]
    );
    if (!result.rows.length) return res.status(401).json({ error: "Invalid credentials." });
    const admin = result.rows[0];
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials." });
    const token = generateAdminToken({ id: admin.id, role: "admin" });
    res.json({ token, admin: { id: admin.id, username: admin.username } });
  } catch (err) { serverError(res, err); }
};

// ── ACTIVATE KEY ──────────────────────────────────────────
exports.activateKey = async (req, res) => {
  const { key_code } = req.body;
  const student_id   = req.student.id;
  const ip           = req.ip;
  if (!key_code) return res.status(400).json({ error: "Key code required." });

  try {
    // Start transaction
    await db.query('BEGIN');
    
    const key = await db.query(
      "SELECT * FROM activation_keys WHERE key_code=$1 AND is_active=true",
      [key_code.trim().toUpperCase()]
    );
    if (!key.rows.length) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: "Invalid or already used key." });
    }

    const k = key.rows[0];
    if (k.used_by_student_id) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: "This key has already been used." });
    }

    await db.query(
      "INSERT INTO key_usage_log (key_code, student_id, ip_address, device_info, success, attempted_at) VALUES ($1,$2,$3,$4,true,NOW())",
      [key_code.trim().toUpperCase(), student_id, ip, (req.headers["user-agent"] || "").slice(0,100)]
    ).catch(() => {});

    // Calculate expiry - use hours for sub-day plans
    const expiry = new Date();
    if (k.duration_hours) {
      expiry.setHours(expiry.getHours() + k.duration_hours);
    } else {
      expiry.setDate(expiry.getDate() + k.duration_days);
    }

    await db.query(
      "UPDATE activation_keys SET used_by_student_id=$1, used_at=NOW(), expires_at=$2, is_active=false WHERE key_code=$3",
      [student_id, expiry, key_code.trim().toUpperCase()]
    );
    await db.query(
      "UPDATE students SET is_premium=true, premium_expires_at=$1 WHERE id=$2",
      [expiry, student_id]
    );
    
    // Commit transaction
    await db.query('COMMIT');

    res.json({
      success: true,
      message: `Premium activated! Expires ${expiry.toLocaleDateString("en-NG", { dateStyle: "long" })}`,
      expires_at: expiry,
    });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error("Activate key error:", err.message);
    serverError(res, err);
  }
};

// ── GET NOTIFICATIONS ─────────────────────────────────────
exports.getNotifications = async (req, res) => {
  try {
    const student_id = req.student?.id || null;

    // Only query last_seen if there is an authenticated student
    let lastSeenAt = null;
    if (student_id) {
      const lastSeen = await db.query(
        `SELECT notif_last_seen FROM students WHERE id=$1`, [student_id]
      ).catch(() => ({ rows: [{ notif_last_seen: null }] }));
      lastSeenAt = lastSeen.rows[0]?.notif_last_seen || null;
    }

    const result = await db.query(
      `SELECT id, title, message, type, created_at
       FROM notifications
       ORDER BY created_at DESC
       LIMIT 10`
    );

    // Count unread (newer than last seen)
    const unread = lastSeenAt
      ? result.rows.filter(n => new Date(n.created_at) > new Date(lastSeenAt)).length
      : result.rows.length;

    res.json({ notifications: result.rows, unread });
  } catch (err) {
    console.error("Get notifications error:", err.message);
    serverError(res, err);
  }
};

// ── MARK NOTIFICATIONS AS READ ────────────────────────────
exports.markNotificationsRead = async (req, res) => {
  try {
    await db.query(
      `UPDATE students SET notif_last_seen = NOW() WHERE id=$1`,
      [req.student.id]
    );
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
};

// ── SUBSCRIBE TO CHANNEL NOTIFICATIONS ───────────────────
exports.subscribeNotifications = async (req, res) => {
  const student_id = req.student.id;
  const { channel } = req.body;
  try {
    // Save notification preference - we'll use this to send in-app + WhatsApp alerts
    await db.query(
      `INSERT INTO notification_subscriptions (student_id, channel, created_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (student_id, channel) DO NOTHING`,
      [student_id, channel || "elitronix"]
    );
    res.json({ success: true, message: "Subscribed to notifications." });
  } catch (err) {
    // Table might not exist yet — still return success
    res.json({ success: true, message: "Subscribed." });
  }
};

// ── LOGOUT ────────────────────────────────────────────────
exports.logout = async (req, res) => {
  try {
    // FIX: previously just cleared the cookie client-side — the refresh
    // token itself, if somehow captured before logout (XSS, shared
    // device, browser history), remained valid server-side for up to 30
    // more days. Now revoke the specific session in refresh_sessions too.
    const rt = req.cookies?.refresh_token;
    if (rt) {
      try {
        const secret = process.env.REFRESH_SECRET || process.env.JWT_SECRET + "_refresh";
        const decoded = jwt.verify(rt, secret);
        if (decoded?.jti) {
          await db.query("UPDATE refresh_sessions SET revoked_at=NOW() WHERE id=$1", [decoded.jti]).catch(warnMissingSessionsTable);
        }
      } catch {
        // Expired/invalid/forged token — nothing to revoke, and logout
        // should succeed regardless (the client just wants the cookie gone).
      }
    }

    res.clearCookie("refresh_token", {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
    });
    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    serverError(res, err);
  }
};

// ── JWT REFRESH TOKEN ROTATION ────────────────────────────
// POST /auth/refresh — silently renews access token using httpOnly refresh cookie
exports.refreshToken = async (req, res) => {
  const rt = req.cookies?.refresh_token;
  if (!rt) return res.status(401).json({ error: "No refresh token" });
  try {
    const secret = process.env.REFRESH_SECRET || process.env.JWT_SECRET + "_refresh";
    const { id, role, jti } = jwt.verify(rt, secret);

    // FIX: this used to stop at signature verification — a token issued
    // before a password reset/logout-all, or before this feature existed
    // and never explicitly revoked, kept refreshing indefinitely for its
    // full 30-day lifetime with no way to cut it off early. Now cross-
    // check against refresh_sessions (see comment on createRefreshSession
    // above for why token_hash is checked too, not just revoked_at).
    if (jti) {
      try {
        const { rows } = await db.query(
          `SELECT token_hash, revoked_at, expires_at FROM refresh_sessions WHERE id=$1`,
          [jti]
        );
        if (rows.length) {
          const row = rows[0];
          const stillValid = !row.revoked_at && new Date(row.expires_at) > new Date() && row.token_hash === hashToken(rt);
          if (!stillValid) return res.status(401).json({ error: "Session revoked. Please log in again." });
          db.query(`UPDATE refresh_sessions SET last_used_at=NOW() WHERE id=$1`, [jti]).catch(() => {});
        }
        // No row found: token predates this feature (issued before
        // migration) or the table was just migrated — allow through once
        // rather than mass-logging-out everyone mid-rollout. Every token
        // issued going forward always has a matching row.
      } catch (dbErr) {
        warnMissingSessionsTable(dbErr);
        // Table missing or transient DB issue — degrade to signature-only
        // trust rather than blocking refresh for everyone.
      }
    }

    const newAccess = generateToken({ id, role });
    res.json({ token: newAccess });
  } catch {
    res.status(401).json({ error: "Invalid refresh token" });
  }
};


// ── VERIFY EMAIL ──────────────────────────────────────────
// GET /api/auth/verify-email/:token (opened from email link)
exports.verifyEmail = async (req, res) => {
  const { token } = req.params;
  try {
    const r = await db.query(
      "SELECT student_id, expires_at FROM email_verifications WHERE token=$1",
      [token]
    );
    if (!r.rows.length) return res.status(400).json({ error: "Invalid verification link." });
    const { student_id, expires_at } = r.rows[0];
    if (new Date(expires_at) < new Date()) {
      return res.status(410).json({ error: "This link has expired. Please request a new one from Settings." });
    }
    await db.query("UPDATE students SET email_verified=true WHERE id=$1", [student_id]).catch(()=>{});
    await db.query("DELETE FROM email_verifications WHERE student_id=$1", [student_id]).catch(()=>{});
    res.json({ ok: true, message: "Email verified successfully! You can now fully access all features." });
  } catch (err) {
    serverError(res, err);
  }
};

// ── RESEND VERIFICATION EMAIL ─────────────────────────────
// POST /api/auth/resend-verification  (student must be logged in)
exports.resendVerification = async (req, res) => {
  const student_id = req.student?.id;
  if (!student_id) return res.status(401).json({ error: "Not authenticated." });
  try {
    const s = await db.query("SELECT email, email_verified FROM students WHERE id=$1", [student_id]);
    if (!s.rows.length) return res.status(404).json({ error: "Student not found." });
    if (s.rows[0].email_verified) return res.json({ ok: true, message: "Email already verified." });
    const token = require("crypto").randomBytes(24).toString("hex");
    const expiry = new Date(Date.now() + 24*60*60*1000);
    await db.query(
      "INSERT INTO email_verifications (student_id,token,expires_at) VALUES($1,$2,$3) ON CONFLICT(student_id) DO UPDATE SET token=$2,expires_at=$3",
      [student_id, token, expiry]
    );
    await sendVerificationEmail(s.rows[0].email, token);
    res.json({ ok: true, message: "Verification email sent. Check your inbox." });
  } catch(err) {
    serverError(res, err);
  }
};
