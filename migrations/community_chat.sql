-- Community Chat migration
-- A single global chat room every student can post in (unlike Squad Chat,
-- which is scoped to a student's own squad). Messages are moderated by
-- the shared profanity filter (src/utils/profanityFilter.js) before they
-- ever reach this table, and admins can additionally hide/delete a
-- message after the fact (is_hidden), for anything the filter misses.

CREATE TABLE IF NOT EXISTS community_messages (
  id          BIGSERIAL PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  content     VARCHAR(500) NOT NULL,
  is_hidden   BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_by   INTEGER,               -- admin id, if an admin hid it
  hidden_reason TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_community_messages_created ON community_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_messages_student ON community_messages(student_id);

-- Lightweight per-student rate limiting / mute support: if a student is
-- muted, their messages are rejected at the API level with a clear reason.
CREATE TABLE IF NOT EXISTS community_chat_mutes (
  student_id  INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  muted_by    INTEGER,
  reason      TEXT,
  muted_until TIMESTAMP,             -- NULL = muted indefinitely until unmuted
  created_at  TIMESTAMP DEFAULT NOW()
);
