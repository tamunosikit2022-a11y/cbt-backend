/**
 * aiQuestionController.js — Scholars Syndicate
 * Generates novel JAMB-style practice questions via Groq.
 * Questions are cached in ai_generated_questions table to avoid
 * re-generating the same topic repeatedly.
 */

const db = require('../config/db');
const { chatCompletion } = require('../utils/aiProvider');
const { serverError } = require('../utils/errors');

const JAMB_SUBJECTS = [
  'Mathematics','English Language','Physics','Chemistry','Biology',
  'Economics','Government','Literature in English','Geography',
  'Commerce','Accounting','History',
];

// ── GENERATE QUESTIONS ────────────────────────────────────
exports.generateQuestions = async (req, res) => {
  const { subject, topic, difficulty = 'medium', count = 5 } = req.body;
  const student_id = req.student.id;

  if (!subject) return res.status(400).json({ error: 'subject required' });
  if (!JAMB_SUBJECTS.includes(subject))
    return res.status(400).json({ error: `Invalid subject. Choose from: ${JAMB_SUBJECTS.join(', ')}` });

  const safeCount = Math.min(Math.max(parseInt(count) || 5, 1), 10);

  try {
    // Check cache first (same subject+topic combo generated in last 24h)
    const cacheRes = await db.query(`
      SELECT id, questions_json FROM ai_generated_questions
      WHERE subject=$1 AND (topic=$2 OR ($2 IS NULL AND topic IS NULL))
        AND difficulty=$3 AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC LIMIT 1
    `, [subject, topic || null, difficulty]);

    let questions, batchId;
    if (cacheRes.rows.length) {
      questions = cacheRes.rows[0].questions_json;
      batchId   = cacheRes.rows[0].id;
    } else {
      // Generate with Groq
      const topicLine = topic ? `on the topic of "${topic}"` : '';
      const prompt = `You are a JAMB UTME examiner. Generate exactly ${safeCount} original multiple-choice questions for ${subject} ${topicLine} at ${difficulty} difficulty, suitable for Nigerian secondary school students preparing for JAMB UTME.

Return ONLY a valid JSON array. No explanation, no markdown. Each element must have exactly these fields:
- "question": string (the question text)
- "option_a": string
- "option_b": string  
- "option_c": string
- "option_d": string
- "correct_answer": "A" | "B" | "C" | "D"
- "explanation": string (1-2 sentences explaining why the answer is correct)
- "topic": string (specific topic within ${subject})
- "difficulty": "${difficulty}"

The questions must be original (not copied from existing past questions), factually correct, and test genuine understanding.

Before finalizing each question, re-derive the answer yourself from first principles (redo any calculation, re-check any fact) and confirm it matches "correct_answer" — do not just assert an answer without checking it. If you find your first instinct was wrong, fix "correct_answer" accordingly.`;

      const { content: raw, provider } = await chatCompletion({
        messages:    [{ role: 'user', content: prompt }],
        model:       'openai/gpt-oss-120b',
        maxTokens:   2000,
        // FIX: 0.7 was too high for a task that needs factual/computational
        // accuracy (Math/Physics/Chemistry answer keys) — lower temperature
        // trades a little variety for meaningfully fewer wrong answer keys.
        temperature: 0.4,
      });
      if (provider === 'gemini') {
        console.log(`[aiQuestion] subject=${subject} answered by Gemini fallback (Groq was unavailable).`);
      }

      // Strip any markdown fences
      const clean = (raw || '[]').replace(/```json|```/g, '').trim();

      try {
        questions = JSON.parse(clean);
      } catch {
        // The model sometimes adds stray preamble/explanation text around the
        // JSON array — try to pull just the array out before giving up.
        const match = clean.match(/\[[\s\S]*\]/);
        if (!match) throw new Error('AI returned invalid JSON. Please try again.');
        questions = JSON.parse(match[0]);
      }

      if (!Array.isArray(questions)) throw new Error('AI did not return an array');

      // Validate structure
      questions = questions.filter(q =>
        q.question && q.option_a && q.option_b && q.option_c && q.option_d &&
        ['A','B','C','D'].includes(q.correct_answer) && q.explanation
      ).slice(0, safeCount);

      // Cache result
      const insertRes = await db.query(`
        INSERT INTO ai_generated_questions (subject, topic, difficulty, questions_json, created_by)
        VALUES ($1,$2,$3,$4,$5) RETURNING id
      `, [subject, topic || null, difficulty, JSON.stringify(questions), student_id]);
      batchId = insertRes.rows[0].id;
    }

    // Return without exposing correct_answer or explanation — the client
    // gets those only via /reveal (one question) or /grade (after submit),
    // both of which look them up server-side from batchId. Nothing about
    // the answer key ever reaches the browser at generation time.
    const sanitized = questions.map(({ correct_answer, explanation, ...q }) => ({
      ...q,
      _ai_generated: true,
      subject,
    }));

    res.json({ questions: sanitized, batch_id: batchId, cached: !!cacheRes.rows.length });
  } catch (err) {
    console.error('generateQuestions error:', err.message);
    if (err.message.includes('JSON')) {
      return res.status(502).json({ error: 'AI returned invalid response. Please try again.' });
    }
    serverError(res, err);
  }
};

// ── Shared helper: load a batch's questions (with answers) by id ─────────
async function loadBatch(batchId) {
  const r = await db.query(
    `SELECT questions_json FROM ai_generated_questions WHERE id=$1`,
    [batchId]
  );
  if (!r.rows.length) return null;
  return r.rows[0].questions_json;
}

// ── REVEAL ONE ANSWER (student clicked "Show Answer" pre-submit) ────────
exports.revealAnswer = async (req, res) => {
  const { batch_id, index } = req.body;
  const idx = parseInt(index);

  if (!batch_id || Number.isNaN(idx)) {
    return res.status(400).json({ error: 'batch_id and index are required.' });
  }

  try {
    const questions = await loadBatch(batch_id);
    if (!questions) return res.status(404).json({ error: 'Question batch not found.' });
    const q = questions[idx];
    if (!q) return res.status(404).json({ error: 'Question not found in batch.' });

    res.json({ correct_answer: q.correct_answer, explanation: q.explanation || null });
  } catch (err) {
    console.error('revealAnswer error:', err.message);
    serverError(res, err);
  }
};

// ── GRADE (student submitted all answers) ────────────────────────────────
exports.gradeAnswers = async (req, res) => {
  const { batch_id, answers } = req.body; // answers: { "0": "A", "1": "C", ... }

  if (!batch_id || !answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'batch_id and answers are required.' });
  }

  try {
    const questions = await loadBatch(batch_id);
    if (!questions) return res.status(404).json({ error: 'Question batch not found.' });

    let score = 0;
    const results = questions.map((q, i) => {
      const selected   = answers[i] ?? answers[String(i)] ?? null;
      const is_correct = (selected || "").toUpperCase() === (q.correct_answer || "").toUpperCase();
      if (is_correct) score++;
      return {
        index:          i,
        selected_answer: selected,
        correct_answer:  q.correct_answer,
        explanation:     q.explanation || null,
        is_correct,
      };
    });

    const total      = questions.length;
    const percentage = total > 0 ? Math.round((score / total) * 100) : 0;

    res.json({ results, score, total, percentage });
  } catch (err) {
    console.error('gradeAnswers error:', err.message);
    serverError(res, err);
  }
};

// ── GET AVAILABLE SUBJECTS ────────────────────────────────
exports.getSubjects = async (_req, res) => {
  res.json({ subjects: JAMB_SUBJECTS });
};
