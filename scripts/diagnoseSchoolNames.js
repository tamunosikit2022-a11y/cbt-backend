/**
 * DIAGNOSTIC ONLY — makes no changes.
 * Shows exactly why students might still look split across schools:
 *   A) same school, different CASING still in the DB  -> backfill didn't run yet
 *   B) same school, different NAMES (not casing)        -> a different problem
 *
 * Run from inside cbt-backend:
 *   node scripts/diagnoseSchoolNames.js
 */
const db = require("../src/config/db");
const { resolveSchoolAlias } = require("../src/utils/schoolAliases");
const { normalizeSchoolName } = require("../src/utils/normalizeSchoolName");

async function run() {
  const { rows } = await db.query(
    "SELECT school_name, COUNT(*) as n FROM students WHERE school_name IS NOT NULL GROUP BY school_name ORDER BY school_name"
  );

  console.log(`\nFound ${rows.length} distinct school_name values in the database.\n`);

  // A) case-only duplicates
  const byUpper = {};
  for (const r of rows) {
    const key = r.school_name.trim().toUpperCase();
    (byUpper[key] ||= []).push(r);
  }
  const caseDupes = Object.entries(byUpper).filter(([, variants]) => variants.length > 1);

  // B) known-alias duplicates (e.g. "uniport" vs "University of Port Harcourt")
  const byCanonical = {};
  for (const r of rows) {
    const canonical = resolveSchoolAlias(r.school_name, normalizeSchoolName);
    (byCanonical[canonical] ||= []).push(r);
  }
  const aliasDupes = Object.entries(byCanonical).filter(([, variants]) => variants.length > 1);

  if (caseDupes.length === 0 && aliasDupes.length === 0) {
    console.log("✅ No duplicates of either kind found — school grouping looks clean.\n");
  } else {
    if (caseDupes.length > 0) {
      console.log(`⚠️  Casing duplicates (${caseDupes.length}):\n`);
      caseDupes.forEach(([key, variants]) => {
        console.log(`  "${key}" is split across:`);
        variants.forEach(v => console.log(`    - "${v.school_name}"  (${v.n} student${v.n == 1 ? "" : "s"})`));
      });
      console.log();
    }
    if (aliasDupes.length > 0) {
      console.log(`⚠️  Same-school-different-name duplicates (${aliasDupes.length}):\n`);
      aliasDupes.forEach(([canonical, variants]) => {
        console.log(`  "${canonical}" is split across:`);
        variants.forEach(v => console.log(`    - "${v.school_name}"  (${v.n} student${v.n == 1 ? "" : "s"})`));
      });
      console.log();
    }
    console.log("   Fix: run  node scripts/normalizeSchoolNames.js  from inside cbt-backend.\n");
    console.log("   If a school still shows as split after that, it means it's not yet in");
    console.log("   src/utils/schoolAliases.js — add its variants there and re-run.\n");
  }

  process.exit(0);
}

run().catch((e) => {
  console.error("Diagnostic failed:", e.message);
  process.exit(1);
});
