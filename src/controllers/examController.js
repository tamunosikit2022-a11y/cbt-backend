const db = require("../config/db");
const { spendTokens } = require('./tokenController');
// FIX: serverError used to be declared reachable from only one function, so
// every other catch block in this file (15 of them) expected a module-level
// import and got a ReferenceError instead — crashing the request instead of
// returning a clean error.
const { serverError } = require('../utils/errors');

const { chatCompletion } = require('../utils/aiProvider');

// ── EXAMINER BREAKDOWN — AI explains why each option is right/wrong ──
exports.getExaminerBreakdown = async (req, res) => {
  const student_id = req.student.id;
  const { question_id, chosen_answer } = req.body;
  if (!question_id) return res.status(400).json({ error: 'question_id required' });

  try {
    const qRes = await db.query(
      `SELECT question, option_a, option_b, option_c, option_d, correct_answer, subject, topic, explanation
       FROM questions WHERE id=$1`, [question_id]
    );
    if (!qRes.rows.length) return res.status(404).json({ error: 'Question not found' });
    const q = qRes.rows[0];

    // Spend 1 token (skip if premium/unlimited — handled inside spendTokens)
    try {
      await spendTokens(student_id, 'examiner_breakdown');
    } catch (e) {
      if (e.code === 'INSUFFICIENT_TOKENS') {
        return res.status(402).json({ error: 'Insufficient tokens', cost: e.cost, feature: e.feature });
      }
      throw e;
    }

    const prompt = `You are a strict JAMB examiner explaining a multiple-choice question to a Nigerian student.

Question: ${q.question}
A: ${q.option_a}
B: ${q.option_b}
C: ${q.option_c}
D: ${q.option_d}
Correct answer: ${q.correct_answer}
Student's answer: ${chosen_answer || 'Not answered'}
Subject: ${q.subject}${q.topic ? `, Topic: ${q.topic}` : ''}

Write a short "Examiner's Breakdown" (max 150 words) that:
1. States why the correct answer (${q.correct_answer}) is right.
2. Explains briefly why EACH of the other three options is wrong (one short sentence each).
3. If the student's answer was wrong, gently note the likely misconception that led to it.
Use simple, encouraging language suitable for a secondary school student. Use short paragraphs, no markdown headers.`;

    const completion = await chatCompletion({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      maxTokens: 400,
      taskType: 'explain', // paid, reasoning-heavy explanation — prefer Gemini first
    });

    const breakdown = completion.content?.trim() || '';
    res.json({ breakdown, correct_answer: q.correct_answer });
  } catch (err) {
    console.error('getExaminerBreakdown error:', err.message);
    serverError(res, err);
  }
};


// ── SAFE RANDOM SAMPLING — true random draw from the FULL matching pool ──
// FIX: The old version used TABLESAMPLE SYSTEM(pct), which samples random
// PHYSICAL PAGES of the whole `questions` table, not random rows matching
// the filter. For a narrow filter (e.g. a single university course with a
// few hundred rows inside a table of tens of thousands of JAMB/WAEC/NECO
// rows), the handful of pages holding those rows were rarely included in
// the sampled pages, so the query kept falling back to a plain
// `OFFSET x LIMIT n` scan with NO ORDER BY — which Postgres returns in a
// stable, storage-order-ish sequence, not a real shuffle. Net effect:
// students kept seeing the same narrow slice of questions instead of the
// full bank, and (for small banks especially) got repeats far sooner than
// they should have.
//
// This version pulls every matching question id (cheap — ids only, and
// exam_type/subject/institution should be indexed), shuffles them in
// memory with a proper Fisher–Yates shuffle, and takes the first `limit`.
// That guarantees a uniformly random draw across the ENTIRE filtered pool
// every single time, however large or small it is.
async function sampleQuestions(conditions, params, limit) {
  const idQuery = `SELECT q.id FROM questions q WHERE ${conditions.join(" AND ")}`;
  const idRes = await db.query(idQuery, params);
  const allIds = idRes.rows.map(r => r.id);
  if (!allIds.length) return { rows: [] };

  // Fisher–Yates shuffle — uniform, unbiased random ordering
  for (let i = allIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allIds[i], allIds[j]] = [allIds[j], allIds[i]];
  }
  const selectedIds = allIds.slice(0, limit);

  const fullQuery = `
    SELECT q.id, q.subject, q.topic, q.year, q.question,
           q.option_a, q.option_b, q.option_c, q.option_d,
           q.difficulty, q.exam_type, q.institution, q.explanation
    FROM questions q
    WHERE q.id = ANY($1::int[])`;
  const r = await db.query(fullQuery, [selectedIds]);

  // Re-shuffle returned rows too — ANY($1) does not preserve array order
  for (let i = r.rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r.rows[i], r.rows[j]] = [r.rows[j], r.rows[i]];
  }
  return r;
}

