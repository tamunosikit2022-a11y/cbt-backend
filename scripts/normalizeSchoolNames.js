/**
 * ONE-TIME SCRIPT: collapse existing school_name values that are either
 * different CASING ("uniport" vs "UNIPORT") or different NAMES for the
 * same school ("uniport" vs "University of Port Harcourt") into one
 * canonical value, so Factions / School Wars / school leaderboards group
 * those students together instead of splitting them.
 *
 * New registrations are already resolved going forward (see
 * src/controllers/authController.js + src/utils/schoolAliases.js).
 * This script only needs to run when you want to re-sweep existing
 * students — safe to re-run any time (idempotent).
 */
const db = require("../src/config/db");
const { normalizeSchoolName } = require("../src/utils/normalizeSchoolName");
const { resolveSchoolAlias } = require("../src/utils/schoolAliases");

async function run() {
  const { rows } = await db.query(
    "SELECT id, school_name FROM students WHERE school_name IS NOT NULL"
  );

  console.log(`Checking ${rows.length} students with a school_name set...`);

  let changed = 0;
  for (const student of rows) {
    const resolved = resolveSchoolAlias(student.school_name, normalizeSchoolName);
    if (resolved !== student.school_name) {
      await db.query("UPDATE students SET school_name = $1 WHERE id = $2", [
        resolved,
        student.id,
      ]);
      changed++;
    }
  }

  console.log(`Done. Normalized ${changed}/${rows.length} school_name values.`);
  process.exit(0);
}

run().catch((e) => {
  console.error("Normalization failed:", e);
  process.exit(1);
});
