-- ═══════════════════════════════════════════════════════════════
-- Referral reward system fix — supporting column
-- ═══════════════════════════════════════════════════════════════
-- referral_reward_claimed: idempotency guard so a referred student's
-- first-exam completion can only ever trigger their referrer's reward
-- once, even under concurrent requests.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS referral_reward_claimed BOOLEAN NOT NULL DEFAULT FALSE;

-- Anyone who already has a completed exam AND was referred, under the
-- OLD (instant, unverified) reward system, already got paid — mark them
-- claimed so they can't be paid a second time under the new logic.
UPDATE students s
SET referral_reward_claimed = TRUE
WHERE s.referred_by IS NOT NULL
  AND EXISTS (SELECT 1 FROM exam_sessions es WHERE es.student_id = s.id);
