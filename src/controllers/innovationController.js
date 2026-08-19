const db = require("../config/db");
const { serverError } = require('../utils/errors');

exports.getTodayChallenge = async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  try {
    let challengeRow = await db.query(`SELECT * FROM daily_challenges WHERE date = $1`, [today]);
    if (!challengeRow.rows.length) {
      const subjects = ["Mathematics","English Language","Biology","Chemistry","Physics","Economics","Government"];
      const subject  = subjects[new Date().getDay() % subjects.length];
      const qs = await db.query(
        `SELECT id FROM questions WHERE exam_type = 'JAMB' AND subject = $1 ORDER BY RANDOM() LIMIT 10`,
        [subject]
      );
      const fallbackQs = qs.rows.length ? qs.rows :
        (await db.query(`SELECT id FROM questions WHERE exam_type = 'JAMB' ORDER BY RANDOM() LIMIT 10`)).rows;
      if (!fallbackQs.length) return res.status(404).json({ error: "No questions available." });
      const qIds = fallbackQs.map(r => r.id);
      await db.query(
        `INSERT INTO daily_challenges (date, subject, question_ids, total_q) VALUES ($1,$2,$3,$4) ON CONFLICT (date) DO NOTHING`,
        [today, subject, qIds, qIds.length]
      );
      challengeRow = await db.query(`SELECT * FROM daily_challenges WHERE date = $1`, [today]);
    }
    const challenge = challengeRow.rows[0];
    const attempt = await db.query(
      `SELECT score, total, percentage, completed_at FROM challenge_attempts WHERE student_id = $1 AND challenge_id = $2`,
      [req.student.id, challenge.id]
    );
    if (attempt.rows.length) {
      return res.json({ challenge: { ...challenge, ...attempt.rows[0] }, already_done: true, questions: null });
    }
    const qResult = await db.query(
      `SELECT id, subject, question, option_a, option_b, option_c, option_d, difficulty FROM questions WHERE id = ANY($1::int[])`,
      [challenge.question_ids]
    );
    res.json({ challenge, already_done: false, questions: qResult.rows });
  } catch (err) {
    console.error("Daily challenge error:", err.message);
    serverError(res, err);
  }
};

exports.submitChallenge = async (req, res) => {
  const { challenge_id, answers } = req.body;
  const student_id = req.student.id;
  try {
    const existing = await db.query(
      "SELECT id FROM challenge_attempts WHERE student_id = $1 AND challenge_id = $2",
      [student_id, challenge_id]
    );
    if (existing.rows.length) return res.status(400).json({ error: "Already completed today's challenge." });
    const ch = await db.query("SELECT * FROM daily_challenges WHERE id = $1", [challenge_id]);
    if (!ch.rows.length) return res.status(404).json({ error: "Challenge not found." });
    const qResult = await db.query(
      "SELECT id, correct_answer, explanation FROM questions WHERE id = ANY($1::int[])",
      [ch.rows[0].question_ids]
    );
    const correctMap = {};
    qResult.rows.forEach(q => { correctMap[q.id] = q; });
    let score = 0;
    const processed = (answers || []).map(a => {
      const q = correctMap[a.question_id];
      if (!q) return null;
      const is_correct = q.correct_answer.toUpperCase() === (a.selected_answer || "").toUpperCase();
      if (is_correct) score++;
      return { 
        question_id: a.question_id, 
        selected_answer: a.selected_answer, 
        correct_answer: q.correct_answer, 
        explanation: q.explanation || null, 
        is_correct 
      };
    }).filter(Boolean);
    const total = processed.length;
    const percentage = total > 0 ? parseFloat(((score / total) * 100).toFixed(1)) : 0;
    await db.query(
      `INSERT INTO challenge_attempts (student_id, challenge_id, score, total, percentage) VALUES ($1,$2,$3,$4,$5)`,
      [student_id, challenge_id, score, total, percentage]
    );
    // Award XP and coins for daily challenge
    const xpEarned    = 15 + Math.floor(percentage / 10) * 2;
    const coinsEarned = 20; // flat bonus for completing daily challenge
    await db.query(
      `UPDATE students SET points = COALESCE(points,0) + $1,
                           coins  = COALESCE(coins,0)  + $2 WHERE id = $3`,
      [xpEarned, coinsEarned, student_id]
    );
    await checkAndAwardBadges(student_id);

    // Update mission progress — daily challenge counts as exam activity
    const { updateMissionProgress } = require("./missionsController");
    updateMissionProgress(student_id, "exam_complete").catch(() => {});
    updateMissionProgress(student_id, "daily_challenge").catch(() => {});
    if (percentage >= 70) updateMissionProgress(student_id, "score_70").catch(() => {});

    res.json({ score, total, percentage, answers: processed, xp_earned: xpEarned, coins_earned: coinsEarned });
  } catch (err) {
    console.error("Submit challenge error:", err.message);
    serverError(res, err);
  }
};

