-- ═══════════════════════════════════════════════════════════════
-- classroom_history.sql
-- ───────────────────────────────────────────────────────────────
-- Adds everything needed for:
--   1. "Past classes can be visited" — whiteboard + chat used to live
--      only in server memory (a plain JS Map in classroomEngine.js)
--      and vanished the moment a session ended or the server
--      restarted. This archives both to the database when a class
--      ends, so it can be reopened later in a read-only replay.
--   2. Tracking which students actually attended which class, so
--      students (not just the teacher) can see a "My Past Classes"
--      list.
--   3. Customization fields (description, color, icon) so a class
--      can be branded/organized like a real school subject/period
--      instead of a bare code + title.
--
-- Safe to run multiple times / on a DB that already has
-- classroom_sessions (all statements are IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════

-- In case this table was never created via a tracked migration
-- (it's referenced by classroomEngine.js but its CREATE TABLE isn't
-- in this repo's migration history) — this is a no-op if it exists.
CREATE TABLE IF NOT EXISTS classroom_sessions (
  code         TEXT PRIMARY KEY,
  teacher_id   INTEGER,
  teacher_name TEXT,
  subject      TEXT DEFAULT 'General',
  title        TEXT DEFAULT 'Scholar Session',
  status       TEXT DEFAULT 'active',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  ended_at     TIMESTAMPTZ
);

-- Customization — lets a class feel branded, like a school subject/period
ALTER TABLE classroom_sessions ADD COLUMN IF NOT EXISTS description  TEXT;
ALTER TABLE classroom_sessions ADD COLUMN IF NOT EXISTS theme_color  TEXT DEFAULT '#7C5CFF';
ALTER TABLE classroom_sessions ADD COLUMN IF NOT EXISTS icon         TEXT DEFAULT '📚';

-- Archive — the whiteboard strokes/text and the chat log, snapshotted
-- when the class ends, so it can be reopened later exactly as it was.
ALTER TABLE classroom_sessions ADD COLUMN IF NOT EXISTS board_archive JSONB;
ALTER TABLE classroom_sessions ADD COLUMN IF NOT EXISTS chat_archive  JSONB;
ALTER TABLE classroom_sessions ADD COLUMN IF NOT EXISTS peak_count    INTEGER DEFAULT 0;

-- Who actually attended each class — needed so a STUDENT (not just the
-- teacher) can pull up their own "Past Classes" list.
CREATE TABLE IF NOT EXISTS classroom_participants (
  id           SERIAL PRIMARY KEY,
  session_code TEXT NOT NULL REFERENCES classroom_sessions(code) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL,
  student_name TEXT,
  joined_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_classroom_participants_student ON classroom_participants(student_id);
CREATE INDEX IF NOT EXISTS idx_classroom_participants_session ON classroom_participants(session_code);
CREATE INDEX IF NOT EXISTS idx_classroom_sessions_teacher      ON classroom_sessions(teacher_id, status);
