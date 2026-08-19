const db = require("../config/db");
const { serverError } = require('../utils/errors');

// ─────────────────────────────────────────────────────────
// ── SPACED REPETITION (SM2 Algorithm) ────────────────────
// ─────────────────────────────────────────────────────────

// SM2 Algorithm — calculates next review interval
function sm2(easeFactor, interval, repetitions, quality) {
  // quality: 0-5 (0-2 = fail, 3-5 = pass)
  let newEF = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  newEF = Math.max(1.3, newEF);

  let newInterval, newReps;
  if (quality < 3) {
    newReps     = 0;
    newInterval = 1;
  } else {
    newReps = repetitions + 1;
    if (newReps === 1)      newInterval = 1;
    else if (newReps === 2) newInterval = 6;
    else                    newInterval = Math.round(interval * newEF);
  }

  return { easeFactor: newEF, interval: newInterval, repetitions: newReps };
}

// Get today's due cards for review
exports.getSpacedRepQueue = async (req, res) => {
  const { subject, limit = 20 } = req.query;
  try {
    const conditions = ["sr.student_id = $1", "sr.next_review <= CURRENT_DATE"];
    const params     = [req.student.id];
    let idx = 2;

    if (subject) { conditions.push(`q.subject = $${idx++}`); params.push(subject); }

    const result = await db.query(
      `SELECT q.id, q.subject, q.topic, q.question,
              q.option_a, q.option_b, q.option_c, q.option_d, q.difficulty,
              sr.ease_factor, sr.interval_days, sr.repetitions, sr.next_review
       FROM spaced_repetition sr
       JOIN questions q ON q.id = sr.question_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY sr.next_review ASC
       LIMIT $${idx}`,
      [...params, parseInt(limit)]
    );

    const total_due = await db.query(
      "SELECT COUNT(*) FROM spaced_repetition WHERE student_id = $1 AND next_review <= CURRENT_DATE",
      [req.student.id]
    );

    res.json({ questions: result.rows, total_due: parseInt(total_due.rows[0].count) });
  } catch (err) {
    serverError(res, err);
  }
};

// Update a card after review
exports.updateSpacedRep = async (req, res) => {
  const { question_id, quality } = req.body; // quality 0-5
  const student_id = req.student.id;

  try {
    const existing = await db.query(
      "SELECT * FROM spaced_repetition WHERE student_id = $1 AND question_id = $2",
      [student_id, question_id]
    );

    let ef = 2.5, interval = 1, reps = 0;
    if (existing.rows.length) {
      ef = parseFloat(existing.rows[0].ease_factor);
      interval = existing.rows[0].interval_days;
      reps = existing.rows[0].repetitions;
    }

    const { easeFactor, interval: newInterval, repetitions } = sm2(ef, interval, reps, quality);
    const nextReview = new Date();
    nextReview.setDate(nextReview.getDate() + newInterval);

    await db.query(
      `INSERT INTO spaced_repetition (student_id, question_id, ease_factor, interval_days, repetitions, next_review, last_reviewed)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE)
       ON CONFLICT (student_id, question_id) DO UPDATE SET
         ease_factor   = $3,
         interval_days = $4,
         repetitions   = $5,
         next_review   = $6,
         last_reviewed = CURRENT_DATE`,
      [student_id, question_id, easeFactor, newInterval, repetitions, nextReview.toISOString().split("T")[0]]
    );

    res.json({ success: true, next_review: nextReview.toISOString().split("T")[0], interval: newInterval });
  } catch (err) {
    serverError(res, err);
  }
};

