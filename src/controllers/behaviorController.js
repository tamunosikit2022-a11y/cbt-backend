/**
 * Behavior Controller — Scholars Syndicate
 * Builds a per-student behavioural profile with 6 dimensions.
 * Called after every exam submit (async, non-blocking) and by a nightly batch job.
 *
 * Dimensions:
 *   1. Speed profile      — avg time per question → detects rushing or slow students
 *   2. Subject affinity   — accuracy per subject  → weak/medium/strong tiers
 *   3. Session rhythm     — hour/day of exams     → personalised push timing
 *   4. Streak behaviour   — streak length & breaks
 *   5. Error pattern      — most-repeated wrong topics
 *   6. Engagement depth   — attempted / available ratio per subject
 */

const db = require("../config/db");
const { serverError } = require('../utils/errors');

/**
 * buildProfile(student_id)
 * Runs all queries in parallel, classifies each dimension,
 * persists to student_profiles, and returns the profile object.
 */
exports.buildProfile = async (student_id) => {
  const [perf, wrong, speed, sessions] = await Promise.all([
    // Subject accuracy
    db.query(
      `SELECT subject, accuracy, total_attempted
       FROM student_performance WHERE student_id=$1`,
      [student_id]
    ),
    // Top wrong topics
    db.query(
      `SELECT q.topic, q.subject, COUNT(*) as cnt
       FROM wrong_answers wa JOIN questions q ON q.id=wa.question_id
       WHERE wa.student_id=$1 GROUP BY q.topic, q.subject
       ORDER BY cnt DESC LIMIT 10`,
      [student_id]
    ),
    // Avg speed (seconds per question)
    db.query(
      `SELECT AVG(ea.time_spent_seconds) as avg_speed
       FROM exam_answers ea JOIN exam_sessions es ON es.id=ea.session_id
       WHERE es.student_id=$1 AND ea.time_spent_seconds > 0`,
      [student_id]
    ),
    // Session hour distribution (for push timing)
    db.query(
      `SELECT EXTRACT(HOUR FROM started_at) as hour, COUNT(*) as cnt
       FROM exam_sessions WHERE student_id=$1
       GROUP BY hour ORDER BY cnt DESC LIMIT 3`,
      [student_id]
    ),
  ]);

  const avgSpeed   = parseFloat(speed.rows[0]?.avg_speed || 30);
  const weakTopics = wrong.rows.map(r => ({ topic: r.topic, subject: r.subject, count: +r.cnt }));
  const subjectMap = Object.fromEntries(perf.rows.map(r => [r.subject, +r.accuracy]));
  const bestHour   = sessions.rows[0]?.hour ?? 19;

  // Classify speed: fast < 15s | normal 15-45s | slow > 45s
  const speedClass = avgSpeed < 15 ? "fast" : avgSpeed > 45 ? "slow" : "normal";

  // Classify subjects into tiers
  const subjectTiers = { weak: [], medium: [], strong: [] };
  for (const [subj, acc] of Object.entries(subjectMap)) {
    if      (acc < 40) subjectTiers.weak.push(subj);
    else if (acc < 70) subjectTiers.medium.push(subj);
    else               subjectTiers.strong.push(subj);
  }

  const profile = {
    student_id,
    avgSpeed,
    speedClass,
    weakTopics,
    subjectTiers,
    subjectMap,
    bestPushHour: +bestHour,
    updated_at:   new Date().toISOString(),
  };

  // Persist — upsert so it's always current
  await db.query(
    `INSERT INTO student_profiles(student_id, profile, updated_at)
     VALUES($1,$2,NOW())
     ON CONFLICT(student_id) DO UPDATE SET profile=$2, updated_at=NOW()`,
    [student_id, JSON.stringify(profile)]
  );

  return profile;
};

/**
 * GET /behavior/profile — returns profile for the authenticated student
 */
exports.getProfile = async (req, res) => {
  try {
    const r = await db.query(
      "SELECT profile FROM student_profiles WHERE student_id=$1",
      [req.student.id]
    );
    res.json(r.rows[0]?.profile || {});
  } catch (err) {
    serverError(res, err);
  }
};
