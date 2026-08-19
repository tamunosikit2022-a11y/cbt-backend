-- ── STUDENT SKILLS INVENTORY TABLE ───────────────────────────
-- Referenced throughout src/controllers/skillsController.js but never
-- created by any migration in this repo. Because those queries are
-- wrapped in .catch(() => ({ rows: [] })), a missing table didn't crash
-- the request — it just silently failed, so purchases appeared to
-- succeed (coins/gems were deducted) while the skill never actually
-- landed in the student's inventory. This is very likely why "skill
-- items purchased in the shop had no effect."

CREATE TABLE IF NOT EXISTS student_skills (
  id          SERIAL PRIMARY KEY,
  student_id  INTEGER     NOT NULL,
  skill_id    TEXT        NOT NULL,
  quantity    INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_student_skills_student ON student_skills(student_id);
