-- ── AD REWARD SESSIONS ────────────────────────────────────────
-- Closes the "instant scripted loop" gap in tokenController.rewardAdCredit:
-- the frontend's reward-ad flow was just a client-side 30-second
-- setInterval before a single POST /tokens/reward-ad call — the server
-- had no way to tell that call apart from someone scripting the same
-- request directly, skipping the wait (and the ad) entirely, up to the
-- existing 5/day cap.
--
-- This isn't a substitute for real ad-network server-side verification
-- (no rewarded-video SDK is wired into this app yet — the AdSense units
-- used elsewhere are display/interstitial, not rewarded), but it closes
-- the "instant, zero-effort, scriptable" version of the hole: a session
-- must be started first, and completion only credits tokens if the
-- server itself measures at least ~25s having actually elapsed since
-- that session started — not merely accepts a client's claim that time
-- passed. Swap this out for real SSV once an ad SDK is chosen.
CREATE TABLE IF NOT EXISTS ad_reward_sessions (
  id           UUID         PRIMARY KEY,
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  started_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '2 minutes')
);

CREATE INDEX IF NOT EXISTS idx_ad_reward_sessions_student ON ad_reward_sessions(student_id, started_at DESC);
