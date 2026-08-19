/**
 * ONE-TIME SCRIPT: assign usernames to students who registered
 * before the username system existed.
 *
 * Run once after applying migrations/username_system.sql:
 *   node scripts/backfillUsernames.js
 *
 * Safe to re-run — only touches rows where username IS NULL.
 */

const db = require("../src/config/db");
const { generateUniqueUsername } = require("../src/utils/usernameGenerator");

async function run() {
  const { rows } = await db.query(
    "SELECT id, full_name FROM students WHERE username IS NULL"
  );

  console.log(`Found ${rows.length} students without a username.`);

  let done = 0;
  for (const student of rows) {
    try {
      const username = await generateUniqueUsername(student.full_name);
      await db.query("UPDATE students SET username = $1 WHERE id = $2", [username, student.id]);
      done++;
      if (done % 50 === 0) console.log(`  ...${done}/${rows.length}`);
    } catch (e) {
      console.error(`Failed for student ${student.id}:`, e.message);
    }
  }

  console.log(`Done. Assigned usernames to ${done}/${rows.length} students.`);
  process.exit(0);
}

run().catch((e) => {
  console.error("Backfill failed:", e);
  process.exit(1);
});