// ── GET QUESTIONS ─────────────────────────────────────────
exports.getQuestions = async (req, res) => {
  const { exam_type, subject, institution, mode, difficulty } = req.query;
  const limit = parseInt(req.query.limit) || 40;

  try {
    let query, params, result;

    if (mode === "weakness") {
      // weakness mode: pull from wrong_answers — these columns now exist
      query = `
        SELECT q.id, q.subject, q.topic, q.year, q.question,
               q.option_a, q.option_b, q.option_c, q.option_d,
               q.difficulty, q.exam_type, q.institution, q.explanation
        FROM questions q
        JOIN wrong_answers wa ON wa.question_id = q.id
        WHERE wa.student_id = $1
          AND ($2::text IS NULL OR q.subject = $2)
        ORDER BY wa.times_wrong DESC
        LIMIT $3`;
      params = [req.student.id, subject || null, limit];
      result = await db.query(query, params);
    } else {
      const student_id = req.student?.id || null;
      const conditions = ["q.exam_type = $1"];
      params = [exam_type || "JAMB"];
      let idx = 2;

      if (subject)     { conditions.push(`q.subject = $${idx++}`);     params.push(subject); }
      if (institution) { conditions.push(`q.institution = $${idx++}`); params.push(institution); }
      if (difficulty && difficulty !== "any") { conditions.push(`q.difficulty = $${idx++}`); params.push(difficulty); }

      // Exclude already-seen questions (resets after 80% seen)
      if (student_id) {
        const seenResult = await db.query(
          `SELECT DISTINCT ea.question_id
           FROM exam_answers ea
           JOIN exam_sessions es ON es.id = ea.session_id
           WHERE es.student_id = $1 AND es.exam_type = $2
             ${subject ? "AND es.subject = $3" : ""}`,
          subject ? [student_id, exam_type || "JAMB", subject] : [student_id, exam_type || "JAMB"]
        );
        const seenIds = seenResult.rows.map(r => r.question_id);
        const cntRes  = await db.query(
          `SELECT COUNT(*) as cnt FROM questions q WHERE ${conditions.join(" AND ")}`, params
        );
        const totalAvailable = parseInt(cntRes.rows[0].cnt) || 0;
        const resetThreshold = Math.floor(totalAvailable * 0.8);
        if (seenIds.length > 0 && seenIds.length < resetThreshold) {
          conditions.push(`q.id NOT IN (${seenIds.map((_,i) => `$${idx + i}`).join(",")})`);
          seenIds.forEach(id => params.push(id));
          idx += seenIds.length;
        }
      }

      // Use fast sampling instead of ORDER BY RANDOM()
      result = await sampleQuestions(conditions, params, limit);
    }

    if (!result.rows.length)
      return res.status(404).json({ error: "No questions found for this selection." });

    // Strip correct_answer; include explanation only for study/weakness modes
    const questions = result.rows.map(({ correct_answer, explanation, ...q }) => ({
      ...q,
      ...(mode === "study" || mode === "weakness" ? { explanation } : {}),
    }));

    res.json({ questions, total: questions.length });
  } catch (err) {
    console.error("getQuestions error:", err.message);
    serverError(res, err);
  }
};

