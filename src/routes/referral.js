/**
 * SCHOLARS SYNDICATE — REFERRAL SYSTEM
 * =====================================
 * Drop this file into your backend routes folder as: routes/referral.js
 * Then add to your main app.js / index.js:
 *   const referralRoutes = require("./routes/referral");
 *   app.use("/api/referral", referralRoutes);
 *
 * STEP 1: Run this SQL migration on your database first (PostgreSQL):
 *
 *   ALTER TABLE students
 *     ADD COLUMN IF NOT EXISTS referral_code    VARCHAR(20)  UNIQUE,
 *     ADD COLUMN IF NOT EXISTS referred_by      VARCHAR(20)  DEFAULT NULL,
 *     ADD COLUMN IF NOT EXISTS referral_count   INTEGER      DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS referral_days    INTEGER      DEFAULT 0;
 *
 *   -- Auto-generate referral codes for existing students
 *   UPDATE students
 *   SET referral_code = CONCAT('SCH', LPAD(id::text, 6, '0'))
 *   WHERE referral_code IS NULL;
 *
 * STEP 2: Update your /api/auth/register route to call handleReferral()
 *   See the section marked "ADD TO REGISTER ROUTE" below.
 *
 * STEP 3: Update your /api/auth/profile route to return referral fields.
 *   See the section marked "ADD TO PROFILE RESPONSE" below.
 */

const express = require("express");
const router  = express.Router();
const db      = require("../config/db"); // FIX BUG 2: was ../db // adjust path to your DB connection
const { requireStudent: auth } = require("../middleware/auth"); // FIX BUG 2: destructure requireStudent

// ─────────────────────────────────────────────────────────
// REFERRAL REWARD CONFIG
// ─────────────────────────────────────────────────────────
// NOTE: the referrer's reward (20 tokens, per ReferEarn.js) no longer
// fires here — it's handled by referralRewardHelper.js once the referred
// student completes their first real exam, closing the fraud gap where
// disposable accounts could farm rewards with zero real engagement.
const NEW_STUDENT_WELCOME_TOKENS = 15; // matches ReferEarn.js "friend gets 15 free tokens"

// ─────────────────────────────────────────────────────────
// GET /api/referral/stats
// Returns current student's referral stats
// ─────────────────────────────────────────────────────────
router.get("/stats", auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT referral_code, referral_count,
              (SELECT COUNT(*) FROM students WHERE referred_by = s.referral_code) AS confirmed_referrals
       FROM students s WHERE id = $1`,
      [req.student.id]
    );
    const student = result.rows[0];
    if (!student) return res.status(404).json({ error: "Student not found" });

    res.json({
      referral_code:        student.referral_code,
      count:                parseInt(student.referral_count) || 0,
      // real token total actually credited, not a client-side estimate
      tokens_earned:        (parseInt(student.referral_count) || 0) * 20,
      confirmed_referrals:  parseInt(student.confirmed_referrals) || 0,
    });
  } catch (err) {
    console.error("Referral stats error:", err);
    res.status(500).json({ error: "Failed to fetch referral stats" });
  }
});

// ─────────────────────────────────────────────────────────
// HELPER: handleReferral(newStudentId, referralCode)
// Call this inside your /api/auth/register handler
// after successfully creating the new student.
// Only marks the relationship + gives the NEW student their welcome
// bonus. The referrer's reward is granted later, on first exam
// completion — see referralRewardHelper.js.
// ─────────────────────────────────────────────────────────
async function handleReferral(newStudentId, referralCode) {
  if (!referralCode) return;

  try {
    // Find the referrer by their referral_code
    const referrerResult = await db.query(
      "SELECT id FROM students WHERE referral_code = $1",
      [referralCode]
    );
    if (!referrerResult.rows.length) return; // invalid code — silently ignore

    const referrer = referrerResult.rows[0];
    if (referrer.id === newStudentId) return; // can't refer yourself

    // Mark new student as referred + give their welcome bonus immediately
    // (low fraud risk — it's a one-time grant tied to their own new account,
    // not something that scales by farming multiple invites)
    await db.query(
      `UPDATE students
       SET referred_by   = $1,
           token_balance = COALESCE(token_balance,0) + $2
       WHERE id = $3`,
      [referralCode, NEW_STUDENT_WELCOME_TOKENS, newStudentId]
    );

    console.log(`✅ Referral: student ${newStudentId} referred by ${referralCode} — welcome bonus granted, referrer reward pending first exam.`);
  } catch (err) {
    // Never let referral errors break registration
    console.error("Referral handling error (non-fatal):", err);
  }
}

// ─────────────────────────────────────────────────────────
// HELPER: generateReferralCode(studentId)
// Call this when creating a new student to generate their code
// ─────────────────────────────────────────────────────────
function generateReferralCode(studentId) {
  return `SCH${String(studentId).padStart(6, "0")}`;
}

module.exports = router;
module.exports.handleReferral      = handleReferral;
module.exports.generateReferralCode = generateReferralCode;


// ═══════════════════════════════════════════════════════════
// ADD TO REGISTER ROUTE
// In your routes/auth.js, inside POST /register, after creating the student:
// ═══════════════════════════════════════════════════════════
/*
const { handleReferral, generateReferralCode } = require("./referral");

// After INSERT INTO students ... RETURNING id:
const newStudentId = result.rows[0].id;

// Generate and save their referral code
const referralCode = generateReferralCode(newStudentId);
await db.query(
  "UPDATE students SET referral_code = $1 WHERE id = $2",
  [referralCode, newStudentId]
);

// Process referral if they came via a ref link
const { referred_by } = req.body; // frontend sends this field
await handleReferral(newStudentId, referred_by);
*/


// ═══════════════════════════════════════════════════════════
// ADD TO PROFILE RESPONSE
// In your routes/auth.js, GET /profile, add these fields to the response:
// ═══════════════════════════════════════════════════════════
/*
// In your SELECT query, add these columns:
//   referral_code, referred_by, referral_count, referral_days

// In the JSON response, include:
res.json({
  id:                   student.id,
  full_name:            student.full_name,
  email:                student.email,
  // ... other existing fields ...
  referral_code:        student.referral_code,
  referral_count:       student.referral_count || 0,
  referral_days:        student.referral_days  || 0,
  // ... rest of fields
});
*/
