-- ═══════════════════════════════════════════════════════════════
-- FIX: parent_link_code / referral_code collision (privacy bug)
-- ═══════════════════════════════════════════════════════════════
-- Any student who registered before the authController.js fix has
-- parent_link_code === referral_code. Since referral_code is meant
-- to be shared publicly, this leaked private parent-dashboard
-- access to anyone who saw a student's referral link.
--
-- Safe to run any time: parent_link_code is only checked once, at
-- parent registration, to create a permanent link via student_id.
-- Parents who already linked are unaffected — this only changes
-- the code a student would hand out to link a NEW parent going
-- forward. referral_code is left untouched.
--
-- BACK UP YOUR DATABASE BEFORE RUNNING THIS, as with any migration.
-- ═══════════════════════════════════════════════════════════════

UPDATE students
SET parent_link_code = 'PL' || LPAD(id::text, 6, '0') || UPPER(SUBSTRING(MD5(RANDOM()::text), 1, 4))
WHERE parent_link_code = referral_code
   OR parent_link_code IS NULL;

-- Verify: this should return 0 rows afterward.
-- SELECT id, parent_link_code, referral_code FROM students WHERE parent_link_code = referral_code;
