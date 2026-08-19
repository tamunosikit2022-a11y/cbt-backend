-- =============================================================
-- SCHOLARS SYNDICATE — CUT-OFF MARK TRACKER MIGRATION
-- Run this ONCE on your PostgreSQL database.
-- All statements use IF NOT EXISTS so it is safe to re-run.
-- Generated: 2026-07-08
-- =============================================================

-- ── CUT-OFF MARKS ──────────────────────────────────────────
-- course_name = NULL means this row is the institution's GENERAL minimum
-- (what you need just to be considered for post-UTME screening at all).
-- Department/course-specific cutoffs go in as separate rows with
-- course_name filled in — the table supports them, but this migration only
-- seeds general minimums that were verifiable at time of writing. Course-
-- level entries should be added via the admin panel as they're confirmed
-- from official sources (JAMB CAPS / institution admission pages), not
-- guessed — an unverified cutoff on this feature could cost a student a
-- year if they skip applying somewhere they'd actually have qualified.
CREATE TABLE IF NOT EXISTS cutoff_marks (
  id                SERIAL       PRIMARY KEY,
  institution_name  VARCHAR(200) NOT NULL,
  category          VARCHAR(30)  NOT NULL CHECK (category IN
                       ('university', 'polytechnic', 'college_of_education', 'college_of_nursing')),
  course_name       VARCHAR(200) DEFAULT NULL,  -- NULL = institution's general minimum
  cutoff_mark       INTEGER      NOT NULL CHECK (cutoff_mark BETWEEN 0 AND 400),
  academic_session  VARCHAR(20)  NOT NULL,       -- e.g. '2026/2027'
  source_url        TEXT,
  source_note       VARCHAR(300),
  verified_at       DATE         NOT NULL,
  created_by        INTEGER      REFERENCES admins(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (institution_name, category, course_name, academic_session)
);
CREATE INDEX IF NOT EXISTS idx_cutoff_marks_institution ON cutoff_marks(institution_name);
CREATE INDEX IF NOT EXISTS idx_cutoff_marks_category    ON cutoff_marks(category);
CREATE INDEX IF NOT EXISTS idx_cutoff_marks_session      ON cutoff_marks(academic_session);

-- ── SEED: JAMB national minimums, announced at the 2026 Policy Meeting ──
-- (May 11, 2026 — Vanguard, Legit.ng, PM News, The Guardian NG, all
-- reporting the same figures the same week; retained from the prior cycle)
INSERT INTO cutoff_marks (institution_name, category, course_name, cutoff_mark, academic_session, source_note, verified_at)
VALUES
  ('JAMB National Minimum — Universities',            'university',            NULL, 150, '2026/2027', 'Approved at the 2026 JAMB Policy Meeting on Admissions (11 May 2026). Institutions may set higher departmental cutoffs.', '2026-05-11'),
  ('JAMB National Minimum — Colleges of Nursing',      'college_of_nursing',    NULL, 150, '2026/2027', 'Approved at the 2026 JAMB Policy Meeting on Admissions (11 May 2026).', '2026-05-11'),
  ('JAMB National Minimum — Polytechnics/Monotechnics','polytechnic',           NULL, 100, '2026/2027', 'Approved at the 2026 JAMB Policy Meeting on Admissions (11 May 2026).', '2026-05-11')
ON CONFLICT (institution_name, category, course_name, academic_session) DO NOTHING;

-- ── SEED: institution general minimums reported in the same policy-meeting
-- coverage (May 2026). These are GENERAL minimums only — actual admission
-- for competitive departments (Medicine, Law, etc.) is almost always
-- higher and needs confirming on the institution's own site.
INSERT INTO cutoff_marks (institution_name, category, course_name, cutoff_mark, academic_session, source_note, verified_at)
VALUES
  ('Obafemi Awolowo University (OAU)',        'university', NULL, 200, '2026/2027', 'Reported at the 2026 JAMB Policy Meeting on Admissions.', '2026-05-11'),
  ('University of Benin (UNIBEN)',            'university', NULL, 200, '2026/2027', 'Reported at the 2026 JAMB Policy Meeting on Admissions.', '2026-05-11'),
  ('University of Ibadan (UI)',               'university', NULL, 200, '2026/2027', 'UI also uses an aggregate formula for departmental screening: (JAMB score ÷ 8) + (Post-UTME score ÷ 2). This row is the general minimum only.', '2026-05-11'),
  ('University of Lagos (UNILAG)',            'university', NULL, 200, '2026/2027', 'Reported at the 2026 JAMB Policy Meeting on Admissions.', '2026-05-11'),
  ('University of Nigeria, Nsukka (UNN)',     'university', NULL, 200, '2026/2027', 'Reported at the 2026 JAMB Policy Meeting on Admissions.', '2026-05-11'),
  ('Covenant University',                     'university', NULL, 200, '2026/2027', 'Reported at the 2026 JAMB Policy Meeting on Admissions.', '2026-05-11'),
  ('Pan-Atlantic University',                 'university', NULL, 220, '2026/2027', 'Highest minimum reported among institutions at the 2026 policy meeting.', '2026-05-11'),
  ('Lagos State University (LASU)',           'university', NULL, 195, '2026/2027', 'Reported at the 2026 JAMB Policy Meeting on Admissions.', '2026-05-11'),
  ('Lagos State University of Science and Technology (LASUSTECH)', 'university', NULL, 195, '2026/2027', 'Reported at the 2026 JAMB Policy Meeting on Admissions.', '2026-05-11'),
  ('Lagos State University of Education (LASUED)', 'university', NULL, 185, '2026/2027', 'Reported at the 2026 JAMB Policy Meeting on Admissions.', '2026-05-11')
ON CONFLICT (institution_name, category, course_name, academic_session) DO NOTHING;
