-- ── QUESTION REPORTS ──────────────────────────────────────────
-- Closes a real gap found while investigating "wrong questions allocated
-- to wrong answers" complaints: there was no way for a student to flag a
-- bad question anywhere in the app, and no admin-side list of flagged
-- content — the only way a bad question (e.g. an AI-mislabeled
-- correct_answer, see the adminQuestionGenController.js prompt fix from
-- the same investigation) ever got noticed was word-of-mouth complaints
-- with nothing tracked. This gives students a lightweight way to flag a
-- specific question, and admins a queue to review and fix/deactivate it.
--
-- No FK to questions(id) — that table isn't managed by this migration
-- pipeline and its exact column set/constraints weren't verified here;
-- an orphaned report row (question later deleted) is harmless and still
-- useful context, so a plain INTEGER is the safer choice over guessing
-- at a FK that might not match.
CREATE TABLE IF NOT EXISTS question_reports (
  id           SERIAL       PRIMARY KEY,
  question_id  INTEGER      NOT NULL,
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  reason       TEXT         NOT NULL,
  status       TEXT         NOT NULL DEFAULT 'open', -- open | resolved | dismissed
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_question_reports_status ON question_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_question_reports_question ON question_reports(question_id);
