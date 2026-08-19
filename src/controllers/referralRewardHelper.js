/**
 * referralRewardHelper.js
 * ─────────────────────────────────────────────────────────
 * Fixes three bugs in the original referral system:
 *
 * 1. ReferEarn.js promises "20 tokens per friend" / "15 free tokens" —
 *    the old routes/referral.js never touched token_balance at all,
 *    it only silently extended premium_expires_at. Users referring
 *    friends got a reward that didn't match what they were shown.
 *
 * 2. The badge system's "Referral King" badge reads a column called
 *    referrals_count, but the old reward logic only ever incremented
 *    referral_count (no 's') — so the badge could never be earned.
 *
 * 3. The old reward fired instantly at registration with zero
 *    verification, which is a straightforward premium-day farming
 *    vector via disposable accounts. This version only pays out once
 *    the referred student has actually completed a real exam —
 *    matching what ReferEarn.js's "How it works" section already
 *    promises the user, so the UI and the backend now agree.
 */
const db = require('../config/db');

const REFERRER_TOKENS = 20; // matches ReferEarn.js "You earn 20 tokens per friend"

// Matches the TIERS array in cbt-frontend/src/pages/ReferEarn.js exactly —
// keep these two in sync if either changes.
const MILESTONE_BONUSES = { 5: 100, 10: 250, 25: 500, 50: 1000 };

async function rewardReferralOnFirstExam(referredStudentId) {
  // Only proceed if this student was actually referred by someone,
  // and hasn't already triggered a reward for it.
  const { rows } = await db.query(
    `SELECT referred_by, referral_reward_claimed FROM students WHERE id = $1`,
    [referredStudentId]
  );
  const student = rows[0];
  if (!student || !student.referred_by || student.referral_reward_claimed) return;

  // Confirm this is genuinely their first-ever completed exam, not just
  // the first exam of the session that happens to be checking in.
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM exam_sessions WHERE student_id = $1`,
    [referredStudentId]
  );
  if (countRows[0].n !== 1) return; // not their first exam — reward already handled or n/a

  // Find the referrer
  const { rows: referrerRows } = await db.query(
    `SELECT id FROM students WHERE referral_code = $1`,
    [student.referred_by]
  );
  const referrer = referrerRows[0];
  if (!referrer) return; // referral code no longer resolves to anyone — ignore quietly

  // Mark this student's reward as claimed FIRST (idempotency guard) so a
  // race between two rapid requests can't double-pay the referrer.
  const claim = await db.query(
    `UPDATE students SET referral_reward_claimed = true
     WHERE id = $1 AND (referral_reward_claimed IS NOT TRUE)
     RETURNING id`,
    [referredStudentId]
  );
  if (!claim.rows.length) return; // someone else's concurrent call already claimed it

  const updateRes = await db.query(
    `UPDATE students
     SET token_balance     = COALESCE(token_balance,0) + $1,
         referral_count    = COALESCE(referral_count,0) + 1,
         referrals_count   = COALESCE(referrals_count,0) + 1
     WHERE id = $2
     RETURNING referrals_count`,
    [REFERRER_TOKENS, referrer.id]
  );

  console.log(`✅ Referral reward: student ${referrer.id} earned ${REFERRER_TOKENS} tokens for referring ${referredStudentId}`);

  // Milestone bonus — the new referrals_count just crossed a tier boundary
  const newCount = updateRes.rows[0]?.referrals_count;
  const bonus = MILESTONE_BONUSES[newCount];
  if (bonus) {
    await db.query(
      `UPDATE students SET token_balance = COALESCE(token_balance,0) + $1 WHERE id = $2`,
      [bonus, referrer.id]
    );
    console.log(`🎉 Referral milestone: student ${referrer.id} hit ${newCount} referrals — +${bonus} bonus tokens`);
  }

  // Re-check badges now that referrals_count moved — lets the referral
  // badges unlock immediately instead of waiting for the referrer's next action.
  try {
    const { checkBadgesForStudent } = require('./badgesController');
    await checkBadgesForStudent(referrer.id, null);
  } catch (e) {
    // Badge check failing shouldn't block the token reward that already landed.
  }
}

module.exports = { rewardReferralOnFirstExam };
