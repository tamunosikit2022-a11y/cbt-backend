const fs = require("fs");
const path = require("path");

let totalChanges = 0;

function patchFile(filePath, replacements) {
  const full = path.join(__dirname, "..", filePath);
  let content = fs.readFileSync(full, "utf8");
  let fileChanges = 0;

  for (const { find, replace, label } of replacements) {
    if (content.match(find)) {
      content = content.replace(find, replace);
      fileChanges++;
      console.log(`  [OK] ${label}`);
    } else {
      console.log(`  [SKIP] ${label} (pattern not found -- already fixed, or file differs from expected)`);
    }
  }

  if (fileChanges > 0) {
    fs.writeFileSync(full, content, "utf8");
    console.log(`[OK] ${filePath} -- ${fileChanges} change(s) written\n`);
  } else {
    console.log(`[SKIP] ${filePath} -- no changes needed\n`);
  }
  totalChanges += fileChanges;
}

console.log("Patching migrations/innovation_tables.sql ...");
patchFile("migrations/innovation_tables.sql", [
  {
    label: "Remove conflicting exam_answers table definition",
    find: /-- EXAM ANSWERS[\s\S]*?CREATE INDEX IF NOT EXISTS idx_exam_answers_question ON exam_answers\(question_id\);\r?\n/,
    replace:
      "-- EXAM ANSWERS -- FIX: this used to CREATE TABLE IF NOT EXISTS exam_answers\r\n" +
      "-- with a student_id/exam_id/answered_at shape, assuming the table didn't\r\n" +
      "-- exist yet. It actually already existed in production with a different,\r\n" +
      "-- correct shape (session_id -> exam_sessions.id, created_at, explanation --\r\n" +
      "-- see examController.js's real INSERT). The real exam_answers table is\r\n" +
      "-- fine and doesn't need anything added here -- weaknessDetectorController.js\r\n" +
      "-- was the actual bug (querying columns that were never real), fixed\r\n" +
      "-- separately to JOIN through exam_sessions instead.\r\n" +
      "-- ----------------------------------------------------------------\r\n\r\n",
  },
]);

console.log("Patching src/controllers/weaknessDetectorController.js ...");
patchFile("src/controllers/weaknessDetectorController.js", [
  {
    label: "Fix query #1: JOIN exam_sessions, use es.student_id",
    find: /JOIN questions q ON q\.id = ea\.question_id\r?\n    WHERE ea\.student_id = \$1/,
    replace:
      "JOIN exam_sessions es ON es.id = ea.session_id\r\n" +
      "    JOIN questions q ON q.id = ea.question_id\r\n" +
      "    WHERE es.student_id = $1",
  },
  {
    label: "Fix query #1: use ea.created_at instead of ea.answered_at",
    find: /MAX\(ea\.answered_at\)\s+AS last_seen/,
    replace: "MAX(ea.created_at)                  AS last_seen",
  },
  {
    label: "Fix query #2 (7-day window): JOIN exam_sessions, use es.student_id + ea.created_at",
    find: /JOIN questions q ON q\.id=ea\.question_id\r?\n      WHERE ea\.student_id=\$1 AND ea\.answered_at > NOW\(\) - INTERVAL '7 days'/,
    replace:
      "JOIN exam_sessions es ON es.id = ea.session_id\r\n" +
      "      JOIN questions q ON q.id=ea.question_id\r\n" +
      "      WHERE es.student_id=$1 AND ea.created_at > NOW() - INTERVAL '7 days'",
  },
  {
    label: "Fix query #3 (14-7 day window): JOIN exam_sessions, use es.student_id + ea.created_at",
    find: /JOIN questions q ON q\.id=ea\.question_id\r?\n      WHERE ea\.student_id=\$1\r?\n        AND ea\.answered_at BETWEEN NOW\(\) - INTERVAL '14 days' AND NOW\(\) - INTERVAL '7 days'/,
    replace:
      "JOIN exam_sessions es ON es.id = ea.session_id\r\n" +
      "      JOIN questions q ON q.id=ea.question_id\r\n" +
      "      WHERE es.student_id=$1\r\n" +
      "        AND ea.created_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'",
  },
]);

console.log(
  totalChanges > 0
    ? `Done -- ${totalChanges} total change(s) applied.`
    : "Done -- nothing changed (already patched, or check manually)."
);