// Add wrong answers to spaced repetition queue
exports.addToSpacedRep = async (req, res) => {
  const { question_ids } = req.body;
  const student_id = req.student.id;

  try {
    for (const qid of question_ids) {
      await db.query(
        `INSERT INTO spaced_repetition (student_id, question_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [student_id, qid]
      );
    }
    res.json({ success: true, added: question_ids.length });
  } catch (err) {
    serverError(res, err);
  }
};

// Get spaced rep stats
exports.getSpacedRepStats = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         COUNT(*) AS total_cards,
         COUNT(*) FILTER (WHERE next_review <= CURRENT_DATE) AS due_today,
         COUNT(*) FILTER (WHERE next_review > CURRENT_DATE) AS upcoming,
         COUNT(*) FILTER (WHERE repetitions = 0) AS new_cards,
         ROUND(AVG(ease_factor),2) AS avg_ease
       FROM spaced_repetition WHERE student_id = $1`,
      [req.student.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    serverError(res, err);
  }
};

// ─────────────────────────────────────────────────────────
// ── EXAM PERSONALITY PROFILE ──────────────────────────────
// ─────────────────────────────────────────────────────────

exports.getPersonalityProfile = async (req, res) => {
  const student_id = req.student.id;
  try {
    const [sessions, answers, confidence] = await Promise.all([
      db.query(
        `SELECT total_questions, score, percentage, time_taken_seconds, completed_at
         FROM exam_sessions WHERE student_id = $1
         ORDER BY completed_at DESC LIMIT 20`,
        [student_id]
      ),
      db.query(
        `SELECT ea.time_spent_seconds, ea.is_correct
         FROM exam_answers ea
         JOIN exam_sessions es ON es.id = ea.session_id
         WHERE es.student_id = $1 AND ea.time_spent_seconds > 0
         LIMIT 200`,
        [student_id]
      ),
      db.query(
        `SELECT confidence, is_correct, COUNT(*) AS count
         FROM answer_confidence WHERE student_id = $1
         GROUP BY confidence, is_correct`,
        [student_id]
      ).catch(() => ({ rows: [] })),
    ]);

    if (!sessions.rows.length) {
      return res.json({ profile: null, message: "Take at least 3 exams to see your personality profile." });
    }

    // Calculate avg speed per question
    const avgSpeed = answers.rows.length
      ? answers.rows.reduce((s, a) => s + parseInt(a.time_spent_seconds || 0), 0) / answers.rows.length
      : 0;

    // Calculate accuracy
    const avgAccuracy = sessions.rows.length
      ? sessions.rows.reduce((s, r) => s + parseFloat(r.percentage), 0) / sessions.rows.length
      : 0;

    // Detect overconfidence (sure but wrong)
    let overconfidentCount = 0, unsureCorrectCount = 0, totalConf = 0;
    confidence.rows.forEach(r => {
      const count = parseInt(r.count);
      totalConf += count;
      if (r.confidence === 3 && !r.is_correct) overconfidentCount += count;
      if (r.confidence === 1 && r.is_correct)  unsureCorrectCount += count;
    });
    const overconfidenceRate = totalConf > 0 ? (overconfidentCount / totalConf) * 100 : 0;

    // Determine profile type
    let profile_type, icon, description, tips;
    if (avgSpeed < 20 && avgAccuracy < 55) {
      profile_type = "fast_inaccurate";
      icon = "⚡";
      description = "Fast but Inaccurate";
      tips = [
        "Slow down — rushing causes careless mistakes",
        "Read each question fully before choosing",
        "Spend at least 30 seconds per question",
        "Mark difficult questions and come back to them",
      ];
    } else if (avgSpeed > 60 && avgAccuracy >= 65) {
      profile_type = "slow_accurate";
      icon = "🔬";
      description = "Slow but Accurate";
      tips = [
        "Great accuracy! Now focus on speed",
        "Practice with shorter time limits to build pace",
        "Trust your first instinct more often",
        "Use process of elimination to speed up",
      ];
    } else if (overconfidenceRate > 25) {
      profile_type = "guesser";
      icon = "🎲";
      description = "Guesser / Overconfident";
      tips = [
        "You often feel sure but get answers wrong",
        "Study the topics you feel confident about more carefully",
        "Practice 'Why You Got It Wrong' review",
        "Use confidence-based testing to identify blind spots",
      ];
    } else if (avgAccuracy >= 65 && avgSpeed >= 20 && avgSpeed <= 60) {
      profile_type = "balanced";
      icon = "⚖️";
      description = "Balanced Learner";
      tips = [
        "Excellent balance of speed and accuracy!",
        "Push for above 75% to reach the top tier",
        "Focus on your weakest subjects",
        "Daily challenge will keep you sharp",
      ];
    } else {
      profile_type = "developing";
      icon = "🌱";
      description = "Still Developing";
      tips = [
        "Keep practising — you're building your style",
        "Take at least 5 more exams for a better profile",
        "Mix JAMB and Post-UTME practice",
        "Use topic-by-topic study for weak areas",
      ];
    }

    // Trend (improving or declining)
    const recent3   = sessions.rows.slice(0, 3).map(s => parseFloat(s.percentage));
    const previous3 = sessions.rows.slice(3, 6).map(s => parseFloat(s.percentage));
    const recentAvg = recent3.reduce((a, b) => a + b, 0) / (recent3.length || 1);
    const prevAvg   = previous3.reduce((a, b) => a + b, 0) / (previous3.length || 1);
    const trend     = previous3.length === 0 ? "stable"
                    : recentAvg > prevAvg + 3 ? "improving"
                    : recentAvg < prevAvg - 3 ? "declining"
                    : "stable";

    // Update DB
    await db.query(
      `INSERT INTO exam_personality (student_id, profile_type, avg_speed_secs, avg_accuracy, total_exams)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (student_id) DO UPDATE SET
         profile_type = $2, avg_speed_secs = $3, avg_accuracy = $4,
         total_exams = $5, updated_at = NOW()`,
      [student_id, profile_type, avgSpeed, avgAccuracy, sessions.rows.length]
    );

    res.json({
      profile: {
        type: profile_type, icon, description,
        avg_speed_secs: Math.round(avgSpeed),
        avg_accuracy:   Math.round(avgAccuracy),
        overconfidence_rate: Math.round(overconfidenceRate),
        trend, tips,
        total_exams: sessions.rows.length,
      }
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ─────────────────────────────────────────────────────────
// ── BEAT YOURSELF MODE ────────────────────────────────────
// ─────────────────────────────────────────────────────────

exports.getBeatYourselfStats = async (req, res) => {
  const student_id = req.student.id;
  const { subject } = req.query;

  try {
    // Get their best previous score for this subject
    const best = await db.query(
      `SELECT subject, MAX(percentage) AS best_score,
              AVG(percentage) AS avg_score,
              COUNT(*) AS total_attempts
       FROM exam_sessions
       WHERE student_id = $1
         ${subject ? "AND subject = $2" : ""}
       GROUP BY subject
       ORDER BY total_attempts DESC
       LIMIT 10`,
      subject ? [student_id, subject] : [student_id]
    );

    // Get recent beat-yourself records
    const records = await db.query(
      `SELECT subject, baseline_score, current_score, beat, improvement, attempt_date
       FROM beat_yourself WHERE student_id = $1
       ORDER BY attempt_date DESC LIMIT 20`,
      [student_id]
    );

    const beatenCount = records.rows.filter(r => r.beat).length;
    const totalBY     = records.rows.length;

    res.json({
      best_scores:     best.rows,
      recent_attempts: records.rows,
      beaten_count:    beatenCount,
      total_attempts:  totalBY,
      beat_rate:       totalBY > 0 ? Math.round((beatenCount / totalBY) * 100) : 0,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// Record beat yourself result (called after exam submit)
exports.recordBeatYourself = async (req, res) => {
  const { subject, current_score, session_id } = req.body;
  const student_id = req.student.id;

  try {
    // Get best previous score
    const prev = await db.query(
      `SELECT MAX(percentage) AS best
       FROM exam_sessions
       WHERE student_id = $1 AND subject = $2 AND id != $3`,
      [student_id, subject, session_id]
    );

    const baseline = parseFloat(prev.rows[0]?.best || 0);
    const current  = parseFloat(current_score);
    const beat     = current > baseline;
    const improvement = current - baseline;

    await db.query(
      `INSERT INTO beat_yourself (student_id, subject, baseline_score, current_score, beat, improvement, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [student_id, subject, baseline, current, beat, improvement, session_id]
    );

    res.json({ beat, baseline, current, improvement: parseFloat(improvement.toFixed(1)) });
  } catch (err) {
    serverError(res, err);
  }
};

// ─────────────────────────────────────────────────────────
// ── MISTAKE PATTERN DETECTION ─────────────────────────────
// ─────────────────────────────────────────────────────────

exports.getMistakePatterns = async (req, res) => {
  const student_id = req.student.id;

  try {
    const [topicErrors, timeErrors, repeatErrors] = await Promise.all([

      // Most errors by topic
      db.query(
        `SELECT q.topic, q.subject,
                COUNT(*) AS wrong_count,
                ROUND(AVG(ea.time_spent_seconds)) AS avg_time
         FROM exam_answers ea
         JOIN exam_sessions es ON es.id = ea.session_id
         JOIN questions q ON q.id = ea.question_id
         WHERE es.student_id = $1 AND ea.is_correct = false AND q.topic IS NOT NULL
         GROUP BY q.topic, q.subject
         ORDER BY wrong_count DESC
         LIMIT 8`,
        [student_id]
      ),

      // Time pressure errors (questions where they spent very little time)
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE ea.time_spent_seconds < 10 AND ea.is_correct = false) AS rushed_wrong,
           COUNT(*) FILTER (WHERE ea.time_spent_seconds > 60 AND ea.is_correct = false) AS slow_wrong,
           COUNT(*) FILTER (WHERE ea.time_spent_seconds < 10 AND ea.is_correct = true)  AS rushed_right,
           COUNT(*) FILTER (WHERE ea.is_correct = false) AS total_wrong
         FROM exam_answers ea
         JOIN exam_sessions es ON es.id = ea.session_id
         WHERE es.student_id = $1`,
        [student_id]
      ),

      // Questions answered wrong more than once
      db.query(
        `SELECT wa.question_id, wa.times_wrong, q.subject, q.topic, q.question
         FROM wrong_answers wa
         JOIN questions q ON q.id = wa.question_id
         WHERE wa.student_id = $1 AND wa.times_wrong >= 2
         ORDER BY wa.times_wrong DESC
         LIMIT 5`,
        [student_id]
      ),
    ]);

    const timeData      = timeErrors.rows[0] || {};
    const totalWrong    = parseInt(timeData.total_wrong || 0);
    const rushedWrong   = parseInt(timeData.rushed_wrong || 0);
    const slowWrong     = parseInt(timeData.slow_wrong || 0);
    const rushRate      = totalWrong > 0 ? Math.round((rushedWrong / totalWrong) * 100) : 0;
    const slowRate      = totalWrong > 0 ? Math.round((slowWrong / totalWrong) * 100) : 0;

    const patterns = [];
    if (rushRate > 30) patterns.push({ type: "rushing", title: "⚡ Rushing Pattern", desc: `${rushRate}% of your wrong answers were answered in under 10 seconds. You're rushing through questions.`, advice: "Slow down. Read each question completely before choosing." });
    if (slowRate > 20) patterns.push({ type: "overthinking", title: "🤔 Overthinking Pattern", desc: `${slowRate}% of your wrong answers took over 60 seconds. Overthinking is costing you.`, advice: "Trust your first instinct. If unsure after 30 seconds, move on and come back." });
    if (repeatErrors.rows.length > 0) patterns.push({ type: "repeat_errors", title: "🔁 Repeat Mistakes", desc: `You have ${repeatErrors.rows.length} questions you've gotten wrong multiple times.`, advice: "Use Spaced Repetition to conquer these specific questions." });

    res.json({
      topic_errors:   topicErrors.rows,
      time_patterns:  { rush_rate: rushRate, slow_rate: slowRate, rushed_wrong: rushedWrong, slow_wrong: slowWrong },
      repeat_errors:  repeatErrors.rows,
      patterns,
    });
  } catch (err) {
    serverError(res, err);
  }
};
