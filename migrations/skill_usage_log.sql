-- ── SKILL USAGE LOG ───────────────────────────────────────────
-- Closes a scoring-integrity gap in submitExam (examController.js):
-- Retry Shield is a real purchasable item (student_skills, 400 coins)
-- that's properly checked and decremented when legitimately activated via
-- POST /skills/use — but grading itself never verified that. submitExam
-- just trusted a client-supplied `shielded: true` flag on any answer,
-- with no server-side record to check it against. Anyone hitting
-- /exam/submit directly could mark every wrong answer "shielded" and get
-- a perfect score for free, which then fed leaderboards, badges, XP,
-- coins, and the referral-reward trigger.
--
-- Now useSkill() logs a row here when retry_shield is actually activated
-- (see skillsController.js), and submitExam only honors a shield claim if
-- a matching, not-yet-consumed, recent log row exists for that exact
-- student + question. consumed_in_session_id is set atomically inside the
-- same grading transaction so a single shield use can never be replayed
-- across multiple exam submissions (e.g. if the same question resurfaces
-- later).
CREATE TABLE IF NOT EXISTS skill_usage_log (
  id                    SERIAL       PRIMARY KEY,
  student_id            INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  skill_id              TEXT         NOT NULL,
  question_id           INTEGER      NOT NULL,
  used_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  consumed_in_session_id INTEGER     REFERENCES exam_sessions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_usage_log_lookup
  ON skill_usage_log(student_id, skill_id, question_id)
  WHERE consumed_in_session_id IS NULL;