// ── SUBMIT EXAM ───────────────────────────────────────────
exports.submitExam = async (req, res) => {
  const { exam_type, subject, institution, mode, answers, time_taken_seconds } = req.body;
  const student_id = req.student.id;

  if (!answers || !Array.isArray(answers))
    return res.status(400).json({ error: "Answers array required." });

  // SAFETY: cap batch size per request. Without this, the per-minute rate
  // limiter on /submit doesn't actually stop harvesting — a single request
  // could carry thousands of question_ids and return their correct_answer
  // in one shot. 250 comfortably covers a full multi-subject JAMB mock
  // (4 subjects x ~50) while blocking bulk dumps.
  const MAX_ANSWERS_PER_SUBMIT = 250;
  if (answers.length > MAX_ANSWERS_PER_SUBMIT) {
    return res.status(400).json({
      error: `Too many answers in one submission (max ${MAX_ANSWERS_PER_SUBMIT}).`
    });
  }
  if (answers.length === 0) {
    return res.status(400).json({ error: "Answers array cannot be empty." });
  }

  try {
    // De-dupe question_ids so a caller can't inflate the "legit-looking"
    // request by repeating the same id many times while still asking for
    // a wide unique spread across separate rapid requests.
    const ids = [...new Set(answers.map(a => a.question_id))];
    const qResult = await db.query(
      "SELECT id, correct_answer, explanation, subject FROM questions WHERE id = ANY($1)",
      [ids]
    );

    const correctMap = {};
    qResult.rows.forEach(q => { correctMap[q.id] = q; });

    let score = 0;
    let scored = 0; // questions actually counted toward the score (shielded wrong answers are excluded)
    const processed = answers.map(a => {
      const q = correctMap[a.question_id];
      if (!q) return null;
      const is_correct = (q.correct_answer || "").toUpperCase() === (a.selected_answer || "").toUpperCase();
      const shielded    = !!a.shielded && !is_correct; // Retry Shield used + got it wrong → no penalty
      if (!shielded) {
        scored++;
        if (is_correct) score++;
      }
      return {
        question_id:        a.question_id,
        selected_answer:    a.selected_answer,
        correct_answer:     q.correct_answer,
        explanation:        q.explanation || null,
        is_correct,
        shielded,
        time_spent_seconds: a.time_spent_seconds || 0,
      };
    }).filter(Boolean);

    const total      = scored;
    const percentage = total > 0 ? parseFloat(((score / total) * 100).toFixed(2)) : 0;

    // ── CORE GRADING RECORD — wrapped in a transaction ──────────────────
    // These four writes together represent "this exam attempt happened and
    // was graded." If any one fails partway (e.g. the wrong_answers upsert
    // errors on bad data), we don't want a session+answers row committed
    // with no matching performance update, or vice versa — that's exactly
    // the kind of silent inconsistency that's hard to debug later because
    // the leaderboard/history disagree with each other for one student.
    // (Coins/streak/points below stay outside this transaction — they're
    // independent reward counters, not part of the grading record itself.)
    const client = await db.connect();
    let session_id;
    try {
      await client.query("BEGIN");

      // Save session
      const sessionRes = await client.query(
        `INSERT INTO exam_sessions
           (student_id, exam_type, institution, subject, mode,
            total_questions, score, percentage, time_taken_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [student_id, exam_type, institution || null, subject,
         mode || "exam", total, score, percentage, time_taken_seconds || 0]
      );
      session_id = sessionRes.rows[0].id;

      // Batch insert exam_answers — FIX: now saves explanation so history/revisits work
      if (processed.length > 0) {
        const answerVals = processed.map((_, i) =>
          `($${i * 6 + 1},$${i * 6 + 2},$${i * 6 + 3},$${i * 6 + 4},$${i * 6 + 5},$${i * 6 + 6})`
        ).join(",");
        const answerFlat = processed.flatMap(a =>
          [session_id, a.question_id, a.selected_answer, a.is_correct, a.time_spent_seconds, a.explanation || null]
        );
        await client.query(
          `INSERT INTO exam_answers
             (session_id, question_id, selected_answer, is_correct, time_spent_seconds, explanation)
           VALUES ${answerVals}`,
          answerFlat
        );
      }

      // ── FIX: Batch upsert wrong_answers — NOW SAFE (columns exist after migration) ──
      const wrongIds = processed.filter(a => !a.is_correct).map(a => a.question_id);
      if (wrongIds.length > 0) {
        const wrongVals = wrongIds.map((_, i) => `($1,$${i + 2},1,NOW())`).join(",");
        await client.query(
          `INSERT INTO wrong_answers (student_id, question_id, times_wrong, last_wrong_at)
           VALUES ${wrongVals}
           ON CONFLICT (student_id, question_id)
           DO UPDATE SET
             times_wrong   = wrong_answers.times_wrong + 1,
             last_wrong_at = NOW()`,
          [student_id, ...wrongIds]
        );
      }

      // Remove from wrong_answers when answered correctly
      const correctIds = processed.filter(a => a.is_correct).map(a => a.question_id);
      if (correctIds.length > 0) {
        await client.query(
          "DELETE FROM wrong_answers WHERE student_id = $1 AND question_id = ANY($2)",
          [student_id, correctIds]
        );
      }

      // Update per-subject performance
      const correctCount = processed.filter(a => a.is_correct).length;
      await client.query(
        `INSERT INTO student_performance
           (student_id, subject, total_attempted, total_correct, accuracy, last_updated)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (student_id, subject) DO UPDATE SET
           total_attempted = student_performance.total_attempted + $3,
           total_correct   = student_performance.total_correct   + $4,
           accuracy        = ROUND(
             ((student_performance.total_correct + $4)::numeric /
              NULLIF(student_performance.total_attempted + $3, 0)) * 100, 2),
           last_updated    = NOW()`,
        [student_id, subject, total, correctCount, percentage]
      );

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK").catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    // Update streak
    await db.query(
      `INSERT INTO streaks (student_id, current_streak, longest_streak, last_activity_date)
       VALUES ($1,1,1,CURRENT_DATE)
       ON CONFLICT (student_id) DO UPDATE SET
         current_streak = CASE
           WHEN streaks.last_activity_date = CURRENT_DATE - 1 THEN streaks.current_streak + 1
           WHEN streaks.last_activity_date = CURRENT_DATE     THEN streaks.current_streak
           ELSE 1 END,
         longest_streak = GREATEST(
           streaks.longest_streak,
           CASE
             WHEN streaks.last_activity_date = CURRENT_DATE - 1 THEN streaks.current_streak + 1
             ELSE 1 END),
         last_activity_date = CURRENT_DATE`,
      [student_id]
    );

    // Award XP: base 10 + bonus for score
    const xpEarned = 10 + Math.floor(percentage / 10) * 2;
    await db.query(
      `UPDATE students SET points = COALESCE(points,0) + $1 WHERE id = $2`,
      [xpEarned, student_id]
    );

    // ── Upgrade: full badge system check (replaces old innovationController call)
    const { checkBadgesForStudent } = require("./badgesController");
    checkBadgesForStudent(student_id, req.app?.get("io")).catch(() => {});

    // ── Upgrade: mission progress
    const { updateMissionProgress } = require("./missionsController");
    updateMissionProgress(student_id, "exam_complete").catch(() => {});
    if (percentage >= 70)  updateMissionProgress(student_id, "score_70").catch(() => {});
    if (percentage >= 100) updateMissionProgress(student_id, "score_100").catch(() => {});

    // ── Referral reward: fires once, on the referred student's FIRST
    // completed exam — matches what ReferEarn.js promises ("they complete
    // their first exam") and closes the fraud gap where the reward used to
    // fire instantly at signup with no verification a real person was behind it.
    const { rewardReferralOnFirstExam } = require("./referralRewardHelper");
    rewardReferralOnFirstExam(student_id).catch(err =>
      console.error("Referral reward check failed:", err.message)
    );

    // ── Parent notification (SMS) — fire-and-forget, safe no-op if no
    // parent is registered or Termii isn't configured (see notifyParent()).
    const { notifyParent } = require("./parentNotificationController");
    notifyParent(student_id, { subject, score, total, percentage, exam_type }).catch(() => {});

    // ── Upgrade: team mission progress
    const { updateTeamMissionProgress } = require("./teamMissionsController");
    updateTeamMissionProgress(student_id, "questions_answered", score, req.app?.get("io")).catch(() => {});
    if (percentage >= 100) updateTeamMissionProgress(student_id, "perfect_scores", 1, req.app?.get("io")).catch(() => {});

    // ── Upgrade: total sessions counter + midnight session tracking
    const hour = new Date().getHours();
    await db.query(
      `UPDATE students SET
         total_sessions      = COALESCE(total_sessions,0) + 1,
         midnight_sessions   = COALESCE(midnight_sessions,0) + $1
       WHERE id = $2`,
      [hour >= 0 && hour < 4 ? 1 : 0, student_id]
    ).catch(() => {});

    // Rebuild behaviour profile (async, non-blocking)
    const { buildProfile } = require("./behaviorController");
    buildProfile(student_id).catch(() => {});

    // Award coins
    const coinsEarned = 10 + Math.floor(percentage / 10);
    await db.query(
      `UPDATE students SET coins = COALESCE(coins,0) + $1 WHERE id = $2`,
      [coinsEarned, student_id]
    );

    // ── Upgrade: micro-interactions — coin fly + XP bar + streak fire
    const io = req.app?.get("io");
    if (io) {
      const { fxCoinFly, fxXPBar, fxStreakFire } = require("./microController");
      fxCoinFly(io, student_id, coinsEarned, "exam");
      fxXPBar(io, student_id, { before: 0, after: xpEarned, levelBefore: 0, levelAfter: 0 });
      // Fire streak animation if streak extended
      const streakRow = await db.query(
        `SELECT COALESCE(current_streak,0) as streak FROM streaks WHERE student_id=$1`, [student_id]
      ).catch(() => ({ rows: [{ streak: 0 }] }));
      const streak = parseInt(streakRow.rows[0]?.streak || 0);
      if (streak > 0) fxStreakFire(io, student_id, { streak });
    }

    res.json({
      session_id,
      score,
      total,
      percentage,
      answers:      processed,
      xp_earned:    xpEarned,
      coins_earned: coinsEarned,
    });
  } catch (err) {
    console.error("Submit exam error:", err.message, err.stack);
    serverError(res, err);
  }
};

// ── EXAM HISTORY ──────────────────────────────────────────
exports.getHistory = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, exam_type, institution, subject, mode,
              total_questions, score, percentage,
              time_taken_seconds, completed_at
       FROM exam_sessions
       WHERE student_id = $1
       ORDER BY completed_at DESC
       LIMIT 50`,
      [req.student.id]
    );
    res.json(result.rows);
  } catch (err) {
    serverError(res, err);
  }
};

// ── PERFORMANCE ANALYTICS ─────────────────────────────────
exports.getPerformance = async (req, res) => {
  try {
    const [perf, wrong, sessions, national, history] = await Promise.all([
      db.query(
        `SELECT subject, total_attempted, total_correct, accuracy, last_updated
         FROM student_performance
         WHERE student_id = $1
         ORDER BY accuracy ASC`,
        [req.student.id]
      ),
      db.query(
        "SELECT COUNT(*) as total_wrong FROM wrong_answers WHERE student_id = $1",
        [req.student.id]
      ),
      db.query(
        `SELECT COUNT(*) as total_exams, AVG(percentage) as avg_score, MAX(percentage) as best_score
         FROM exam_sessions WHERE student_id = $1`,
        [req.student.id]
      ),
      // National average accuracy per subject (across all students with >=5 attempts)
      db.query(
        `SELECT subject, ROUND(AVG(accuracy),1) AS national_avg, COUNT(*) AS sample_size
         FROM student_performance
         WHERE total_attempted >= 5
         GROUP BY subject`
      ),
      // NEW: Score trajectory — last 20 exams for line chart
      db.query(
        `SELECT date_trunc('day', created_at) AS day,
                ROUND(AVG(percentage)::numeric, 1) AS avg_score,
                COUNT(*) AS exams_count
         FROM exam_sessions
         WHERE student_id = $1 AND created_at > NOW() - INTERVAL '60 days'
         GROUP BY date_trunc('day', created_at)
         ORDER BY day ASC
         LIMIT 30`,
        [req.student.id]
      ),
    ]);

    const nationalMap = {};
    national.rows.forEach(r => { nationalMap[r.subject] = { national_avg: parseFloat(r.national_avg), sample_size: parseInt(r.sample_size) }; });

    const subjectsWithPercentile = perf.rows.map(s2 => {
      const nat = nationalMap[s2.subject];
      const diff = nat ? Math.round((s2.accuracy - nat.national_avg) * 10) / 10 : null;
      return {
        ...s2,
        national_avg: nat ? nat.national_avg : null,
        vs_national: diff, // positive = above average
      };
    });

    res.json({
      subjects:            subjectsWithPercentile,
      weak_subjects:       subjectsWithPercentile.filter(s => s.accuracy < 50),
      strong_subjects:     subjectsWithPercentile.filter(s => s.accuracy >= 70),
      stats:               sessions.rows[0],
      total_wrong_answers: parseInt(wrong.rows[0].total_wrong),
      // NEW: score trajectory for chart — was missing from the response entirely
      score_history: history.rows.map(r => ({
        day:    r.day.toISOString().split("T")[0],
        score:  parseFloat(r.avg_score),
        exams:  parseInt(r.exams_count),
      })),
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── WRONG ANSWERS ─────────────────────────────────────────
exports.getWrongAnswers = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT q.id, q.subject, q.topic, q.question,
              q.option_a, q.option_b, q.option_c, q.option_d,
              q.correct_answer, q.explanation,
              wa.times_wrong, wa.last_wrong_at
       FROM wrong_answers wa
       JOIN questions q ON q.id = wa.question_id
       WHERE wa.student_id = $1
       ORDER BY wa.times_wrong DESC
       LIMIT 100`,
      [req.student.id]
    );
    res.json(result.rows);
  } catch (err) {
    serverError(res, err);
  }
};

// ── LEADERBOARD ───────────────────────────────────────────
// GET /api/exam/leaderboard?period=all&subject=&scope=global|school|friends
exports.getLeaderboard = async (req, res) => {
  const { subject, period = "all", scope = "global" } = req.query;
  const me = req.student.id;

  let dateFilter = "";
  let minAttempts = 3; // all-time: guard against a single lucky exam topping the board
  if (period === "daily")  { dateFilter = "AND es.completed_at >= CURRENT_DATE"; minAttempts = 1; }
  if (period === "weekly") { dateFilter = "AND es.completed_at >= CURRENT_DATE - INTERVAL '7 days'"; minAttempts = 2; }

  // BUG FIX: leaderboard only ever showed everyone globally — the mockup
  // calls for Global / School / Friends tabs, so we scope the underlying
  // student set before ranking rather than just re-sorting the same list.
  const params = [];
  const ph = (val) => { params.push(val); return `$${params.length}`; };

  const subjectFilter = subject ? `AND es.subject = ${ph(subject)}` : "";

  let scopeWhere = "";
  if (scope === "school") {
    scopeWhere = `AND s.school_name IS NOT NULL AND s.school_name = (SELECT school_name FROM students WHERE id = ${ph(me)})`;
  } else if (scope === "friends") {
    const meParam = ph(me);
    scopeWhere = `AND (s.id = ${meParam} OR s.id IN (
        SELECT CASE WHEN f.student_a = ${meParam} THEN f.student_b ELSE f.student_a END
        FROM friends f WHERE ${meParam} IN (f.student_a, f.student_b)
      ))`;
  }

  try {
    const result = await db.query(
      `SELECT s.id, s.full_name, s.avatar_url,
              COUNT(es.id)                AS exams_taken,
              ROUND(AVG(es.percentage),1) AS avg_score,
              MAX(es.percentage)          AS best_score
       FROM students s
       JOIN exam_sessions es ON es.student_id = s.id
       WHERE s.is_banned = false ${dateFilter} ${subjectFilter} ${scopeWhere}
       GROUP BY s.id, s.full_name, s.avatar_url
       HAVING COUNT(es.id) >= ${scope === "friends" ? 1 : minAttempts}
       ORDER BY avg_score DESC
       LIMIT 50`,
      params
    );
    res.json(result.rows.map((r, i) => ({ rank: i + 1, ...r })));
  } catch (err) {
    serverError(res, err);
  }
};

// ── SUBJECTS & INSTITUTIONS ───────────────────────────────
exports.getSubjects = async (req, res) => {
  const { exam_type } = req.query;
  try {
    const result = await db.query(
      "SELECT DISTINCT subject FROM questions WHERE exam_type = $1 ORDER BY subject",
      [exam_type || "JAMB"]
    );
    res.json(result.rows.map(r => r.subject));
  } catch (err) {
    serverError(res, err);
  }
};

exports.getInstitutions = async (req, res) => {
  const { exam_type = "POST-UTME" } = req.query;
  try {
    const result = await db.query(
      `SELECT DISTINCT institution FROM questions
       WHERE exam_type = $1 AND institution IS NOT NULL
       ORDER BY institution`,
      [exam_type]
    );
    res.json(result.rows.map(r => r.institution));
  } catch (err) {
    serverError(res, err);
  }
};

// ── UNIVERSITY SCOREBOARD ──────────────────────────────────
// GET /api/exam/university-leaderboard?institution=UNIPORT&period=all
// Ranks students by their performance on a specific university's exams —
// separate from the global JAMB leaderboard, since a UNIPORT-only student
// shouldn't be buried under thousands of JAMB-only scores.
// Benchmark rule: only students averaging 50%+ across their UNIVERSITY
// attempts qualify for the board — anything under 50% is excluded entirely,
// not just ranked low.
exports.getUniversityLeaderboard = async (req, res) => {
  const { institution, period = "all" } = req.query;
  if (!institution) return res.status(400).json({ error: "institution is required." });

  let dateFilter = "";
  if (period === "daily")  dateFilter = "AND es.completed_at >= CURRENT_DATE";
  if (period === "weekly") dateFilter = "AND es.completed_at >= CURRENT_DATE - INTERVAL '7 days'";

  try {
    const result = await db.query(
      `SELECT s.id, s.full_name, s.avatar_url, s.school_name,
              COUNT(es.id)                 AS exams_taken,
              ROUND(AVG(es.percentage),1)  AS avg_score,
              MAX(es.percentage)           AS best_score
       FROM students s
       JOIN exam_sessions es ON es.student_id = s.id
       WHERE s.is_banned = false
         AND es.exam_type = 'UNIVERSITY'
         AND es.institution = $1
         ${dateFilter}
       GROUP BY s.id, s.full_name, s.avatar_url, s.school_name
       ORDER BY avg_score DESC, exams_taken DESC
       LIMIT 50`,
      [institution]
    );
    res.json(result.rows.map((r, i) => ({ rank: i + 1, ...r })));
  } catch (err) {
    serverError(res, err);
  }
};

// ── SUBJECT WEAKNESS HEATMAP (NEW FEATURE) ────────────────
exports.getWeaknessHeatmap = async (req, res) => {
  try {
    const student_id = req.student.id;

    // Get performance per subject + topic breakdown
    const [subjectPerf, topicPerf, wrongBySubject] = await Promise.all([
      db.query(
        `SELECT subject, total_attempted, total_correct, accuracy
         FROM student_performance WHERE student_id = $1`,
        [student_id]
      ),
      db.query(
        `SELECT q.subject, q.topic, COUNT(*) as times_wrong
         FROM wrong_answers wa
         JOIN questions q ON q.id = wa.question_id
         WHERE wa.student_id = $1 AND q.topic IS NOT NULL
         GROUP BY q.subject, q.topic
         ORDER BY times_wrong DESC`,
        [student_id]
      ),
      db.query(
        `SELECT q.subject, COUNT(*) as wrong_count
         FROM wrong_answers wa
         JOIN questions q ON q.id = wa.question_id
         WHERE wa.student_id = $1
         GROUP BY q.subject`,
        [student_id]
      ),
    ]);

    // Build topic map grouped by subject
    const topicMap = {};
    topicPerf.rows.forEach(r => {
      if (!topicMap[r.subject]) topicMap[r.subject] = [];
      topicMap[r.subject].push({ topic: r.topic, times_wrong: parseInt(r.times_wrong) });
    });

    const wrongMap = {};
    wrongBySubject.rows.forEach(r => { wrongMap[r.subject] = parseInt(r.wrong_count); });

    const heatmap = subjectPerf.rows.map(s => ({
      subject:        s.subject,
      total_attempted:parseInt(s.total_attempted),
      total_correct:  parseInt(s.total_correct),
      accuracy:       parseFloat(s.accuracy),
      wrong_count:    wrongMap[s.subject] || 0,
      strength:       s.accuracy >= 70 ? "strong" : s.accuracy >= 50 ? "medium" : "weak",
      weak_topics:    (topicMap[s.subject] || []).slice(0, 5),
    }));

    res.json({ heatmap, total_subjects: heatmap.length });
  } catch (err) {
    serverError(res, err);
  }
};

// ── STATE LEADERBOARD (NEW FEATURE) ──────────────────────
exports.getStateLeaderboard = async (req, res) => {
  const { state, period = "weekly" } = req.query;

  let dateFilter = "AND es.completed_at >= CURRENT_DATE - INTERVAL '7 days'";
  if (period === "monthly") dateFilter = "AND es.completed_at >= CURRENT_DATE - INTERVAL '30 days'";
  if (period === "all")     dateFilter = "";

  try {
    const result = await db.query(
      `SELECT s.id, s.full_name, s.state_of_origin,
              COUNT(es.id)                AS exams_taken,
              ROUND(AVG(es.percentage),1) AS avg_score,
              MAX(es.percentage)          AS best_score
       FROM students s
       JOIN exam_sessions es ON es.student_id = s.id
       WHERE s.is_banned = false ${dateFilter}
         ${state ? "AND s.state_of_origin = $1" : ""}
       GROUP BY s.id, s.full_name, s.state_of_origin
       HAVING COUNT(es.id) >= 1
       ORDER BY avg_score DESC
       LIMIT 100`,
      state ? [state] : []
    );
    res.json(result.rows.map((r, i) => ({ rank: i + 1, ...r })));
  } catch (err) {
    serverError(res, err);
  }
};

// ── GET SESSION RESULTS — loads full answers with explanations ─
// Enables History page and shared sessions to show explanations even after refresh
exports.getSessionResults = async (req, res) => {
  const { id } = req.params;
  const student_id = req.student.id;
  try {
    const sess = await db.query(
      `SELECT * FROM exam_sessions WHERE id=$1 AND student_id=$2`,
      [id, student_id]
    );
    if (!sess.rows[0]) return res.status(404).json({ error: "Not found" });

    const answers = await db.query(
      `SELECT ea.question_id, ea.selected_answer, ea.correct_answer,
              ea.is_correct, ea.time_spent_seconds, ea.explanation,
              q.question, q.option_a, q.option_b, q.option_c, q.option_d
       FROM exam_answers ea
       JOIN questions q ON q.id = ea.question_id
       WHERE ea.session_id = $1
       ORDER BY ea.id`,
      [id]
    );
    res.json({ session: sess.rows[0], answers: answers.rows });
  } catch (err) {
    serverError(res, err);
  }
};


// ── UNIVERSITY COURSE QUESTION COUNTS ────────────────────
// GET /api/exam/university-course-counts
// Used by UniversityCourses.js to show real question counts per course
exports.getUniversityCounts = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT institution, subject, COUNT(*) AS count
       FROM questions
       WHERE exam_type = 'UNIVERSITY'
       GROUP BY institution, subject`
    );
    const counts = {};
    r.rows.forEach(row => {
      const key = `${row.institution}_${row.subject}`;
      counts[key] = parseInt(row.count);
    });
    res.json({ counts });
  } catch (err) {
    serverError(res, err);
  }
};
