-- ============================================================
-- Scholars Syndicate — FULL DB migrations v2
-- Run ALL of these once on your Render/Railway PostgreSQL
-- Safe to run multiple times (uses IF NOT EXISTS / ON CONFLICT)
-- ============================================================

-- ── 1. STUDENTS TABLE — missing columns ──────────────────────
ALTER TABLE students ADD COLUMN IF NOT EXISTS last_spin2_at      TIMESTAMPTZ;
ALTER TABLE students ADD COLUMN IF NOT EXISTS token_balance      INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS migration_warned   BOOLEAN     DEFAULT false;
ALTER TABLE students ADD COLUMN IF NOT EXISTS referral_code      VARCHAR(20) UNIQUE;
ALTER TABLE students ADD COLUMN IF NOT EXISTS referred_by        VARCHAR(20) DEFAULT NULL;
ALTER TABLE students ADD COLUMN IF NOT EXISTS referral_count     INTEGER     DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS referral_days      INTEGER     DEFAULT 0;

-- Fix any NULLs
UPDATE students SET token_balance = 0 WHERE token_balance IS NULL;

-- Auto-generate referral codes for existing students who don't have one
UPDATE students
  SET referral_code = CONCAT('SCH', LPAD(id::text, 6, '0'))
  WHERE referral_code IS NULL;

-- ── 2. WRONG_ANSWERS TABLE — THE CRASH FIX ───────────────────
-- Missing columns that caused "column times_wrong does not exist"
ALTER TABLE wrong_answers ADD COLUMN IF NOT EXISTS times_wrong   INTEGER     NOT NULL DEFAULT 1;
ALTER TABLE wrong_answers ADD COLUMN IF NOT EXISTS last_wrong_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill any existing rows that have NULL
UPDATE wrong_answers SET times_wrong   = 1    WHERE times_wrong   IS NULL;
UPDATE wrong_answers SET last_wrong_at = NOW() WHERE last_wrong_at IS NULL;

-- Ensure the unique constraint exists so upsert works
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wrong_answers_student_question_unique'
  ) THEN
    ALTER TABLE wrong_answers
      ADD CONSTRAINT wrong_answers_student_question_unique
      UNIQUE (student_id, question_id);
  END IF;
END$$;

-- ── 3. STREAKS TABLE ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS streaks (
  student_id         INTEGER PRIMARY KEY,
  current_streak     INTEGER     DEFAULT 0,
  longest_streak     INTEGER     DEFAULT 0,
  last_activity_date DATE        DEFAULT CURRENT_DATE
);

-- ── 4. STUDENT_PERFORMANCE TABLE ─────────────────────────────
CREATE TABLE IF NOT EXISTS student_performance (
  student_id      INTEGER     NOT NULL,
  subject         VARCHAR(100) NOT NULL,
  total_attempted INTEGER     DEFAULT 0,
  total_correct   INTEGER     DEFAULT 0,
  accuracy        NUMERIC(5,2) DEFAULT 0,
  last_updated    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (student_id, subject)
);

-- ── 5. SPACED_REPETITION TABLE ───────────────────────────────
CREATE TABLE IF NOT EXISTS spaced_repetition (
  id            SERIAL PRIMARY KEY,
  student_id    INTEGER     NOT NULL,
  question_id   INTEGER     NOT NULL,
  ease_factor   NUMERIC(4,2) DEFAULT 2.5,
  interval_days INTEGER     DEFAULT 1,
  repetitions   INTEGER     DEFAULT 0,
  next_review   DATE        DEFAULT CURRENT_DATE,
  last_reviewed DATE,
  UNIQUE (student_id, question_id)
);

