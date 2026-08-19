-- ═══════════════════════════════════════════════════════════════
-- SCHOLARS SYNDICATE — INNOVATION MIGRATION
-- Run with: psql -d scholars_syndicate -f migrations/innovation_tables.sql
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- STUDENTS TABLE — New columns (upgrade existing)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE students ADD COLUMN IF NOT EXISTS equipped_title         TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS arena_rank_score       INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS arena_wins             INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS arena_win_streak       INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS blitz_wins             INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS tournament_wins        INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS battle_royal_wins      INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS squad_wins             INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS survival_top5          INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS speed_answers_count    INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS midnight_sessions      INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS total_sessions         INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS referrals_count        INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS friends_count          INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS spirits_count          INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS pdfs_unlocked          INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS flashcard_sessions     INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS study_room_hosted      INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS study_room_shares      INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS school_wars_played     INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS school_wars_captain_won INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS faction_xp             INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS season_tier            INTEGER DEFAULT 0;
ALTER TABLE students ADD COLUMN IF NOT EXISTS event_spin_tokens      INTEGER DEFAULT 0;

-- ────────────────────────────────────────────────────────────────
-- BADGES & TITLES
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS student_badges (
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  badge_id     TEXT         NOT NULL,
  unlocked_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_id, badge_id)
);
CREATE INDEX IF NOT EXISTS idx_student_badges_student ON student_badges(student_id);

CREATE TABLE IF NOT EXISTS student_titles (
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  title_id     TEXT         NOT NULL,
  unlocked_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  equipped     BOOLEAN      NOT NULL DEFAULT FALSE,
  PRIMARY KEY (student_id, title_id)
);
CREATE INDEX IF NOT EXISTS idx_student_titles_student ON student_titles(student_id);

