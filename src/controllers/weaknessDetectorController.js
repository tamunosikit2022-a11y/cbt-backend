/**
 * AI WEAKNESS DETECTOR — Enhanced Standalone
 * ─────────────────────────────────────────────────────────
 * From the Innovation Doc:
 *   "AI Weakness Detector — identifies weak topics"
 *
 * Features:
 *   1. Scans all exam history for each student
 *   2. Groups by subject + topic, computes accuracy per topic
 *   3. Identifies "Red Zone" topics (< 50% accuracy)
 *   4. Identifies "Danger Zone" topics (50–69%)
 *   5. Uses GROQ to generate a personalized improvement plan
 *   6. Suggests PDFs, flashcards, and practice questions per weak topic
 *   7. Tracks progress over time (did they improve after study?)
 *   8. Weekly digest report
 */

const db   = require('../config/db');
const { chatCompletion } = require('../utils/aiProvider');
const { serverError } = require('../utils/errors');

// NOTE: 'llama-3.1-70b-versatile' was decommissioned by Groq — calls using it
// fail with a "model_decommissioned" error. Use the current supported model.
const MODEL = 'openai/gpt-oss-120b';

// ── WEAKNESS ANALYSIS ─────────────────────────────────────

async function analyseWeaknesses(studentId) {
  // Pull all exam answers for this student
  const { rows: answers } = await db.query(`
    SELECT
      q.subject,
      COALESCE(q.topic, 'General')        AS topic,
      COUNT(*)::int                        AS total,
      SUM(CASE WHEN ea.is_correct THEN 1 ELSE 0 END)::int AS correct,
      ROUND(
        SUM(CASE WHEN ea.is_correct THEN 1 ELSE 0 END)::numeric
        / NULLIF(COUNT(*),0) * 100, 1
      )                                    AS accuracy,
      MAX(ea.created_at)                  AS last_seen
    FROM exam_answers ea
    JOIN exam_sessions es ON es.id = ea.session_id
    JOIN questions q ON q.id = ea.question_id
    WHERE es.student_id = $1
    GROUP BY q.subject, q.topic
    HAVING COUNT(*) >= 3
    ORDER BY accuracy ASC, total DESC
  `, [studentId]).catch(() => ({ rows: [] }));

  const weakTopics     = answers.filter(a => parseFloat(a.accuracy) < 50);
  const dangerTopics   = answers.filter(a => parseFloat(a.accuracy) >= 50 && parseFloat(a.accuracy) < 70);
  const strongTopics   = answers.filter(a => parseFloat(a.accuracy) >= 85);

  // Per-subject summary
  const subjectMap = {};
  for (const a of answers) {
    if (!subjectMap[a.subject]) {
      subjectMap[a.subject] = { total: 0, correct: 0, topics: [] };
    }
    subjectMap[a.subject].total   += a.total;
    subjectMap[a.subject].correct += a.correct;
    subjectMap[a.subject].topics.push(a);
  }

  const subjectSummary = Object.entries(subjectMap).map(([subject, data]) => ({
    subject,
    total:    data.total,
    correct:  data.correct,
    accuracy: data.total ? Math.round((data.correct / data.total) * 100) : 0,
    weakCount:   data.topics.filter(t => parseFloat(t.accuracy) < 50).length,
    dangerCount: data.topics.filter(t => parseFloat(t.accuracy) >= 50 && parseFloat(t.accuracy) < 70).length,
  })).sort((a, b) => a.accuracy - b.accuracy);

  return { weakTopics, dangerTopics, strongTopics, subjectSummary, allTopics: answers };
}

// ── AI IMPROVEMENT PLAN ───────────────────────────────────

