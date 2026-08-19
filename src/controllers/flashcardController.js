/**
 * flashcardController.js — Scholars Syndicate
 * Full SM-2 Spaced Repetition System (SRS) for JAMB practice.
 * Uses the existing spaced_repetition table + questions table.
 *
 * SM-2 algorithm:
 *   - Quality rating 0–5 supplied by student after each card
 *   - ease_factor updates per review
 *   - interval_days doubles (capped at 365) on correct recall
 *   - Cards with next_review <= TODAY are "due"
 */

const db = require('../config/db');
const { serverError } = require('../utils/errors');

// ── GET DUE CARDS ─────────────────────────────────────────
// Returns up to 20 questions due today for the student.
// If fewer than 5 due, top up with new unseen cards.
exports.getDueCards = async (req, res) => {
  const student_id = req.student.id;
  const subject    = req.query.subject || null;

  try {
    const subjectClause = subject ? `AND q.subject = $2` : '';
    const params        = subject ? [student_id, subject] : [student_id];

    // Due cards (already in SRS queue)
    const dueRes = await db.query(`
      SELECT sr.id AS sr_id, sr.ease_factor, sr.interval_days, sr.repetitions,
             q.id, q.subject, q.topic, q.year, q.question,
             q.option_a, q.option_b, q.option_c, q.option_d,
             q.correct_answer, q.explanation, q.difficulty
      FROM spaced_repetition sr
      JOIN questions q ON q.id = sr.question_id
      WHERE sr.student_id = $1
        AND sr.next_review <= CURRENT_DATE
        ${subjectClause}
      ORDER BY sr.next_review ASC
      LIMIT 20
    `, params);

    let cards = dueRes.rows;

    // Top up with new cards if fewer than 5 due
    if (cards.length < 5) {
      const needed = 10 - cards.length;
      const seen   = cards.map(c => c.id);
      const seenClause = seen.length ? `AND q.id != ALL($${params.length + 1}::int[])` : '';
      const newParams  = seen.length ? [...params, seen] : params;

      const newRes = await db.query(`
        SELECT q.id, q.subject, q.topic, q.year, q.question,
               q.option_a, q.option_b, q.option_c, q.option_d,
               q.correct_answer, q.explanation, q.difficulty,
               NULL::int AS sr_id, 2.5 AS ease_factor,
               1 AS interval_days, 0 AS repetitions
        FROM questions q
        WHERE q.exam_type = 'JAMB'
          AND NOT EXISTS (
            SELECT 1 FROM spaced_repetition sr2
            WHERE sr2.student_id = $1 AND sr2.question_id = q.id
          )
          ${subjectClause}
          ${seenClause}
        ORDER BY RANDOM()
        LIMIT $${newParams.length + 1}
      `, [...newParams, needed]);

      cards = [...cards, ...newRes.rows];
    }

    // Don't expose the answer OR explanation before the student responds —
    // explanations routinely restate/imply the correct option, so shipping
    // them here would let anyone read the answer straight off the Network
    // tab before picking anything. Explanation comes back via submitReview
    // once they've actually answered.
    const sanitized = cards.map(({ correct_answer, explanation, ...rest }) => ({
      ...rest,
      _has_answer: true,
    }));

    res.json({ cards: sanitized, total: cards.length });
  } catch (err) {
    console.error('getDueCards error:', err.message);
    serverError(res, err);
  }
};