exports.getChallengeHistory = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT dc.date, dc.subject, ca.score, ca.total, ca.percentage, ca.completed_at
       FROM challenge_attempts ca JOIN daily_challenges dc ON dc.id = ca.challenge_id
       WHERE ca.student_id = $1 ORDER BY dc.date DESC LIMIT 30`,
      [req.student.id]
    );
    res.json(result.rows);
  } catch (err) { 
    serverError(res, err); 
  }
};

// FIX: this used to be inline logic duplicated (with a *different*, less
// accurate formula) inside parentController.js — so a parent viewing their
// child's report could see a different predicted JAMB score than the
// student saw on their own /predicted page for the exact same performance.
// Pulled out into one shared function so there is a single source of truth;
// both the student-facing route below and parentController now call this.
async function computePredictedScore(student_id) {
  const perf = await db.query(
    `SELECT sp.subject, sp.accuracy, sp.total_attempted, COUNT(es.id) AS exam_count, AVG(es.percentage) AS recent_avg
     FROM student_performance sp
     LEFT JOIN exam_sessions es ON es.student_id = sp.student_id AND es.subject = sp.subject AND es.completed_at >= NOW() - INTERVAL '7 days'
     WHERE sp.student_id = $1 GROUP BY sp.subject, sp.accuracy, sp.total_attempted`,
    [student_id]
  );
  const JAMB_SUBJECTS = ["English Language","Mathematics","Biology","Chemistry","Physics","Economics","Government","Geography","Literature in English","Commerce","Accounting","Agricultural Science"];
  let subjectCount = 0;
  const breakdown = [], improvements = [];
  perf.rows.forEach(p => {
    if (!JAMB_SUBJECTS.includes(p.subject)) return;
    const recentAvg = parseFloat(p.recent_avg) || parseFloat(p.accuracy);
    const predicted = Math.min(100, Math.round(parseFloat(p.accuracy) * 0.6 + recentAvg * 0.4));
    breakdown.push({
      subject: p.subject,
      predicted,
      accuracy: parseFloat(p.accuracy),
      attempts: parseInt(p.total_attempted),
      trend: recentAvg > parseFloat(p.accuracy) ? "improving" : recentAvg < parseFloat(p.accuracy) ? "declining" : "stable"
    });
    subjectCount++;
    if (predicted < 60) improvements.push({ subject: p.subject, current: predicted, needed: 60 - predicted });
  });
  const sorted = breakdown.sort((a, b) => b.predicted - a.predicted);
  const english = sorted.find(s => s.subject === "English Language");
  const others  = sorted.filter(s => s.subject !== "English Language").slice(0, 3);
  const top4    = english ? [english, ...others] : sorted.slice(0, 4);
  const jambScore = top4.reduce((sum, s) => sum + s.predicted, 0);
  return {
    predicted_jamb_score: jambScore,
    max_score: 400,
    confidence: subjectCount >= 4 ? "High" : subjectCount >= 2 ? "Medium" : "Low",
    breakdown: sorted,
    top_4_subjects: top4,
    improvement_areas: improvements.slice(0, 3),
    advice: jambScore >= 300 ? "You're on track! Keep your current pace." :
            jambScore >= 250 ? "Good progress. Focus on weak subjects." :
            jambScore >= 200 ? "More practice needed. Aim for 10 exams per week." :
            "Intensive revision needed. Study topic by topic.",
  };
}
exports.computePredictedScore = computePredictedScore;

exports.getPredictedScore = async (req, res) => {
  const student_id = req.student.id;
  try {
    const data = await computePredictedScore(student_id);
    res.json(data);
  } catch (err) { 
    serverError(res, err); 
  }
};

// FIXED BUG 3: saveDraft without relying on unique index
exports.saveDraft = async (req, res) => {
  const { exam_type, subject, institution, mode, question_ids, answers, time_remaining_secs, total_time_secs } = req.body;
  
  // Validation
  if (!subject || !mode) {
    return res.status(400).json({ error: "Subject and mode are required." });
  }
  
  try {
    // Check if draft exists first (safer than ON CONFLICT)
    const existing = await db.query(
      `SELECT id FROM exam_drafts WHERE student_id = $1 AND subject = $2 AND mode = $3`,
      [req.student.id, subject, mode]
    );
    
    if (existing.rows.length) {
      // Update existing draft
      await db.query(
        `UPDATE exam_drafts 
         SET exam_type = $1, 
             institution = $2, 
             question_ids = $3, 
             answers = $4, 
             time_remaining_secs = $5, 
             total_time_secs = $6, 
             updated_at = NOW()
         WHERE id = $7`,
        [
          exam_type, 
          institution || null, 
          question_ids, 
          JSON.stringify(answers || {}), 
          time_remaining_secs, 
          total_time_secs, 
          existing.rows[0].id
        ]
      );
    } else {
      // Insert new draft
      await db.query(
        `INSERT INTO exam_drafts (
           student_id, exam_type, subject, institution, mode, 
           question_ids, answers, time_remaining_secs, total_time_secs, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [
          req.student.id, 
          exam_type, 
          subject, 
          institution || null, 
          mode, 
          question_ids, 
          JSON.stringify(answers || {}), 
          time_remaining_secs, 
          total_time_secs
        ]
      );
    }
    
    res.json({ success: true, message: "Draft saved successfully." });
  } catch (err) { 
    console.error("Save draft error:", err.message);
    res.status(500).json({ error: "Failed to save draft. Please try again." }); 
  }
};

