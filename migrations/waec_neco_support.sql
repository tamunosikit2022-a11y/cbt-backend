-- WAEC/NECO exam support migration
-- Run after parent_invites.sql

-- Allow WAEC/NECO exam_type in questions table
ALTER TABLE questions 
  DROP CONSTRAINT IF EXISTS questions_exam_type_check;

ALTER TABLE questions 
  ADD CONSTRAINT questions_exam_type_check 
  CHECK (exam_type IN ('JAMB','POST-UTME','WAEC','NECO','custom'));

-- Create WAEC subject index for fast queries
CREATE INDEX IF NOT EXISTS idx_questions_waec ON questions(exam_type, subject) 
  WHERE exam_type IN ('WAEC','NECO');

-- Add question_image_url column for diagram support (Physics, Biology, Chemistry diagrams)
ALTER TABLE questions ADD COLUMN IF NOT EXISTS question_image_url TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS image_alt_text TEXT;

-- Allow WAEC/NECO in exam_sessions
ALTER TABLE exam_sessions
  DROP CONSTRAINT IF EXISTS exam_sessions_exam_type_check;

-- Sponsored school spotlight
ALTER TABLE schools ADD COLUMN IF NOT EXISTS is_sponsored BOOLEAN DEFAULT FALSE;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS sponsor_expires_at TIMESTAMP;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS sponsor_badge_text TEXT;

-- Study notes table
CREATE TABLE IF NOT EXISTS study_notes (
  id          SERIAL PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  session_id  INTEGER,
  notes_json  JSONB NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE (student_id, session_id)
);

-- Squad async chat table
CREATE TABLE IF NOT EXISTS squad_messages (
  id          SERIAL PRIMARY KEY,
  squad_id    INTEGER NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  content     VARCHAR(500) NOT NULL,
  type        VARCHAR(20) DEFAULT 'text',
  created_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_squad_messages_squad ON squad_messages(squad_id, created_at DESC);
