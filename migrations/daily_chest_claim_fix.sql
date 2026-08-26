-- ── DAILY CHEST CLAIM RACE FIX ──────────────────────────────
-- treasureChestController.claimDailyChest used to check "already claimed
-- today?" with a separate SELECT before the INSERT — not atomic, so two
-- concurrent requests (double-tap, retry-on-slow-network) could both pass
-- the check and insert two daily chests, double-paying the daily reward.
--
-- daily_claim_key gives Postgres something to enforce uniqueness on
-- directly: one value per student per calendar day. A concurrent
-- duplicate INSERT now fails the UNIQUE constraint (handled as ON
-- CONFLICT DO NOTHING in the controller) instead of racing past a
-- read-then-write gap. NULL for non-daily chests (source != 'daily'),
-- which don't need this guard — a student can have many of those.
ALTER TABLE student_chests
  ADD COLUMN IF NOT EXISTS daily_claim_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_chests_daily_claim
  ON student_chests(daily_claim_key) WHERE daily_claim_key IS NOT NULL;