// FIXED BUG 4: getDrafts with proper null filtering
exports.getDrafts = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, exam_type, subject, institution, mode, 
              array_length(question_ids,1) AS total_questions,
              (SELECT COUNT(*) FROM jsonb_each_text(COALESCE(answers, '{}'::jsonb)) 
               WHERE value IS NOT NULL AND value != '') AS answered_count, 
              time_remaining_secs, total_time_secs, updated_at
       FROM exam_drafts 
       WHERE student_id = $1 
       ORDER BY updated_at DESC`,
      [req.student.id]
    );
    res.json(result.rows);
  } catch (err) { 
    console.error("Get drafts error:", err.message);
    serverError(res, err); 
  }
};

exports.loadDraft = async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM exam_drafts WHERE id = $1 AND student_id = $2", 
      [req.params.draft_id, req.student.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Draft not found." });
    const draft = result.rows[0];
    const qs = await db.query(
      "SELECT id, subject, topic, year, question, option_a, option_b, option_c, option_d, difficulty FROM questions WHERE id = ANY($1::int[])", 
      [draft.question_ids]
    );
    const qMap = {};
    qs.rows.forEach(q => { qMap[q.id] = q; });
    res.json({ 
      draft, 
      questions: draft.question_ids.map(id => qMap[id]).filter(Boolean) 
    });
  } catch (err) { 
    serverError(res, err); 
  }
};

exports.deleteDraft = async (req, res) => {
  try {
    await db.query(
      "DELETE FROM exam_drafts WHERE id = $1 AND student_id = $2", 
      [req.params.draft_id, req.student.id]
    );
    res.json({ success: true });
  } catch (err) { 
    serverError(res, err); 
  }
};

exports.getMyBadges = async (req, res) => {
  try {
    // FIX: badges catalogue is in-memory (badgesController); only query student_badges with correct column badge_id
    const { rows } = await db.query(
      `SELECT badge_id, unlocked_at FROM student_badges WHERE student_id = $1 ORDER BY unlocked_at DESC`,
      [req.student.id]
    );
    res.json({ earned: rows, count: rows.length });
  } catch (err) { 
    serverError(res, err); 
  }
};

async function checkAndAwardBadges(student_id) {
  try {
    const [exams, streak, arenaW, challenges, subjects] = await Promise.all([
      db.query("SELECT COUNT(*) AS c, MAX(percentage) AS best FROM exam_sessions WHERE student_id = $1", [student_id]),
      db.query("SELECT current_streak FROM streaks WHERE student_id = $1", [student_id]),
      db.query("SELECT wins FROM arena_stats WHERE student_id = $1", [student_id]).catch(() => ({ rows: [] })),
      db.query("SELECT COUNT(*) AS c FROM challenge_attempts WHERE student_id = $1", [student_id]),
      db.query("SELECT COUNT(DISTINCT subject) AS c FROM student_performance WHERE student_id = $1", [student_id]),
    ]);
    const te = parseInt(exams.rows[0]?.c||0), bs = parseFloat(exams.rows[0]?.best||0);
    const cs = parseInt(streak.rows[0]?.current_streak||0), aw = parseInt(arenaW.rows[0]?.wins||0);
    const tc = parseInt(challenges.rows[0]?.c||0), ts = parseInt(subjects.rows[0]?.c||0);
    const toAward = [];
    if(te>=1) toAward.push("first_exam"); 
    if(te>=5) toAward.push("exam_5");
    if(te>=20) toAward.push("exam_20"); 
    if(te>=50) toAward.push("exam_50");
    if(cs>=3) toAward.push("streak_3"); 
    if(cs>=7) toAward.push("streak_7");
    if(cs>=30) toAward.push("streak_30"); 
    if(bs>=70) toAward.push("score_70");
    if(bs>=90) toAward.push("score_90"); 
    if(bs>=100) toAward.push("score_100");
    if(aw>=1) toAward.push("arena_first"); 
    if(aw>=10) toAward.push("arena_10");
    if(tc>=1) toAward.push("challenge_first"); 
    if(tc>=7) toAward.push("challenge_7");
    if(ts>=3) toAward.push("subjects_3");
    
    for(const code of toAward) {
      await db.query(
        "INSERT INTO student_badges (student_id, badge_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", 
        [student_id, code]
      );
    }
    return toAward;
  } catch(err) { 
    console.error("Badge check error:", err.message); 
    return []; 
  }
}

exports.checkAndAwardBadges = checkAndAwardBadges;
exports.checkBadgesAfterExam = async (student_id) => checkAndAwardBadges(student_id);