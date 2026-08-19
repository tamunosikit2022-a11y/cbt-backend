-- parent_invites.sql — Scholars Syndicate
-- NEW FEATURE: Admin-generated unique parent portal links.
-- Replaces the old flow where parents had to manually type a link_code.
-- Admin picks a student → generates a one-time link → shares it with the
-- parent directly (WhatsApp/SMS) → parent opens it and sets up their own
-- password → lands straight in their portal. No dashboard clutter for students.

CREATE TABLE IF NOT EXISTS parent_invites (
  id            SERIAL PRIMARY KEY,
  token         VARCHAR(64) UNIQUE NOT NULL,
  student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_by    INTEGER,                      -- admin id who generated it
  parent_name   VARCHAR(120),                 -- optional, admin can pre-fill
  parent_phone  VARCHAR(30),                  -- optional, admin can pre-fill
  used          BOOLEAN DEFAULT FALSE,
  used_at       TIMESTAMP,
  expires_at    TIMESTAMP NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_parent_invites_token ON parent_invites(token);
CREATE INDEX IF NOT EXISTS idx_parent_invites_student ON parent_invites(student_id);

-- Also used by JAMBCountdown sync fix and study planner fix
ALTER TABLE students ADD COLUMN IF NOT EXISTS jamb_exam_date DATE;

-- Used by studyPlannerController.js
CREATE TABLE IF NOT EXISTS study_plans (
  id          SERIAL PRIMARY KEY,
  student_id  INTEGER UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  exam_date   DATE,
  plan_json   JSONB NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Used by careerController.js
CREATE TABLE IF NOT EXISTS career_results (
  id                SERIAL PRIMARY KEY,
  student_id        INTEGER UNIQUE NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  personality_type  VARCHAR(100),
  careers           JSONB,
  study_tip         TEXT,
  created_at        TIMESTAMP DEFAULT NOW()
);
