/**
 * scripts/migrate.js - automatic, safe migration runner.
 *
 * Runs every .sql file in /migrations, IN A FIXED, DEPENDENCY-AWARE ORDER,
 * exactly once each - ever. A `schema_migrations` table records which
 * filenames have already been applied, so running this command again
 * (locally, in CI, in a deploy hook, whatever) is always a no-op for
 * anything already applied and only runs what's new.
 *
 * WHY NOT JUST `cat migrations/*.sql | psql`:
 * Several of these files do a raw INSERT or UPDATE with no dedup guard
 * (the seed files, fix_parent_referral_code_collision.sql). Running those
 * twice would duplicate rows or double-apply a data fix. Tracking "have we
 * run this filename before" at the runner level is what makes it safe to
 * automate, regardless of whether any individual file is itself idempotent.
 *
 * USAGE
 *   npm run migrate                  → uses DATABASE_URL from .env
 *   DATABASE_URL=... npm run migrate → target a specific database explicitly
 *
 * Each file runs inside its own transaction. If a file fails, that
 * transaction rolls back, nothing is marked as applied, and the run stops
 * immediately - later files are NOT attempted, so you never end up with
 * a half-applied schema silently continuing on to the next file.
 */
require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const { Pool } = require("pg");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// Explicit order, not alphabetical - several files have real dependencies
// on each other (stated in their own header comments). Anything found in
// /migrations but NOT listed here gets appended at the end, alphabetically,
// with a warning - so a forgotten file still runs, it just doesn't silently
// jump ahead of something it might depend on.
const ORDER = [
  // Foundational / broadly independent tables first
  "missing_tables.sql",
  "innovation_tables.sql",
  "email_verify.sql",
  "refresh_sessions.sql",
  "student_skills_table.sql",
  "live_ide_projects.sql",
  "pdf_vault_tables.sql",
  "pdf_engagement.sql",
  "classroom_history.sql",
  "community_chat.sql",
  "waec_neco_support.sql",

  // Referral system: base column fix, then the privacy fix that depends on
  // the referral system already existing
  "add_referral_reward_claimed.sql",
  "parent_invites.sql",
  "fix_parent_referral_code_collision.sql",

  // Cut-off marks: base table → column addition → seeds that need that column
  "cutoff_marks.sql",
  "cutoff_marks_score_type.sql",
  "cutoff_marks_seed_2026_admin.sql",
  "university_departmental_cutoffs_2026.sql",

  // Content seed, independent of the above
  "university_questions_seed.sql",

  // AI Tutor cross-session memory: adds a column to the existing
  // ai_tutor_sessions table, so it must run after missing_tables.sql
  // (which creates that table).
  "ai_tutor_notes.sql",

  // Skill usage anti-cheat log: references exam_sessions and students, so
  // must run after missing_tables.sql (both created there).
  "skill_usage_log.sql",

  // Ad-reward session verification: references students only.
  "ad_reward_sessions.sql",

  // Daily chest claim atomicity fix: adds a column to the existing
  // student_chests table, so must run after innovation_tables.sql
  // (which creates that table).
  "daily_chest_claim_fix.sql",

  // Friend request uniqueness: adds an index to the existing
  // friend_requests table, so must run after innovation_tables.sql
  // (which creates that table).
  "friend_request_uniqueness.sql",

  // Question reports: references students only.
  "question_reports.sql",
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("[FAIL] DATABASE_URL is not set. Check your .env file or pass it inline:");
    console.error("   DATABASE_URL=postgres://... npm run migrate");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const allFiles = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql"));
  const missing  = ORDER.filter(f => !allFiles.includes(f));
  if (missing.length) {
    console.warn("[WARN]  These files are listed in ORDER but don't exist in /migrations - check for typos or renamed files:");
    missing.forEach(f => console.warn(`   - ${f}`));
  }

  const unlisted = allFiles.filter(f => !ORDER.includes(f));
  const runOrder = [...ORDER.filter(f => allFiles.includes(f)), ...unlisted.sort()];
  if (unlisted.length) {
    console.warn("[WARN]  These files exist in /migrations but aren't in ORDER - running them last, alphabetically. Add them to ORDER in scripts/migrate.js if they depend on something specific:");
    unlisted.forEach(f => console.warn(`   - ${f}`));
  }

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const { rows } = await client.query("SELECT filename FROM schema_migrations");
    const applied = new Set(rows.map(r => r.filename));

    let ranCount = 0;
    for (const file of runOrder) {
      if (applied.has(file)) {
        console.log(`[SKIP]  ${file} - already applied, skipping`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      console.log(`[RUN]  Running ${file} ...`);

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`[OK] ${file} applied`);
        ranCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[FAIL] ${file} FAILED - stopping here. No later files were attempted.`);
        console.error(err.message);
        process.exit(1);
      }
    }

    console.log(
      ranCount === 0
        ? "\n[OK] Database already up to date - nothing to run."
        : `\n[OK] Done - ${ranCount} migration(s) applied.`
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error("[FAIL] Migration runner crashed:", err);
  process.exit(1);
});
