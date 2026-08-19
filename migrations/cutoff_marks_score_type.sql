-- =============================================================
-- SCHOLARS SYNDICATE — CUT-OFF MARKS: ADD score_type COLUMN
-- Run this ONCE, AFTER cutoff_marks.sql, BEFORE the departmental
-- seed file (university_departmental_cutoffs_2026.sql).
-- Safe to re-run.
--
-- WHY: cutoff_marks.sql only ever stored raw UTME scores out of 400.
-- The departmental data students actually need also includes schools
-- that publish an aggregate score out of 100 (e.g. UNILAG, UI, OAU,
-- UNIBEN, LASU, FUTA) or an aggregate out of 400 (e.g. UNN, UNIPORT,
-- UNIZIK). Mixing those into the old /400-only column would show
-- wrong numbers next to the wrong scale, which is worse than not
-- showing them at all. This migration adds a score_type so each row
-- carries its own scale and the UI can label it correctly.
-- =============================================================

ALTER TABLE cutoff_marks
  ADD COLUMN IF NOT EXISTS score_type VARCHAR(20) NOT NULL DEFAULT 'utme_raw400';

-- Widen cutoff_mark so aggregate scores like 85.025 aren't truncated.
ALTER TABLE cutoff_marks
  ALTER COLUMN cutoff_mark TYPE NUMERIC(6,3);

-- Drop the old blanket 0–400 check (it's now scale-dependent).
ALTER TABLE cutoff_marks
  DROP CONSTRAINT IF EXISTS cutoff_marks_cutoff_mark_check;

-- score_type must be one of the three scales the UI knows how to label.
ALTER TABLE cutoff_marks
  DROP CONSTRAINT IF EXISTS cutoff_marks_score_type_check;
ALTER TABLE cutoff_marks
  ADD CONSTRAINT cutoff_marks_score_type_check
  CHECK (score_type IN ('utme_raw400', 'aggregate400', 'aggregate100'));

-- Range now depends on score_type: /100 scales cap at 100, /400 scales cap at 400.
ALTER TABLE cutoff_marks
  DROP CONSTRAINT IF EXISTS cutoff_marks_range_check;
ALTER TABLE cutoff_marks
  ADD CONSTRAINT cutoff_marks_range_check
  CHECK (
    (score_type = 'aggregate100' AND cutoff_mark BETWEEN 0 AND 100)
    OR
    (score_type IN ('utme_raw400', 'aggregate400') AND cutoff_mark BETWEEN 0 AND 400)
  );