// ── SUBMIT REVIEW ─────────────────────────────────────────
// Body: { question_id, quality (0-5), chosen_answer }
// quality: 5=perfect, 4=correct after hesitation, 3=correct hard, 2=incorrect easy, 1=incorrect hard, 0=blackout
exports.submitReview = async (req, res) => {
  const student_id                     = req.student.id;
  const { question_id, quality, chosen_answer } = req.body;

  if (question_id == null || quality == null) {
    return res.status(400).json({ error: 'question_id and quality required' });
  }
  if (quality < 0 || quality > 5) {
    return res.status(400).json({ error: 'quality must be 0–5' });
  }

  try {
    // Get correct answer for verification
    const qRes = await db.query(
      'SELECT correct_answer, explanation, subject, topic FROM questions WHERE id=$1',
      [question_id]
    );
    if (!qRes.rows.length) return res.status(404).json({ error: 'Question not found' });

    const { correct_answer, explanation, subject, topic } = qRes.rows[0];
    const is_correct = (chosen_answer || "").toUpperCase() === (correct_answer || "").toUpperCase();

    // Fetch existing SR record
    const srRes = await db.query(
      'SELECT * FROM spaced_repetition WHERE student_id=$1 AND question_id=$2',
      [student_id, question_id]
    );

    let ease_factor   = 2.5;
    let interval_days = 1;
    let repetitions   = 0;

    if (srRes.rows.length) {
      ({ ease_factor, interval_days, repetitions } = srRes.rows[0]);
    }

    // SM-2 update
    const q = Math.max(0, Math.min(5, quality));
    ease_factor = Math.max(1.3, ease_factor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));

    if (q < 3) {
      // Failed — reset
      repetitions   = 0;
      interval_days = 1;
    } else {
      repetitions += 1;
      if (repetitions === 1)      interval_days = 1;
      else if (repetitions === 2) interval_days = 6;
      else                        interval_days = Math.min(365, Math.round(interval_days * ease_factor));
    }

    const next_review = new Date();
    next_review.setDate(next_review.getDate() + interval_days);

    // Upsert SR record
    await db.query(`
      INSERT INTO spaced_repetition (student_id, question_id, ease_factor, interval_days, repetitions, next_review, last_reviewed)
      VALUES ($1,$2,$3,$4,$5,$6::date, CURRENT_DATE)
      ON CONFLICT (student_id, question_id)
      DO UPDATE SET ease_factor=$3, interval_days=$4, repetitions=$5, next_review=$6::date, last_reviewed=CURRENT_DATE
    `, [student_id, question_id, ease_factor.toFixed(2), interval_days, repetitions,
        next_review.toISOString().split('T')[0]]);

    // Record wrong answer if incorrect
    if (!is_correct && chosen_answer) {
      await db.query(`
        INSERT INTO wrong_answers (student_id, question_id, chosen_answer, times_wrong, last_wrong_at)
        VALUES ($1,$2,$3,1,NOW())
        ON CONFLICT (student_id, question_id)
        DO UPDATE SET times_wrong = wrong_answers.times_wrong + 1,
                      chosen_answer = $3,
                      last_wrong_at = NOW()
      `, [student_id, question_id, chosen_answer]);
    }

    res.json({
      correct_answer,
      explanation,
      is_correct,
      next_review: next_review.toISOString().split('T')[0],
      interval_days,
      ease_factor: parseFloat(ease_factor.toFixed(2)),
      repetitions,
    });
  } catch (err) {
    console.error('submitReview error:', err.message);
    serverError(res, err);
  }
};

// ── GET STATS ─────────────────────────────────────────────
exports.getStats = async (req, res) => {
  const student_id = req.student.id;
  try {
    const statsRes = await db.query(`
      SELECT
        COUNT(*)                                                         AS total_cards,
        COUNT(*) FILTER (WHERE next_review <= CURRENT_DATE)             AS due_today,
        COUNT(*) FILTER (WHERE repetitions >= 3)                        AS mastered,
        COUNT(*) FILTER (WHERE repetitions = 0)                         AS new_cards,
        ROUND(AVG(ease_factor),2)                                       AS avg_ease,
        COUNT(DISTINCT DATE(last_reviewed))
          FILTER (WHERE last_reviewed >= NOW() - INTERVAL '7 days')     AS study_days_this_week
      FROM spaced_repetition
      WHERE student_id = $1
    `, [student_id]);

    const subjectRes = await db.query(`
      SELECT q.subject,
             COUNT(*)                                                    AS cards,
             COUNT(*) FILTER (WHERE sr.next_review <= CURRENT_DATE)     AS due
      FROM spaced_repetition sr
      JOIN questions q ON q.id = sr.question_id
      WHERE sr.student_id = $1
      GROUP BY q.subject
      ORDER BY due DESC, cards DESC
    `, [student_id]);

    res.json({ ...statsRes.rows[0], subjects: subjectRes.rows });
  } catch (err) {
    serverError(res, err);
  }
};

// ── ADD CUSTOM CARD ──────────────────────────────────────
// Enqueue a specific question into the student's SRS deck
exports.addCard = async (req, res) => {
  const student_id  = req.student.id;
  const { question_id } = req.body;
  if (!question_id) return res.status(400).json({ error: 'question_id required' });

  try {
    await db.query(`
      INSERT INTO spaced_repetition (student_id, question_id)
      VALUES ($1,$2)
      ON CONFLICT (student_id, question_id) DO NOTHING
    `, [student_id, question_id]);
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
  }
};
