-- Refresh-token session store for secure rotation/revocation.
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id UUID PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  ip_address INET
);

CREATE INDEX IF NOT EXISTS idx_refresh_sessions_student ON refresh_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_active ON refresh_sessions(student_id, revoked_at, expires_at);