-- ────────────────────────────────────────────────────────────────
-- MICRO-INTERACTIONS LOG (analytics)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fx_event_log (
  id          BIGSERIAL    PRIMARY KEY,
  student_id  INTEGER      REFERENCES students(id) ON DELETE CASCADE,
  event       TEXT         NOT NULL,
  played_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fx_event_log_student ON fx_event_log(student_id);

-- FIX (42P17): `played_at::date` casts using the SESSION timezone, which is not
-- IMMUTABLE — Postgres rejects non-immutable expressions in an index. Pinning
-- the cast to a fixed timezone (UTC) makes the expression deterministic, so it
-- qualifies as IMMUTABLE and the index can be created.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fx_event_log_uniq
  ON fx_event_log(student_id, event, ((played_at AT TIME ZONE 'UTC')::date));

-- ────────────────────────────────────────────────────────────────
-- AI QUIZ GENERATOR
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_quiz_generations (
  id             BIGSERIAL    PRIMARY KEY,
  student_id     INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  source_type    TEXT         NOT NULL DEFAULT 'text',  -- pdf|text|video|notes
  source_ref     TEXT,                                   -- video id, pdf id, etc.
  subject        TEXT,
  question_count INTEGER      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aiqg_student ON ai_quiz_generations(student_id);

CREATE TABLE IF NOT EXISTS personal_quizzes (
  id             BIGSERIAL    PRIMARY KEY,
  student_id     INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  name           TEXT         NOT NULL DEFAULT 'My Quiz',
  subject        TEXT,
  question_count INTEGER      NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS personal_quiz_questions (
  id             BIGSERIAL    PRIMARY KEY,
  quiz_id        BIGINT       NOT NULL REFERENCES personal_quizzes(id) ON DELETE CASCADE,
  question       TEXT         NOT NULL,
  option_a       TEXT,
  option_b       TEXT,
  option_c       TEXT,
  option_d       TEXT,
  correct_answer CHAR(1),
  explanation    TEXT,
  topic          TEXT
);
CREATE INDEX IF NOT EXISTS idx_pqq_quiz ON personal_quiz_questions(quiz_id);

-- ────────────────────────────────────────────────────────────────
-- SEASON COSMETICS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS season_cosmetics (
  id           BIGSERIAL    PRIMARY KEY,
  season_id    INTEGER      NOT NULL,
  tier         INTEGER      NOT NULL,
  type         TEXT         NOT NULL,  -- avatar_frame|spirit_skin|title_color|profile_effect|chat_badge|banner_bg|arena_entry
  name         TEXT         NOT NULL,
  rarity       TEXT         NOT NULL DEFAULT 'common',
  preview_url  TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (season_id, tier, type)
);

CREATE TABLE IF NOT EXISTS student_season_cosmetics (
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  cosmetic_id  BIGINT       NOT NULL REFERENCES season_cosmetics(id) ON DELETE CASCADE,
  equipped     BOOLEAN      NOT NULL DEFAULT FALSE,
  unlocked_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_id, cosmetic_id)
);
CREATE INDEX IF NOT EXISTS idx_ssc_student ON student_season_cosmetics(student_id);

CREATE TABLE IF NOT EXISTS student_equipped_cosmetics (
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  slot         TEXT         NOT NULL,  -- avatar_frame|spirit_skin|etc.
  cosmetic_id  BIGINT       NOT NULL REFERENCES season_cosmetics(id) ON DELETE CASCADE,
  PRIMARY KEY (student_id, slot)
);

-- ────────────────────────────────────────────────────────────────
-- SPIN WHEEL EVENTS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spin_events (
  id           BIGSERIAL    PRIMARY KEY,
  name         TEXT         NOT NULL,
  event_type   TEXT,                    -- halloween|christmas|season_finale|etc.
  start_at     TIMESTAMPTZ  NOT NULL,
  end_at       TIMESTAMPTZ  NOT NULL,
  theme_color  TEXT         NOT NULL DEFAULT '#7C5CFF',
  prizes       JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS spin_results (
  id           BIGSERIAL    PRIMARY KEY,
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  prize_label  TEXT,
  prize_type   TEXT,
  prize_rarity TEXT,
  source       TEXT         NOT NULL DEFAULT 'regular',  -- regular|event|daily
  spun_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spin_results_student ON spin_results(student_id);

-- ────────────────────────────────────────────────────────────────
-- TOURNAMENTS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tournaments (
  id            TEXT         PRIMARY KEY,
  name          TEXT         NOT NULL,
  subject       TEXT,
  max_size      INTEGER      NOT NULL DEFAULT 16,
  bracket_json  JSONB,
  status        TEXT         NOT NULL DEFAULT 'open',  -- open|in_progress|finished
  winner_id     INTEGER      REFERENCES students(id),
  prizes_json   JSONB,
  start_at      TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tournament_registrations (
  tournament_id TEXT         NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  student_id    INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  seed          INTEGER,
  registered_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tournament_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_tourney_reg ON tournament_registrations(tournament_id);

-- ────────────────────────────────────────────────────────────────
-- SOCIAL — FRIENDS + SQUADS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friend_requests (
  id           BIGSERIAL    PRIMARY KEY,
  from_id      INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  to_id        INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status       TEXT         NOT NULL DEFAULT 'pending',  -- pending|accepted|rejected
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_friend_req_to ON friend_requests(to_id);
CREATE INDEX IF NOT EXISTS idx_friend_req_from ON friend_requests(from_id);

CREATE TABLE IF NOT EXISTS friends (
  id           BIGSERIAL    PRIMARY KEY,
  student_a    INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  student_b    INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (student_a, student_b),
  CHECK (student_a < student_b)
);
CREATE INDEX IF NOT EXISTS idx_friends_a ON friends(student_a);
CREATE INDEX IF NOT EXISTS idx_friends_b ON friends(student_b);

CREATE TABLE IF NOT EXISTS squads (
  id           BIGSERIAL    PRIMARY KEY,
  name         TEXT         NOT NULL,
  captain_id   INTEGER      NOT NULL REFERENCES students(id),
  room_code    TEXT,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS squad_members (
  squad_id     BIGINT       NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (squad_id, student_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_squad_member_student ON squad_members(student_id);

CREATE TABLE IF NOT EXISTS squad_invites (
  id           BIGSERIAL    PRIMARY KEY,
  squad_id     BIGINT       NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  from_id      INTEGER      NOT NULL REFERENCES students(id),
  to_id        INTEGER      NOT NULL REFERENCES students(id),
  status       TEXT         NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (squad_id, to_id)
);

-- ────────────────────────────────────────────────────────────────
-- TEAM MISSIONS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS squad_mission_progress (
  squad_id     BIGINT       NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  mission_id   TEXT         NOT NULL,
  current      INTEGER      NOT NULL DEFAULT 0,
  completed    BOOLEAN      NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (squad_id, mission_id)
);

CREATE TABLE IF NOT EXISTS team_mission_history (
  id             BIGSERIAL    PRIMARY KEY,
  squad_id       BIGINT       NOT NULL REFERENCES squads(id) ON DELETE CASCADE,
  mission_id     TEXT         NOT NULL,
  completed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reward_coins   INTEGER,
  reward_gems    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tmh_squad ON team_mission_history(squad_id);

-- ────────────────────────────────────────────────────────────────
-- SCHOOL WARS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS school_faction_stats (
  school_name      TEXT         PRIMARY KEY,
  total_faction_xp INTEGER      NOT NULL DEFAULT 0,
  wars_won         INTEGER      NOT NULL DEFAULT 0,
  wars_played      INTEGER      NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS school_war_history (
  war_id             TEXT         PRIMARY KEY,
  challenger_school  TEXT         NOT NULL,
  rival_school       TEXT         NOT NULL,
  winner_school      TEXT,
  challenger_wins    INTEGER      NOT NULL DEFAULT 0,
  rival_wins         INTEGER      NOT NULL DEFAULT 0,
  subject            TEXT,
  ended_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- BLITZ MATCH RESULTS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blitz_match_results (
  id           BIGSERIAL    PRIMARY KEY,
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_code    TEXT         NOT NULL,
  score        INTEGER      NOT NULL DEFAULT 0,
  rank         INTEGER      NOT NULL DEFAULT 1,
  subject      TEXT,
  played_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_blitz_results_student ON blitz_match_results(student_id);

-- ────────────────────────────────────────────────────────────────
-- SURVIVAL MATCH RESULTS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS survival_match_results (
  id                 BIGSERIAL    PRIMARY KEY,
  student_id         INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_code          TEXT         NOT NULL,
  rank               INTEGER      NOT NULL DEFAULT 1,
  questions_answered INTEGER      NOT NULL DEFAULT 0,
  subject            TEXT,
  played_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survival_results_student ON survival_match_results(student_id);

-- ────────────────────────────────────────────────────────────────
-- WEAKNESS DETECTOR
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weakness_reports (
  student_id    INTEGER      PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  report_json   JSONB        NOT NULL,
  generated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS weakness_practice_sessions (
  id             BIGSERIAL    PRIMARY KEY,
  student_id     INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject        TEXT,
  topic          TEXT,
  question_count INTEGER,
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
-- EXAM ANSWERS (needed by weakness detector — add if not exists)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS exam_answers (
  id            BIGSERIAL    PRIMARY KEY,
  student_id    INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  exam_id       INTEGER,
  question_id   INTEGER,
  is_correct    BOOLEAN      NOT NULL DEFAULT FALSE,
  time_taken_ms INTEGER,
  answered_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exam_answers_student ON exam_answers(student_id);
CREATE INDEX IF NOT EXISTS idx_exam_answers_question ON exam_answers(question_id);

-- ────────────────────────────────────────────────────────────────
-- AI QUIZ GENERATOR — VIDEO TABLE (add transcript col if needed)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE videos ADD COLUMN IF NOT EXISTS transcript TEXT;

-- ════════════════════════════════════════════════════════════════
-- DONE — All innovation tables created
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- PREMIUM EVENTS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS premium_events (
  id             BIGSERIAL    PRIMARY KEY,
  name           TEXT         NOT NULL DEFAULT 'Free Premium Day',
  note           TEXT,
  start_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  end_at         TIMESTAMPTZ  NOT NULL,
  activated_by   INTEGER      REFERENCES admins(id),
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_premium_events_active ON premium_events(is_active, end_at);

-- ────────────────────────────────────────────────────────────────
-- TREASURE CHESTS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS student_chests (
  id           BIGSERIAL    PRIMARY KEY,
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  tier         TEXT         NOT NULL DEFAULT 'common',
  source       TEXT         NOT NULL DEFAULT 'daily',
  opened       BOOLEAN      NOT NULL DEFAULT FALSE,
  rewards_json JSONB,
  earned_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  opened_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_student_chests_student ON student_chests(student_id, opened);

-- ────────────────────────────────────────────────────────────────
-- LIVE CHALLENGES
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live_challenge_history (
  id             BIGSERIAL    PRIMARY KEY,
  challenge_id   TEXT         NOT NULL,
  match_id       TEXT         NOT NULL,
  winner_id      INTEGER      REFERENCES students(id),
  subject        TEXT,
  player1_id     INTEGER      REFERENCES students(id),
  player2_id     INTEGER      REFERENCES students(id),
  played_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lch_player1 ON live_challenge_history(player1_id);
CREATE INDEX IF NOT EXISTS idx_lch_player2 ON live_challenge_history(player2_id);

-- ────────────────────────────────────────────────────────────────
-- ARENA MATCH RESULTS (for badge checkFirstArenaWin)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS arena_match_results (
  id           BIGSERIAL    PRIMARY KEY,
  student_id   INTEGER      NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  room_code    TEXT         NOT NULL,
  result       TEXT         NOT NULL DEFAULT 'loss',
  battle_type  TEXT,
  score        INTEGER      DEFAULT 0,
  xp_earned    INTEGER      DEFAULT 0,
  coins_earned INTEGER      DEFAULT 0,
  played_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_arena_results_student ON arena_match_results(student_id);

-- students: extra_spins column for spin rewards from chests
ALTER TABLE students ADD COLUMN IF NOT EXISTS extra_spins INTEGER DEFAULT 0;

-- classroom_sessions: add video support columns
ALTER TABLE classroom_sessions ADD COLUMN IF NOT EXISTS has_video  BOOLEAN DEFAULT FALSE;
ALTER TABLE classroom_sessions ADD COLUMN IF NOT EXISTS peak_count INTEGER DEFAULT 0;
