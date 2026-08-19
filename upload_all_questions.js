/**
 * Universal Question Uploader
 * ───────────────────────────
 * 1. Place all_questions_5k.json in this same folder (cbt-backend)
 * 2. Make sure your .env has DATABASE_URL filled in
 * 3. Run:  node upload_all_questions.js
 */

const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Try multiple filenames — whichever you placed in the folder
const FILENAMES = [
  "all_questions_5k.json",
  "jamb_questions.json",
  "postutme_questions.json",
  "all_questions.json",
];

async function upload() {
  // Find the file
  let filePath = null;
  let fileName = null;
  for (const name of FILENAMES) {
    const fp = path.join(__dirname, name);
    if (fs.existsSync(fp)) {
      filePath = fp;
      fileName = name;
      break;
    }
  }

  if (!filePath) {
    console.error("❌ No question file found!");
    console.error("   Place all_questions_5k.json in your cbt-backend folder and run again.");
    process.exit(1);
  }

  console.log(`✅ Found file: ${fileName}`);

  const raw       = fs.readFileSync(filePath, "utf-8");
  const data      = JSON.parse(raw);
  const questions = data.questions || data;

  if (!Array.isArray(questions) || !questions.length) {
    console.error("❌ No questions found in file.");
    process.exit(1);
  }

  console.log(`📚 Loaded ${questions.length} questions`);
  console.log("🚀 Starting upload...\n");

  // Check what's already in the database
  const client = await pool.connect();
  const existing = await client.query("SELECT COUNT(*) FROM questions");
  console.log(`📊 Currently in database: ${existing.rows[0].count} questions`);
  console.log(`📥 Will try to insert: ${questions.length} questions\n`);

  let inserted  = 0;
  let skipped   = 0;
  let duplicate = 0;
  const errors  = [];

  try {
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      try {
        await client.query(
          `INSERT INTO questions
             (exam_type, institution, subject, year, question,
              option_a, option_b, option_c, option_d,
              correct_answer, explanation, difficulty)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            q.exam_type       || "JAMB",
            q.institution     || null,
            q.subject         || "",
            q.year            || null,
            q.question        || "",
            q.option_a        || "",
            q.option_b        || "",
            q.option_c        || "",
            q.option_d        || "",
            (q.correct_answer || "A").toUpperCase().trim(),
            q.explanation     || null,
            q.difficulty      || "medium",
          ]
        );
        inserted++;
      } catch (e) {
        if (e.message.includes("duplicate") || e.message.includes("unique")) {
          duplicate++;
        } else {
          skipped++;
          if (errors.length < 5) {
            errors.push({ q: (q.question || "").slice(0, 60), err: e.message });
          }
        }
      }

      // Progress every 100
      if ((i + 1) % 100 === 0 || i === questions.length - 1) {
        process.stdout.write(
          `\r   Progress: ${i + 1}/${questions.length} | ✅ Inserted: ${inserted} | ⏭ Skipped: ${duplicate + skipped}`
        );
      }
    }

    console.log("\n");
    console.log("════════════════════════════════════════");
    console.log("✅  UPLOAD COMPLETE");
    console.log(`   Inserted:   ${inserted} new questions`);
    console.log(`   Duplicates: ${duplicate} (already in DB — skipped)`);
    console.log(`   Errors:     ${skipped}`);

    // Final count
    const finalCount = await client.query("SELECT COUNT(*) FROM questions");
    console.log(`   TOTAL IN DB: ${finalCount.rows[0].count} questions`);
    console.log("════════════════════════════════════════");

    if (errors.length) {
      console.log("\n⚠️  Sample errors:");
      errors.forEach(e => console.log(`   "${e.q}" → ${e.err}`));
    }

  } catch (err) {
    console.error("\n❌ Upload failed:", err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

upload();
