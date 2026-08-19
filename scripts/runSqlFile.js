/**
 * Run any .sql file against the app's database using the same pg pool
 * the app itself uses — no need to install psql/Postgres client tools
 * separately (helpful on Windows, where psql often isn't on PATH).
 *
 * Usage (run from inside the cbt-backend folder):
 *   node scripts/runSqlFile.js migrations/cutoff_marks_seed_2026_admin.sql
 */
const fs   = require("fs");
const path = require("path");
const db   = require("../src/config/db");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/runSqlFile.js <path-to-sql-file>");
  process.exit(1);
}

const fullPath = path.resolve(process.cwd(), file);
if (!fs.existsSync(fullPath)) {
  console.error(`File not found: ${fullPath}`);
  console.error("Tip: run this from inside the cbt-backend folder, e.g.:");
  console.error("  cd cbt-backend");
  console.error(`  node scripts/runSqlFile.js ${file}`);
  process.exit(1);
}

async function run() {
  const sql = fs.readFileSync(fullPath, "utf8");
  console.log(`Running ${fullPath} ...`);
  await db.query(sql);
  console.log("Done.");
  process.exit(0);
}

run().catch((e) => {
  console.error("SQL file failed:", e.message);
  process.exit(1);
});
