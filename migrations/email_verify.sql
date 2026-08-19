-- Email verification table
CREATE TABLE IF NOT EXISTS email_verifications (
  id          SERIAL PRIMARY KEY,
  student_id  INTEGER UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  token       VARCHAR(64) UNIQUE NOT NULL,
  expires_at  TIMESTAMP NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Add email_verified column
ALTER TABLE students ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE students ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_email_verif_token ON email_verifications(token);