-- ── 6. STUDENT_BOOSTS TABLE ──────────────────────────────────
CREATE TABLE IF NOT EXISTS student_boosts (
  id          SERIAL PRIMARY KEY,
  student_id  INTEGER     NOT NULL,
  boost_type  VARCHAR(50),
  multiplier  NUMERIC(4,2) DEFAULT 2.0,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ── 7. EXAM_PERSONALITY TABLE ────────────────────────────────
CREATE TABLE IF NOT EXISTS exam_personality (
  student_id     INTEGER PRIMARY KEY,
  profile_type   VARCHAR(100),
  avg_speed_secs NUMERIC(8,2),
  avg_accuracy   NUMERIC(5,2),
  total_exams    INTEGER DEFAULT 0,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── 8. BEAT_YOURSELF TABLE ───────────────────────────────────
CREATE TABLE IF NOT EXISTS beat_yourself (
  id             SERIAL PRIMARY KEY,
  student_id     INTEGER NOT NULL,
  subject        VARCHAR(100),
  baseline_score NUMERIC(5,2),
  current_score  NUMERIC(5,2),
  beat           BOOLEAN DEFAULT false,
  improvement    NUMERIC(5,2),
  attempt_date   DATE DEFAULT CURRENT_DATE,
  session_id     INTEGER
);

-- ── 9. GEM_VOUCHERS TABLE ────────────────────────────────────
CREATE TABLE IF NOT EXISTS gem_vouchers (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(50) UNIQUE NOT NULL,
  gems        INTEGER DEFAULT 0,
  tokens      INTEGER DEFAULT 0,
  used        BOOLEAN DEFAULT false,
  used_by     INTEGER,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 10. PERFORMANCE INDEXES — speeds up all exam queries ─────
CREATE INDEX IF NOT EXISTS idx_questions_exam_subject
  ON questions(exam_type, subject);

CREATE INDEX IF NOT EXISTS idx_exam_sessions_student
  ON exam_sessions(student_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_wrong_answers_student
  ON wrong_answers(student_id, times_wrong DESC);

CREATE INDEX IF NOT EXISTS idx_students_referral
  ON students(referral_code);

CREATE INDEX IF NOT EXISTS idx_student_performance_student
  ON student_performance(student_id);

-- ── 11. EXPLANATION COLUMN ON EXAM_ANSWERS (Bug Fix) ────────
ALTER TABLE exam_answers ADD COLUMN IF NOT EXISTS explanation TEXT;
CREATE INDEX IF NOT EXISTS idx_exam_answers_session ON exam_answers(session_id);

-- ── 12. COVERING INDEX FOR QUESTION FETCH (Performance) ──────
CREATE INDEX IF NOT EXISTS idx_questions_exam_subject_id
  ON questions(exam_type, subject, id);

-- ── 13. STUDENT BEHAVIOUR PROFILES ───────────────────────────
CREATE TABLE IF NOT EXISTS student_profiles (
  student_id  INTEGER PRIMARY KEY,
  profile     JSONB   NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 14. SERVER-PERSISTED STUDY PLANS ─────────────────────────
CREATE TABLE IF NOT EXISTS study_plans (
  student_id  INTEGER  PRIMARY KEY,
  plan        JSONB    NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 15. ARENA STATE SNAPSHOTS ─────────────────────────────────
CREATE TABLE IF NOT EXISTS arena_snapshots (
  room_code   VARCHAR(10) PRIMARY KEY,
  state       JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 16. PAYSTACK PAYMENT REFS ────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_refs (
  id          SERIAL PRIMARY KEY,
  ref         VARCHAR(100) UNIQUE NOT NULL,
  student_id  INTEGER NOT NULL,
  tokens      INTEGER NOT NULL,
  status      VARCHAR(20) DEFAULT 'pending',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 17. SCHOOL / STATE COLUMNS ON STUDENTS ───────────────────
ALTER TABLE students ADD COLUMN IF NOT EXISTS school_name VARCHAR(200);
ALTER TABLE students ADD COLUMN IF NOT EXISTS state       VARCHAR(100);

-- ── CONFIRMATION QUERY ────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM students)            AS total_students,
  (SELECT COUNT(*) FROM wrong_answers)       AS total_wrong_answers,
  (SELECT COUNT(*) FROM student_performance) AS total_performance_rows,
  (SELECT COUNT(*) FROM streaks)             AS total_streaks;

-- ═══════════════════════════════════════════════════════════
-- v3 UPGRADE MIGRATIONS — run after existing migrate.sql
-- ═══════════════════════════════════════════════════════════

-- ── AI GENERATED QUESTIONS CACHE ─────────────────────────
CREATE TABLE IF NOT EXISTS ai_generated_questions (
  id             SERIAL PRIMARY KEY,
  subject        VARCHAR(100) NOT NULL,
  topic          VARCHAR(200),
  difficulty     VARCHAR(20)  DEFAULT 'medium',
  questions_json JSONB        NOT NULL,
  created_by     INTEGER,
  created_at     TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_questions_subject ON ai_generated_questions(subject, topic, difficulty);

-- ── PAYSTACK TRANSACTIONS ─────────────────────────────────
CREATE TABLE IF NOT EXISTS paystack_transactions (
  id          SERIAL PRIMARY KEY,
  reference   VARCHAR(100) UNIQUE NOT NULL,
  student_id  INTEGER      NOT NULL,
  bundle_id   VARCHAR(50),
  product_type VARCHAR(50) DEFAULT 'tokens',
  amount      INTEGER      NOT NULL,  -- in kobo
  status      VARCHAR(20)  DEFAULT 'pending',  -- pending | success | failed
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ── TOKEN TRANSACTIONS LOG ────────────────────────────────
CREATE TABLE IF NOT EXISTS token_transactions (
  id          SERIAL PRIMARY KEY,
  student_id  INTEGER      NOT NULL,
  amount      INTEGER      NOT NULL,
  type        VARCHAR(10)  NOT NULL, -- credit | debit
  description TEXT,
  reference   VARCHAR(100),
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (reference)
);

-- ── SEASONS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seasons (
  season_id  VARCHAR(10)  PRIMARY KEY,  -- e.g. '2025-06'
  year       INTEGER      NOT NULL,
  month      INTEGER      NOT NULL,
  month_name VARCHAR(20),
  started_at TIMESTAMPTZ  DEFAULT NOW(),
  ends_at    TIMESTAMPTZ,
  rewards_distributed BOOLEAN DEFAULT false
);

-- ── SEASON PLAYERS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS season_players (
  id            SERIAL PRIMARY KEY,
  season_id     VARCHAR(10)  NOT NULL,
  student_id    INTEGER      NOT NULL,
  season_points INTEGER      DEFAULT 0,
  wins          INTEGER      DEFAULT 0,
  losses        INTEGER      DEFAULT 0,
  draws         INTEGER      DEFAULT 0,
  last_played   TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (season_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_season_players_points
  ON season_players(season_id, season_points DESC);

-- ── STUDY PLANS (if missing from earlier migration) ───────
CREATE TABLE IF NOT EXISTS study_plans (
  student_id  INTEGER      PRIMARY KEY,
  plan        JSONB        NOT NULL,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ── STUDENT PROFILES (behavior) — ensure exists ───────────
CREATE TABLE IF NOT EXISTS student_profiles (
  student_id   INTEGER      PRIMARY KEY,
  speed_class  VARCHAR(20),
  weak_topics  JSONB,
  subject_map  JSONB,
  best_hour    INTEGER,
  updated_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- ── CUT-OFF MARKS (JAMB Cut-Off Mark Tracker) ─────────────
-- FIX: this table previously only existed in a standalone
-- migrations/cutoff_marks.sql file that wasn't part of this master
-- "run ALL of these once" script — easy to miss if you only ever ran
-- migrate.sql on your live DB. Folded in here (schema only) so this
-- one file is guaranteed to set up everything /api/cutoffs needs.
-- After running this, separately run the seed files for actual data:
--   migrations/cutoff_marks.sql (national minimums)
--   migrations/cutoff_marks_seed_2026_admin.sql (admin-supplied minimums)
--   migrations/university_departmental_cutoffs_2026.sql (413 departmental rows)
-- Those are INSERT-only and safe to run after this block.
CREATE TABLE IF NOT EXISTS cutoff_marks (
  id                SERIAL       PRIMARY KEY,
  institution_name  VARCHAR(200) NOT NULL,
  category          VARCHAR(30)  NOT NULL CHECK (category IN
                       ('university', 'polytechnic', 'college_of_education', 'college_of_nursing')),
  course_name       VARCHAR(200) DEFAULT NULL,
  cutoff_mark       NUMERIC(6,3) NOT NULL,
  score_type        VARCHAR(20)  NOT NULL DEFAULT 'utme_raw400'
                       CHECK (score_type IN ('utme_raw400', 'aggregate400', 'aggregate100')),
  academic_session  VARCHAR(20)  NOT NULL,
  source_url        TEXT,
  source_note       VARCHAR(300),
  verified_at       DATE         NOT NULL,
  created_by        INTEGER      REFERENCES admins(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (institution_name, category, course_name, academic_session),
  CONSTRAINT cutoff_marks_range_check CHECK (
    (score_type = 'aggregate100' AND cutoff_mark BETWEEN 0 AND 100)
    OR
    (score_type IN ('utme_raw400', 'aggregate400') AND cutoff_mark BETWEEN 0 AND 400)
  )
);
CREATE INDEX IF NOT EXISTS idx_cutoff_marks_institution ON cutoff_marks(institution_name);
CREATE INDEX IF NOT EXISTS idx_cutoff_marks_category    ON cutoff_marks(category);
CREATE INDEX IF NOT EXISTS idx_cutoff_marks_session      ON cutoff_marks(academic_session);
