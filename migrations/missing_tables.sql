-- =============================================================
-- SCHOLARS SYNDICATE — MISSING TABLES MIGRATION
-- Run this ONCE on your PostgreSQL database.
-- All statements use IF NOT EXISTS so it is safe to re-run.
-- Generated: 2026-06-26
-- =============================================================

-- ── AI TUTOR ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_tutor_sessions (
  id                   SERIAL       PRIMARY KEY,
  user_id              INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject              TEXT,
  context_question_id  INTEGER,
  title                VARCHAR(200),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_tutor_sessions_user ON ai_tutor_sessions(user_id);

CREATE TABLE IF NOT EXISTS ai_tutor_messages (
  id           SERIAL       PRIMARY KEY,
  session_id   INTEGER      NOT NULL REFERENCES ai_tutor_sessions(id) ON DELETE CASCADE,
  role         VARCHAR(20)  NOT NULL CHECK (role IN ('user','assistant','system')),
  content      TEXT         NOT NULL,
  tokens_used  INTEGER      DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_tutor_messages_session ON ai_tutor_messages(session_id);

CREATE TABLE IF NOT EXISTS ai_tutor_daily_usage (
  id            SERIAL   PRIMARY KEY,
  user_id       INTEGER  NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  usage_date    DATE     NOT NULL DEFAULT CURRENT_DATE,
  message_count INTEGER  NOT NULL DEFAULT 0,
  UNIQUE (user_id, usage_date)
);

-- ── DAILY CHALLENGES ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_challenges (
  id           SERIAL       PRIMARY KEY,
  date         DATE         NOT NULL UNIQUE,
  subject      VARCHAR(100) NOT NULL,
  question_ids INTEGER[]    NOT NULL,
  total_q      INTEGER      NOT NULL DEFAULT 10,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS challenge_attempts (
  id           SERIAL        PRIMARY KEY,
  student_id   INTEGER       NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  challenge_id INTEGER       NOT NULL REFERENCES daily_challenges(id) ON DELETE CASCADE,
  score        INTEGER       NOT NULL DEFAULT 0,
  total        INTEGER       NOT NULL DEFAULT 0,
  percentage   NUMERIC(5,2)  NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, challenge_id)
);
CREATE INDEX IF NOT EXISTS idx_challenge_attempts_student ON challenge_attempts(student_id);

-- ── EXAM DRAFTS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exam_drafts (
  id                   SERIAL        PRIMARY KEY,
  student_id           INTEGER       NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  exam_type            VARCHAR(50),
  subject              VARCHAR(100)  NOT NULL,
  institution          VARCHAR(200),
  mode                 VARCHAR(50)   NOT NULL,
  question_ids         INTEGER[],
  answers              JSONB         NOT NULL DEFAULT '{}',
  time_remaining_secs  INTEGER       DEFAULT 0,
  total_time_secs      INTEGER       DEFAULT 0,
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exam_drafts_student ON exam_drafts(student_id);

-- ── ARENA TABLES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS arena_matches (
  id           SERIAL       PRIMARY KEY,
  room_code    VARCHAR(20)  NOT NULL,
  mode         VARCHAR(50)  NOT NULL,
  battle_type  VARCHAR(50),
  subject      VARCHAR(100),
  status       VARCHAR(20)  NOT NULL DEFAULT 'finished',
  ended_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_arena_matches_status ON arena_matches(status);

CREATE TABLE IF NOT EXISTS arena_results (
  id              SERIAL   PRIMARY KEY,
  match_id        INTEGER  NOT NULL REFERENCES arena_matches(id) ON DELETE CASCADE,
  student_id      INTEGER  NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score           INTEGER  NOT NULL DEFAULT 0,
  rank            INTEGER  NOT NULL DEFAULT 1,
  correct_count   INTEGER  NOT NULL DEFAULT 0,
  total_questions INTEGER  NOT NULL DEFAULT 0,
  UNIQUE (match_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_arena_results_student ON arena_results(student_id);

CREATE TABLE IF NOT EXISTS arena_stats (
  student_id    INTEGER      PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  total_matches INTEGER      NOT NULL DEFAULT 0,
  wins          INTEGER      NOT NULL DEFAULT 0,
  win_rate      NUMERIC(5,1) NOT NULL DEFAULT 0,
  xp            INTEGER      NOT NULL DEFAULT 0,
  arena_rank    VARCHAR(50)  DEFAULT 'Bronze',
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── SPIN HISTORY ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spin_history (
  id           SERIAL       PRIMARY KEY,
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  reward_type  VARCHAR(50)  NOT NULL,
  reward_value VARCHAR(50)  NOT NULL,
  spun_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spin_history_student ON spin_history(student_id);

-- ── QUESTION GEN JOBS ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS question_gen_jobs (
  id            SERIAL        PRIMARY KEY,
  pdf_name      VARCHAR(500),
  subject       VARCHAR(100),
  exam_type     VARCHAR(50),
  difficulty    VARCHAR(50),
  count_target  INTEGER       NOT NULL DEFAULT 10,
  count_done    INTEGER       NOT NULL DEFAULT 0,
  status        VARCHAR(20)   NOT NULL DEFAULT 'running',
  error_msg     TEXT,
  created_by    INTEGER,
  started_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

-- ── SPIRITS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS student_spirits (
  id              SERIAL    PRIMARY KEY,
  student_id      INTEGER   NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  spirit_id       VARCHAR(50) NOT NULL,
  evolution_stage INTEGER   NOT NULL DEFAULT 0,
  xp              INTEGER   NOT NULL DEFAULT 0,
  equipped        BOOLEAN   NOT NULL DEFAULT false,
  unlocked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, spirit_id)
);
CREATE INDEX IF NOT EXISTS idx_student_spirits_student ON student_spirits(student_id);

-- ── VAULT ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS student_vault (
  id          SERIAL      PRIMARY KEY,
  student_id  INTEGER     NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  item_id     VARCHAR(100) NOT NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_student_vault_student ON student_vault(student_id);

-- knowledge_vault_pdfs and flashcards are read-only in weaknessDetector
-- (wrapped in .catch) but defining them avoids confusion
CREATE TABLE IF NOT EXISTS knowledge_vault_pdfs (
  id          SERIAL        PRIMARY KEY,
  title       VARCHAR(300)  NOT NULL,
  subject     VARCHAR(100),
  description TEXT,
  file_url    TEXT,
  is_active   BOOLEAN       NOT NULL DEFAULT true,
  downloads   INTEGER       NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flashcards (
  id         SERIAL        PRIMARY KEY,
  front      TEXT          NOT NULL,
  back       TEXT          NOT NULL,
  subject    VARCHAR(100),
  topic      VARCHAR(200),
  is_active  BOOLEAN       NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ── PARENTS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS parents (
  id            SERIAL        PRIMARY KEY,
  full_name     VARCHAR(200)  NOT NULL,
  email         VARCHAR(200)  NOT NULL UNIQUE,
  phone         VARCHAR(20),
  password_hash TEXT          NOT NULL,
  student_id    INTEGER       REFERENCES students(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parents_student ON parents(student_id);

-- ── MISSIONS ─────────────────────────────────────────────
-- Seed data needed: run INSERT statements below after CREATE
CREATE TABLE IF NOT EXISTS missions (
  id           SERIAL        PRIMARY KEY,
  code         VARCHAR(100)  NOT NULL UNIQUE,
  title        VARCHAR(200)  NOT NULL,
  description  TEXT,
  type         VARCHAR(20)   NOT NULL CHECK (type IN ('daily','weekly')),
  category     VARCHAR(50),
  target       INTEGER       NOT NULL DEFAULT 1,
  xp_reward    INTEGER       NOT NULL DEFAULT 0,
  coins_reward INTEGER       NOT NULL DEFAULT 0,
  is_active    BOOLEAN       NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS student_missions (
  id           SERIAL        PRIMARY KEY,
  student_id   INTEGER       NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  mission_code VARCHAR(100)  NOT NULL,
  date         DATE          NOT NULL,
  progress     INTEGER       NOT NULL DEFAULT 0,
  completed    BOOLEAN       NOT NULL DEFAULT false,
  claimed      BOOLEAN       NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  UNIQUE (student_id, mission_code, date)
);
CREATE INDEX IF NOT EXISTS idx_student_missions_student ON student_missions(student_id, date);

-- Seed: default missions (safe to re-run — uses ON CONFLICT DO NOTHING)
INSERT INTO missions (code, title, description, type, category, target, xp_reward, coins_reward) VALUES
  ('daily_login',      'Daily Login',          'Log in today',                    'daily',  'general',  1,  10,  5),
  ('daily_exam',       'Complete an Exam',     'Finish 1 practice exam today',    'daily',  'exam',     1,  20, 10),
  ('daily_challenge',  'Daily Challenge',      'Complete today''s challenge',     'daily',  'challenge',1,  30, 15),
  ('daily_arena',      'Arena Battle',         'Play 1 arena match today',        'daily',  'arena',    1,  25, 10),
  ('daily_arena_win',  'Arena Victory',        'Win 1 arena match today',         'daily',  'arena',    1,  40, 20),
  ('daily_score_70',   'Score 70%+',           'Score at least 70% on any exam',  'daily',  'exam',     1,  25, 15),
  ('daily_video',      'Watch a Video',        'Watch 1 educational video',       'daily',  'study',    1,  15,  5),
  ('daily_streak',     'Maintain Streak',      'Keep your study streak alive',    'daily',  'general',  1,  15,  5),
  ('daily_questions',  'Answer Questions',     'Answer 20 questions today',       'daily',  'exam',    20,  30, 10),
  ('daily_blitz',      'Blitz Battle',         'Play 1 blitz arena match',        'daily',  'arena',    1,  25, 10),
  ('daily_blitz_win',  'Blitz Victory',        'Win a blitz match',               'daily',  'arena',    1,  40, 20),
  ('daily_survival',   'Survival Mode',        'Play 1 survival arena match',     'daily',  'arena',    1,  25, 10),
  ('daily_study_room', 'Join Study Room',      'Join a study room session',       'daily',  'social',   1,  20,  5),
  ('daily_flashcard',  'Flashcard Practice',   'Review flashcards today',         'daily',  'study',    1,  15,  5),
  ('weekly_exams',     'Weekly Exam Warrior',  'Complete 10 exams this week',     'weekly', 'exam',    10, 150, 75),
  ('weekly_arena',     'Weekly Arena Fighter', 'Play 5 arena matches this week',  'weekly', 'arena',    5, 100, 50),
  ('weekly_perfect',   'Perfect Score',        'Score 100% on any exam this week','weekly', 'exam',     1, 200,100),
  ('weekly_streak',    'Weekly Streak',        'Maintain streak for 7 days',      'weekly', 'general',  7, 120, 60),
  ('weekly_blitz',     'Weekly Blitz',         'Play 3 blitz matches this week',  'weekly', 'arena',    3,  75, 35),
  ('weekly_school_war','School War',           'Participate in a school war',     'weekly', 'social',   1, 100, 50)
ON CONFLICT (code) DO NOTHING;
-- The first definition in migrate.sql only has (student_id, profile JSONB).
-- The second definition (ignored by IF NOT EXISTS) has more columns needed
-- by behaviorController. Add the missing columns safely.
ALTER TABLE student_profiles
  ADD COLUMN IF NOT EXISTS speed_class  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS weak_topics  JSONB,
  ADD COLUMN IF NOT EXISTS subject_map  JSONB,
  ADD COLUMN IF NOT EXISTS best_hour    INTEGER,
  ADD COLUMN IF NOT EXISTS risk_level   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW();

-- ── FIX: token_transactions schema conflict ───────────────
-- migrate.sql only has (amount, type, description, reference).
-- tokenController.spendTokens inserts (feature, tokens, amount_kobo, status, completed_at).
-- paystackController also needs bundle_id.
-- Add all missing columns so every caller works.
ALTER TABLE token_transactions
  ADD COLUMN IF NOT EXISTS feature      VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bundle_id    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS tokens       INTEGER,
  ADD COLUMN IF NOT EXISTS amount_kobo  INTEGER,
  ADD COLUMN IF NOT EXISTS status       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- ── ANSWER CONFIDENCE ─────────────────────────────────────
-- Used by phase2Controller getPersonalityProfile
CREATE TABLE IF NOT EXISTS answer_confidence (
  id          SERIAL    PRIMARY KEY,
  student_id  INTEGER   NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  question_id INTEGER   NOT NULL,
  confidence  SMALLINT  NOT NULL CHECK (confidence BETWEEN 1 AND 3),
  is_correct  BOOLEAN   NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_answer_confidence_student ON answer_confidence(student_id);
