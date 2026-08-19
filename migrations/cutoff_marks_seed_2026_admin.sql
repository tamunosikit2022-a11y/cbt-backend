-- =============================================================
-- SCHOLARS SYNDICATE — CUT-OFF MARK TRACKER: ADMIN-SUPPLIED SEED
-- Run this ONCE after cutoff_marks.sql has already been applied.
-- Safe to re-run (ON CONFLICT DO NOTHING).
--
-- IMPORTANT PROVENANCE NOTE (read before trusting these numbers):
-- This batch was typed up by the app admin, not pulled from a cited
-- primary source (JAMB CAPS / institution admissions pages), and several
-- entries were explicitly labeled "Estimated" in the source list. Per
-- this feature's own design intent (see cutoff_marks.sql), an unverified
-- number here could cost a student a real application, so every row below
-- is tagged in source_note as admin-supplied / unverified rather than
-- silently presented as confirmed. Swap the source_note (and ideally add
-- a source_url) once each figure is checked against an official source.
--
-- SCALE NOTE: only figures on the 0–400 raw UTME scale are included.
-- The admin's list also included UNILAG/UI/OAU departmental "Aggregate
-- Score out of 100" figures (e.g. UNILAG Medicine 85.03) — those use a
-- totally different post-UTME aggregate formula, not a UTME cutoff, so
-- they do NOT fit this table (which the UI labels "/400") and were left
-- out to avoid showing a wrong number next to the wrong scale. If you
-- want those tracked too, they need a separate "aggregate formula"
-- feature — happy to build that next if useful.
-- =============================================================

INSERT INTO cutoff_marks (institution_name, category, course_name, cutoff_mark, academic_session, source_note, verified_at)
VALUES
  -- ── General (institution-wide) minimums not yet in the tracker ──
  ('University of Ilorin (UNILORIN)',                              'university', NULL, 180, '2026/2027', 'Admin-supplied, unverified — confirm on JAMB CAPS / institution site.', CURRENT_DATE),
  ('University of Abuja (UNIABUJA)',                                'university', NULL, 180, '2026/2027', 'Admin-supplied, unverified — confirm on JAMB CAPS / institution site.', CURRENT_DATE),
  ('Ahmadu Bello University, Zaria (ABU)',                          'university', NULL, 180, '2026/2027', 'Admin-supplied, unverified — confirm on JAMB CAPS / institution site.', CURRENT_DATE),
  ('University of Jos (UNIJOS)',                                    'university', NULL, 170, '2026/2027', 'Admin-supplied, unverified — some faculties reportedly require 180.', CURRENT_DATE),
  ('Federal University of Agriculture, Abeokuta (FUNAAB)',          'university', NULL, 160, '2026/2027', 'Admin-supplied, unverified — varies strongly by college; agric courses reportedly 160.', CURRENT_DATE),
  ('Ladoke Akintola University of Technology (LAUTECH)',            'university', NULL, 170, '2026/2027', 'Admin-supplied, unverified — confirm on JAMB CAPS / institution site.', CURRENT_DATE),
  ('Bayero University Kano (BUK)',                                  'university', NULL, 160, '2026/2027', 'Admin-supplied, unverified — confirm on JAMB CAPS / institution site.', CURRENT_DATE),
  ('Nnamdi Azikiwe University, Awka (UNIZIK)',                      'university', NULL, 160, '2026/2027', 'Admin-supplied, unverified — confirm on JAMB CAPS / institution site.', CURRENT_DATE),
  ('Osun State University (UNIOSUN)',                               'university', NULL, 160, '2026/2027', 'Admin-supplied, unverified — confirm on JAMB CAPS / institution site.', CURRENT_DATE),
  ('Olabisi Onabanjo University (OOU)',                             'university', NULL, 160, '2026/2027', 'Admin-supplied, unverified — confirm on JAMB CAPS / institution site.', CURRENT_DATE),
  ('Babcock University',                                            'university', NULL, 170, '2026/2027', 'Admin-supplied, unverified — confirm on institution site.', CURRENT_DATE)
ON CONFLICT (institution_name, category, course_name, academic_session) DO NOTHING;