async function generateImprovementPlan(studentId, weakTopics, dangerTopics, studentName) {
  if (!weakTopics.length && !dangerTopics.length) {
    return 'Great work! No major weaknesses detected. Keep maintaining your strong performance across all subjects.';
  }

  const topicsText = [
    ...weakTopics.map(t => `❌ ${t.subject} → ${t.topic}: ${t.accuracy}% accuracy (${t.total} questions)`),
    ...dangerTopics.map(t => `⚠️  ${t.subject} → ${t.topic}: ${t.accuracy}% accuracy (${t.total} questions)`),
  ].slice(0, 15).join('\n');

  const prompt = `You are an expert Nigerian secondary school academic coach.

Student: ${studentName}

Their WEAK areas (below 50% accuracy):
${weakTopics.map(t => `- ${t.subject}: ${t.topic} (${t.accuracy}%)`).join('\n') || 'None'}

Their DANGER areas (50-69% accuracy):
${dangerTopics.map(t => `- ${t.subject}: ${t.topic} (${t.accuracy}%)`).join('\n') || 'None'}

Generate a clear, encouraging, and actionable improvement plan:
1. Address the WORST 3 topics first with specific study strategies
2. Suggest daily practice routines (minutes per topic)
3. Mention common mistakes Nigerian students make in these topics
4. Give 2-3 specific tips per subject area
5. Set a realistic 2-week target for improvement

Keep it under 400 words. Be direct, motivating, and specific to Nigerian curriculum (WAEC/NECO/JAMB focus).`;

  const { content } = await chatCompletion({
    model:       MODEL,
    messages:    [{ role: 'user', content: prompt }],
    maxTokens:   800,
    temperature: 0.5,
    taskType:    "explain", // personalized study-plan writing — prefer Gemini first
  });

  return content.trim();
}

// ── RESOURCE SUGGESTIONS ──────────────────────────────────

async function getSuggestedResources(weakTopics) {
  if (!weakTopics.length) return { pdfs: [], flashcards: [], questions: [] };

  const subjects = [...new Set(weakTopics.map(t => t.subject))];

  const [pdfs, flashcards, questions] = await Promise.all([
    db.query(
      `SELECT id, title, subject, description FROM knowledge_vault_pdfs
       WHERE subject = ANY($1) AND is_active=true
       ORDER BY downloads DESC LIMIT 6`,
      [subjects]
    ).catch(() => ({ rows: [] })),

    db.query(
      `SELECT fc.id, fc.front, fc.back, fc.subject, fc.topic
       FROM flashcards fc
       WHERE fc.subject = ANY($1)
         AND fc.topic = ANY($2)
       LIMIT 10`,
      [subjects, weakTopics.map(t => t.topic)]
    ).catch(() => ({ rows: [] })),

    db.query(
      `SELECT id, question, subject, topic
       FROM questions
       WHERE subject = ANY($1)
         AND topic = ANY($2)
         AND is_active=true
       ORDER BY RANDOM() LIMIT 15`,
      [subjects, weakTopics.map(t => t.topic)]
    ).catch(() => ({ rows: [] })),
  ]);

  return { pdfs: pdfs.rows, flashcards: flashcards.rows, questions: questions.rows };
}

// ── PROGRESS TRACKING ──────────────────────────────────────

async function trackWeaknessProgress(studentId) {
  // Compare current accuracy vs accuracy 7 days ago per topic
  const [current, previous] = await Promise.all([
    db.query(`
      SELECT q.subject, COALESCE(q.topic,'General') as topic,
             ROUND(AVG(CASE WHEN ea.is_correct THEN 100.0 ELSE 0 END), 1) as accuracy
      FROM exam_answers ea
      JOIN exam_sessions es ON es.id = ea.session_id
      JOIN questions q ON q.id=ea.question_id
      WHERE es.student_id=$1 AND ea.created_at > NOW() - INTERVAL '7 days'
      GROUP BY q.subject, q.topic
    `, [studentId]).catch(() => ({ rows: [] })),

    db.query(`
      SELECT q.subject, COALESCE(q.topic,'General') as topic,
             ROUND(AVG(CASE WHEN ea.is_correct THEN 100.0 ELSE 0 END), 1) as accuracy
      FROM exam_answers ea
      JOIN exam_sessions es ON es.id = ea.session_id
      JOIN questions q ON q.id=ea.question_id
      WHERE es.student_id=$1
        AND ea.created_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
      GROUP BY q.subject, q.topic
    `, [studentId]).catch(() => ({ rows: [] })),
  ]);

  const prevMap = Object.fromEntries(
    previous.rows.map(r => [`${r.subject}:${r.topic}`, parseFloat(r.accuracy)])
  );

  return current.rows.map(r => {
    const key   = `${r.subject}:${r.topic}`;
    const prev  = prevMap[key];
    const delta = prev !== undefined ? parseFloat(r.accuracy) - prev : null;
    return {
      subject:   r.subject,
      topic:     r.topic,
      accuracy:  parseFloat(r.accuracy),
      prevAccuracy: prev || null,
      delta,
      trend:     delta === null ? 'new' : delta > 5 ? 'improving' : delta < -5 ? 'declining' : 'stable',
    };
  }).sort((a, b) => (a.accuracy || 0) - (b.accuracy || 0));
}

// ── REST ENDPOINTS ────────────────────────────────────────

