-- =============================================================
-- AI TUTOR — CROSS-SESSION MEMORY
-- ScholarAI already had per-session chat history (ai_tutor_messages) and
-- a quantitative behaviour profile (student_profiles, built from real exam
-- data). What it was missing: any memory of what was actually *said* in
-- past conversations once a session was no longer the active one — every
-- new session started from a blank slate even if the student had
-- explained something important (their exam date, a specific confusion,
-- a learning preference) in a chat from last week.
--
-- ai_tutor_notes stores short, distilled facts extracted from a session
-- after the fact (see extractSessionNotes() in aiTutorController.js, run
-- by the nightly cron in server.js) — not raw transcript, just the handful
-- of things worth carrying forward. Kept deliberately small per student
-- (pruned to the most recent MAX_NOTES_PER_STUDENT in code) so it stays
-- cheap to inject into every system prompt and doesn't grow unbounded.
-- =============================================================

CREATE TABLE IF NOT EXISTS ai_tutor_notes (
  id           SERIAL       PRIMARY KEY,
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  session_id   INTEGER      REFERENCES ai_tutor_sessions(id) ON DELETE SET NULL,
  note         TEXT         NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_tutor_notes_student ON ai_tutor_notes(student_id, created_at DESC);

-- Tracks whether/when a session's messages have already been distilled
-- into notes, so the nightly batch doesn't re-process (and re-charge an AI
-- call for) sessions it's already summarized. NULL = never extracted.
ALTER TABLE ai_tutor_sessions
  ADD COLUMN IF NOT EXISTS notes_extracted_at TIMESTAMPTZ;