-- ── Department-level cutoffs on the raw UTME (0-400) scale ──
INSERT INTO cutoff_marks (institution_name, category, course_name, cutoff_mark, academic_session, source_note, verified_at)
VALUES
  -- University of Benin (UNIBEN)
  ('University of Benin (UNIBEN)', 'university', 'Medicine & Surgery',        260, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Benin (UNIBEN)', 'university', 'Nursing Science',           250, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Benin (UNIBEN)', 'university', 'Dentistry',                 250, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Benin (UNIBEN)', 'university', 'Doctor of Pharmacy (PharmD)', 250, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Benin (UNIBEN)', 'university', 'Law',                       250, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Benin (UNIBEN)', 'university', 'Medical Laboratory Science',230, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Benin (UNIBEN)', 'university', 'Civil Engineering',         230, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Benin (UNIBEN)', 'university', 'Mass Communication',        220, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Benin (UNIBEN)', 'university', 'Computer Science',          215, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Benin (UNIBEN)', 'university', 'Accounting',                200, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),

  -- University of Nigeria, Nsukka (UNN)
  ('University of Nigeria, Nsukka (UNN)', 'university', 'Medicine & Surgery',       290, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Nigeria, Nsukka (UNN)', 'university', 'Law',                      275, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Nigeria, Nsukka (UNN)', 'university', 'Dentistry',                275, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Nigeria, Nsukka (UNN)', 'university', 'Pharmacy',                 265, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Nigeria, Nsukka (UNN)', 'university', 'Nursing Sciences',         260, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Nigeria, Nsukka (UNN)', 'university', 'Computer Science',         250, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Nigeria, Nsukka (UNN)', 'university', 'Medical Laboratory Science',245, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Nigeria, Nsukka (UNN)', 'university', 'Computer Engineering',     235, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Nigeria, Nsukka (UNN)', 'university', 'Economics',                228, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Nigeria, Nsukka (UNN)', 'university', 'Microbiology',             210, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),

  -- University of Ilorin (UNILORIN)
  ('University of Ilorin (UNILORIN)', 'university', 'Medicine & Surgery',         260, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Ilorin (UNILORIN)', 'university', 'Common Law',                 240, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Ilorin (UNILORIN)', 'university', 'Pharmacy',                   220, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Ilorin (UNILORIN)', 'university', 'Mechanical/Civil/Electrical Engineering', 220, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Ilorin (UNILORIN)', 'university', 'Medical Laboratory Science', 220, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Ilorin (UNILORIN)', 'university', 'Computer Science',          210, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Ilorin (UNILORIN)', 'university', 'Nursing Science',           210, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Ilorin (UNILORIN)', 'university', 'Accounting/Business Administration', 210, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Ilorin (UNILORIN)', 'university', 'Political Science',         190, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('University of Ilorin (UNILORIN)', 'university', 'Geology',                   190, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),

  -- Ahmadu Bello University, Zaria (ABU)
  ('Ahmadu Bello University, Zaria (ABU)', 'university', 'Medicine and Surgery',  250, '2026/2027', 'Admin-supplied, unverified — labeled estimated by source.', CURRENT_DATE),
  ('Ahmadu Bello University, Zaria (ABU)', 'university', 'Law',                   230, '2026/2027', 'Admin-supplied, unverified — labeled estimated by source.', CURRENT_DATE),
  ('Ahmadu Bello University, Zaria (ABU)', 'university', 'Pharmacy',              220, '2026/2027', 'Admin-supplied, unverified — labeled estimated by source.', CURRENT_DATE),
  ('Ahmadu Bello University, Zaria (ABU)', 'university', 'Nursing Science',       210, '2026/2027', 'Admin-supplied, unverified — labeled estimated by source.', CURRENT_DATE),
  ('Ahmadu Bello University, Zaria (ABU)', 'university', 'Civil/Mechanical/Electrical Engineering', 200, '2026/2027', 'Admin-supplied, unverified — labeled estimated by source.', CURRENT_DATE),
  ('Ahmadu Bello University, Zaria (ABU)', 'university', 'Architecture',          200, '2026/2027', 'Admin-supplied, unverified — labeled estimated by source.', CURRENT_DATE),
  ('Ahmadu Bello University, Zaria (ABU)', 'university', 'Computer Science',      190, '2026/2027', 'Admin-supplied, unverified — labeled estimated by source.', CURRENT_DATE),
  ('Ahmadu Bello University, Zaria (ABU)', 'university', 'Business Administration', 180, '2026/2027', 'Admin-supplied, unverified — labeled estimated by source.', CURRENT_DATE),

  -- University of Jos (UNIJOS)
  ('University of Jos (UNIJOS)', 'university', 'Medicine & Surgery',        250, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('University of Jos (UNIJOS)', 'university', 'Law',                      240, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('University of Jos (UNIJOS)', 'university', 'Doctor of Pharmacy',       230, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('University of Jos (UNIJOS)', 'university', 'Computer Science',         220, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('University of Jos (UNIJOS)', 'university', 'Nursing/Medical Lab/Radiography', 220, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('University of Jos (UNIJOS)', 'university', 'Mass Communication/Theatre Arts', 200, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('University of Jos (UNIJOS)', 'university', 'Accounting/Business Administration', 200, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('University of Jos (UNIJOS)', 'university', 'Biochemistry/Microbiology', 200, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('University of Jos (UNIJOS)', 'university', 'Civil/Electrical/Mechanical Engineering', 190, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('University of Jos (UNIJOS)', 'university', 'Agriculture/Philosophy/Physics', 180, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),

  -- Federal University of Agriculture, Abeokuta (FUNAAB)
  ('Federal University of Agriculture, Abeokuta (FUNAAB)', 'university', 'Engineering (Civil/Mechanical/Electrical/Mechatronics)', 200, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('Federal University of Agriculture, Abeokuta (FUNAAB)', 'university', 'Computer Science/Cybersecurity/Software Engineering', 200, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('Federal University of Agriculture, Abeokuta (FUNAAB)', 'university', 'Biochemistry/Microbiology', 200, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('Federal University of Agriculture, Abeokuta (FUNAAB)', 'university', 'Accounting/Banking & Finance/Economics', 200, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('Federal University of Agriculture, Abeokuta (FUNAAB)', 'university', 'Pure Physics/Mathematics/Statistics', 200, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),
  ('Federal University of Agriculture, Abeokuta (FUNAAB)', 'university', 'Botany/Zoology', 180, '2026/2027', 'Admin-supplied, listed as "official" by source but not independently verified.', CURRENT_DATE),

  -- Lagos State University (LASU)
  ('Lagos State University (LASU)', 'university', 'Medicine & Surgery',     250, '2026/2027', 'Admin-supplied, unverified — figure given as a floor ("250+") for online screening.', CURRENT_DATE),
  ('Lagos State University (LASU)', 'university', 'Nursing Science',        220, '2026/2027', 'Admin-supplied, unverified — figure given as a floor ("220+") for online screening.', CURRENT_DATE),
  ('Lagos State University (LASU)', 'university', 'Law',                    220, '2026/2027', 'Admin-supplied, unverified — figure given as a floor ("220+") for online screening.', CURRENT_DATE),
  ('Lagos State University (LASU)', 'university', 'Computer Science',       200, '2026/2027', 'Admin-supplied, unverified — figure given as a floor ("200+") for online screening.', CURRENT_DATE),
  ('Lagos State University (LASU)', 'university', 'Accounting/Business Administration', 190, '2026/2027', 'Admin-supplied, unverified — figure given as a floor ("190+") for online screening.', CURRENT_DATE),
  ('Lagos State University (LASU)', 'university', 'Geography/Sociology',    180, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),

  -- LASUSTECH
  ('Lagos State University of Science and Technology (LASUSTECH)', 'university', 'Computer Science',      200, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('Lagos State University of Science and Technology (LASUSTECH)', 'university', 'Mechatronics Engineering', 195, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('Lagos State University of Science and Technology (LASUSTECH)', 'university', 'Business Administration', 185, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE),
  ('Lagos State University of Science and Technology (LASUSTECH)', 'university', 'Agricultural Science',   180, '2026/2027', 'Admin-supplied, unverified.', CURRENT_DATE)
ON CONFLICT (institution_name, category, course_name, academic_session) DO NOTHING;