// GET /api/weakness-detector
exports.getWeaknessReport = async (req, res) => {
  try {
    const sid  = req.student.id;
    const name = req.student.full_name || 'Scholar';

    const { weakTopics, dangerTopics, strongTopics, subjectSummary, allTopics } =
      await analyseWeaknesses(sid);

    if (!allTopics.length) {
      return res.json({
        hasData:    false,
        message:    'Complete at least 3 exam questions per topic to generate your weakness report.',
        weakTopics:  [],
        dangerTopics: [],
        strongTopics: [],
        subjectSummary: [],
        plan:        null,
        resources:   null,
      });
    }

    const [plan, resources] = await Promise.all([
      generateImprovementPlan(sid, weakTopics, dangerTopics, name),
      getSuggestedResources(weakTopics),
    ]);

    // Cache in DB for quick re-access
    await db.query(
      `INSERT INTO weakness_reports (student_id, report_json, generated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (student_id) DO UPDATE SET report_json=$2, generated_at=NOW()`,
      [sid, JSON.stringify({ weakTopics, dangerTopics, strongTopics, subjectSummary, plan })]
    ).catch(() => {});

    res.json({
      hasData:       true,
      weakTopics:    weakTopics.map(t => ({ ...t, zone: 'red',    icon: '❌' })),
      dangerTopics:  dangerTopics.map(t => ({ ...t, zone: 'orange', icon: '⚠️' })),
      strongTopics:  strongTopics.map(t => ({ ...t, zone: 'green', icon: '✅' })),
      subjectSummary,
      plan,
      resources,
    });
  } catch (err) {
    console.error('getWeaknessReport error:', err.message);
    serverError(res, err);
  }
};

// GET /api/weakness-detector/progress
exports.getWeaknessProgress = async (req, res) => {
  try {
    const sid      = req.student.id;
    const progress = await trackWeaknessProgress(sid);
    res.json({ progress });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/weakness-detector/weekly-digest  (cron or manual call)
exports.getWeeklyDigest = async (req, res) => {
  try {
    const sid  = req.student.id;
    const name = req.student.full_name || 'Scholar';

    const { weakTopics, dangerTopics, subjectSummary } = await analyseWeaknesses(sid);
    const progress = await trackWeaknessProgress(sid);

    const improving = progress.filter(p => p.trend === 'improving');
    const declining  = progress.filter(p => p.trend === 'declining');

    const digest = {
      week:          new Date().toLocaleDateString('en-NG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      studentName:   name,
      redZoneCount:  weakTopics.length,
      dangerCount:   dangerTopics.length,
      improvingCount:improving.length,
      decliningCount:declining.length,
      topImproving:  improving.slice(0, 3),
      topDeclining:  declining.slice(0, 3),
      worstSubject:  subjectSummary[0] || null,
      bestSubject:   subjectSummary[subjectSummary.length - 1] || null,
      message:       improving.length > declining.length
        ? `Great week, ${name.split(' ')[0]}! You improved in ${improving.length} topic(s). Keep it up!`
        : `${name.split(' ')[0]}, you need to focus this week. ${declining.length} topic(s) declined.`,
    };

    res.json({ digest });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/weakness-detector/practice-session
// Creates a targeted practice session from weak topics
exports.startPracticeSession = async (req, res) => {
  try {
    const sid         = req.student.id;
    const { subject, topic, count = 10 } = req.body;

    const { rows: questions } = await db.query(
      `SELECT id,question,option_a,option_b,option_c,option_d,correct_answer,explanation,topic
       FROM questions
       WHERE subject=$1
         AND ($2::text IS NULL OR topic=$2)
         AND is_active=true
       ORDER BY RANDOM() LIMIT $3`,
      [subject, topic || null, count]
    ).catch(() => ({ rows: [] }));

    if (!questions.length) {
      return res.status(404).json({ error: 'No questions found for this topic.' });
    }

    // Log that a practice session was started
    await db.query(
      `INSERT INTO weakness_practice_sessions (student_id, subject, topic, question_count, started_at)
       VALUES ($1,$2,$3,$4,NOW())`,
      [sid, subject, topic, questions.length]
    ).catch(() => {});

    res.json({ questions, subject, topic, total: questions.length });
  } catch (err) {
    serverError(res, err);
  }
};

module.exports = {
  getWeaknessReport:      exports.getWeaknessReport,
  getWeaknessProgress:    exports.getWeaknessProgress,
  getWeeklyDigest:        exports.getWeeklyDigest,
  startPracticeSession:   exports.startPracticeSession,
  analyseWeaknesses,
  generateImprovementPlan,
};
