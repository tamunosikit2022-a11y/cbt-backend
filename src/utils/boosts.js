/**
 * src/utils/boosts.js
 * ─────────────────────────────────────────────────────────
 * FIX: "boost" rewards (double_xp, coin_magnet, etc.) have been handed
 * out by the treasure chest system, the regular spin wheel, and event
 * spins — but nothing anywhere in this codebase ever actually read a
 * boost back out and applied its effect. Chests wrote them into
 * student_skills (a table skillsController.useSkill never has effect
 * logic for beyond fifty_fifty/smart_hint/retry_shield); spins wrote them
 * into student_boosts with a real expiry, but no reward-awarding code
 * ever queried that table. Every "2× XP Boost" a student was ever told
 * they won was, up to this point, purely decorative.
 *
 * This is the missing read side: getActiveMultiplier() is called from
 * wherever XP/coins actually get awarded (currently wired into
 * examController.submitExam — the highest-traffic reward path) to check
 * for a live, unexpired multiplier boost and apply it.
 *
 * Multiplier-type boosts (xp/coins) are the ones implemented here.
 * rank_shield/streak_shield are protective/defensive effects, not
 * multipliers — they'd need their own consumption logic wired into
 * wherever rank loss / streak resets are actually computed, which is a
 * separate, larger investigation. They're still recorded in
 * student_boosts (so they're at least visible/trackable) but have no
 * effect yet — see the TODO below.
 */
const db = require('../config/db');

// boost_type → what it multiplies and by how much. Kept as separate keys
// per historical name rather than forcing a rename across three
// already-shipped systems — same effect, different names chosen
// independently by spinController ('xp2x'/'coin2x'), treasureChestController
// ('double_xp'/'coin_magnet'), and seasonCosmeticsController's event spins
// ('xp2x'/'coin_magnet', reusing spinController's naming).
const MULTIPLIER_BOOSTS = {
  xp2x:        { resource: 'xp',    factor: 2 },
  double_xp:   { resource: 'xp',    factor: 2 },
  coin2x:      { resource: 'coins', factor: 2 },
  coin_magnet: { resource: 'coins', factor: 2 },
};

// TODO: rank_shield (protects Arena rank from dropping on a loss) and
// streak_shield (protects a login streak from resetting after a missed
// day) are granted but not yet consumed anywhere — implementing them
// means finding wherever rank-loss and streak-reset are actually computed
// and checking student_boosts there before applying the penalty.

let _warnedMissingTable = false;
async function getActiveMultiplier(studentId, resource) {
  try {
    const { rows } = await db.query(
      `SELECT boost_type FROM student_boosts WHERE student_id=$1 AND expires_at > NOW()`,
      [studentId]
    );
    let factor = 1;
    for (const r of rows) {
      const def = MULTIPLIER_BOOSTS[r.boost_type];
      if (def && def.resource === resource) factor = Math.max(factor, def.factor);
    }
    return factor;
  } catch (err) {
    if (err.code === '42P01') {
      if (!_warnedMissingTable) {
        _warnedMissingTable = true;
        console.warn('[boosts] student_boosts table not found — boosts have no effect until migrated.');
      }
    } else {
      console.error('[boosts] getActiveMultiplier error:', err.message);
    }
    // Fail safe: no boost rather than blocking the underlying reward
    // (a broken boost lookup should never stop a student from getting
    // their base XP/coins for completing an exam).
    return 1;
  }
}

module.exports = { getActiveMultiplier, MULTIPLIER_BOOSTS };
