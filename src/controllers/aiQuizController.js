/**
 * AI QUIZ GENERATOR
 * ─────────────────────────────────────────────────────────
 * Creates exam questions from:
 *   1. PDF uploads (base64 → text extraction → GROQ AI)
 *   2. Video Library (transcript text → GROQ AI)
 *   3. Study session notes (plain text → GROQ AI)
 *
 * Output: structured JSON quiz with multiple-choice questions
 * compatible with the existing questions table schema.
 *
 * Powered by GROQ (Llama 3.1).
 */

const db      = require('../config/db');
const { chatCompletion, getGemini } = require('../utils/aiProvider');
const { serverError } = require('../utils/errors');

const MODEL = 'openai/gpt-oss-120b';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ── PROMPT BUILDER ────────────────────────────────────────

function buildQuizPrompt(content, opts = {}) {
  const {
    subject      = 'General',
    count        = 10,
    difficulty   = 'medium',
    questionTypes = ['mcq'],
  } = opts;

  return `You are an expert Nigerian secondary school educator and JAMB/WAEC exam question writer.

Generate EXACTLY ${count} multiple-choice exam questions based on the provided content.

CRITICAL RULES — follow exactly:
1. Each question has exactly 4 options labeled option_a, option_b, option_c, option_d.
2. Only ONE option is correct. correct_answer must be exactly one letter: A, B, C, or D.
3. Difficulty level: "${difficulty}" for Nigerian senior secondary students.
4. Subject: "${subject}"
5. Do NOT number the questions inside the question text.
6. Do NOT use apostrophes or single quotes in any text — rephrase to avoid them.
7. Do NOT use backslashes or special characters that would break JSON.
8. Return ONLY a raw JSON array — no markdown, no code fences, no preamble, no explanation.
9. Every string must use double quotes. Never use single quotes inside values.
10. Before finalizing each question, re-derive the answer yourself from first principles (redo any calculation, re-check any fact) and confirm it matches correct_answer — do not just assert an answer without checking it. If your first instinct was wrong, fix correct_answer accordingly.

OUTPUT FORMAT (copy this structure exactly, return ONLY the array):
[{"question":"...","option_a":"...","option_b":"...","option_c":"...","option_d":"...","correct_answer":"A","explanation":"...","topic":"..."}]

CONTENT:
---
${content.slice(0, 10000)}
---`;
}

// ── PDF QUIZ GENERATION ───────────────────────────────────

// POST /api/ai-quiz/from-pdf
exports.generateFromPDF = async (req, res) => {
  try {
    const { pdfBase64, subject, count = 10, difficulty = 'medium' } = req.body;
    const sid = req.student.id;

    if (!pdfBase64) return res.status(400).json({ error: 'pdfBase64 is required.' });

    // FIX (PDF generation never actually worked): this used to call Groq's
    // llama-3.3-70b-versatile — a TEXT-ONLY model — with the PDF attached
    // as an `image_url`. That request always failed (the model has no
    // vision capability at all, and even Groq's actual vision models don't
    // accept raw PDF bytes that way — only real images). The failure was
    // silently swallowed by a `.catch()` that fell back to decoding the
    // raw PDF's binary bytes as UTF-8 text, which is just noise for a
    // compressed binary format — not real content — so the AI was always
    // being fed garbage. Gemini has genuine native PDF understanding
    // (send it as inline document data), and it was already integrated
    // into this app — it just wasn't wired up here. This uses it directly.
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: 'PDF question generation requires Gemini to be configured. Please contact support.' });
    }

    let extractedText;
    try {
      const model = getGemini().getGenerativeModel({ model: GEMINI_MODEL });
      const result = await model.generateContent([
        { text: 'Extract all readable text from this PDF document. Return only the extracted text, nothing else — no summary, no commentary.' },
        { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } },
      ]);
      extractedText = result.response.text();
    } catch (extractErr) {
      console.error('Gemini PDF extraction error:', extractErr.message);
      return res.status(502).json({ error: 'Could not read this PDF. It may be scanned/image-only, password-protected, or corrupted — please try a different file.' });
    }

    if (!extractedText || extractedText.trim().length < 100) {
      return res.status(400).json({ error: 'Could not extract enough text from the PDF.' });
    }

    const questions = await generateQuestions(extractedText, { subject, count, difficulty });

    // Log the generation
    await db.query(
      `INSERT INTO ai_quiz_generations (student_id, source_type, subject, question_count, created_at)
       VALUES ($1,'pdf',$2,$3,NOW())`,
      [sid, subject || 'General', questions.length]
    ).catch(() => {});

    res.json({ success: true, questions, total: questions.length });
  } catch (err) {
    console.error('generateFromPDF error:', err.message);
    serverError(res, err);
  }
};

// POST /api/ai-quiz/from-text
// Works for: typed notes, video transcripts, study session content
exports.generateFromText = async (req, res) => {
  try {
    const { text, subject, count = 10, difficulty = 'medium', sourceType = 'notes' } = req.body;
    const sid = req.student.id;

    if (!text || text.trim().length < 50) {
      return res.status(400).json({ error: 'Content is too short to generate questions.' });
    }

    const questions = await generateQuestions(text, { subject, count, difficulty });

    await db.query(
      `INSERT INTO ai_quiz_generations (student_id, source_type, subject, question_count, created_at)
       VALUES ($1,$2,$3,$4,NOW())`,
      [sid, sourceType, subject || 'General', questions.length]
    ).catch(() => {});

    res.json({ success: true, questions, total: questions.length });
  } catch (err) {
    console.error('generateFromText error:', err.message);
    serverError(res, err);
  }
};

// POST /api/ai-quiz/from-video
// Student passes video ID from the video library — we fetch transcript
exports.generateFromVideo = async (req, res) => {
  try {
    const { videoId, subject, count = 10, difficulty = 'medium' } = req.body;
    const sid = req.student.id;

    // Fetch video transcript from DB
    const video = await db.query(
      `SELECT title, transcript, subject FROM videos WHERE id=$1`, [videoId]
    ).catch(() => ({ rows: [] }));

    if (!video.rows.length) return res.status(404).json({ error: 'Video not found.' });
    const { transcript, title } = video.rows[0];

    if (!transcript || transcript.length < 100) {
      return res.status(400).json({ error: 'This video has no transcript available for quiz generation.' });
    }

    const questions = await generateQuestions(
      transcript,
      { subject: subject || video.rows[0].subject || 'General', count, difficulty }
    );

    await db.query(
      `INSERT INTO ai_quiz_generations (student_id, source_type, source_ref, subject, question_count, created_at)
       VALUES ($1,'video',$2,$3,$4,NOW())`,
      [sid, videoId, subject || 'General', questions.length]
    ).catch(() => {});

    res.json({ success: true, videoTitle: title, questions, total: questions.length });
  } catch (err) {
    console.error('generateFromVideo error:', err.message);
    serverError(res, err);
  }
};

// POST /api/ai-quiz/save
// Student chooses to save generated questions to the question bank or a personal quiz
exports.saveQuiz = async (req, res) => {
  try {
    const { questions, quizName, subject } = req.body;
    const sid = req.student.id;

    if (!Array.isArray(questions) || !questions.length) {
      return res.status(400).json({ error: 'No questions to save.' });
    }

    // Save as a personal practice quiz
    const quiz = await db.query(
      `INSERT INTO personal_quizzes (student_id, name, subject, question_count, created_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING id`,
      [sid, quizName || 'My AI Quiz', subject || 'General', questions.length]
    );
    const quizId = quiz.rows[0].id;

    // Insert each question
    for (const q of questions) {
      await db.query(
        `INSERT INTO personal_quiz_questions
           (quiz_id, question, option_a, option_b, option_c, option_d,
            correct_answer, explanation, topic)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [quizId, q.question, q.option_a, q.option_b, q.option_c, q.option_d,
         q.correct_answer, q.explanation, q.topic]
      ).catch(() => {});
    }

    res.json({ success: true, quizId, message: `Quiz "${quizName}" saved with ${questions.length} questions.` });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/ai-quiz/my-quizzes
exports.getMyQuizzes = async (req, res) => {
  try {
    const sid = req.student.id;
    const { rows } = await db.query(
      `SELECT id, name, subject, question_count, created_at
       FROM personal_quizzes WHERE student_id=$1
       ORDER BY created_at DESC LIMIT 20`,
      [sid]
    ).catch(() => ({ rows: [] }));
    res.json({ quizzes: rows });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/ai-quiz/my-quizzes/:id
exports.getQuizById = async (req, res) => {
  try {
    const sid    = req.student.id;
    const quizId = parseInt(req.params.id);

    const quiz = await db.query(
      `SELECT * FROM personal_quizzes WHERE id=$1 AND student_id=$2`,
      [quizId, sid]
    );
    if (!quiz.rows.length) return res.status(404).json({ error: 'Quiz not found.' });

    const questions = await db.query(
      `SELECT * FROM personal_quiz_questions WHERE quiz_id=$1 ORDER BY id`,
      [quizId]
    );

    res.json({ quiz: quiz.rows[0], questions: questions.rows });
  } catch (err) {
    serverError(res, err);
  }
};

// ── CORE AI FUNCTION ─────────────────────────────────────

async function generateQuestions(content, opts) {
  // FIX: count came straight from the request body with no upper bound —
  // a student passing count:500 would silently trigger one enormous,
  // expensive AI call (and likely fail anyway once it blows past any
  // token budget). Clamp it here, the one place all three entry points
  // (from-pdf/from-text/from-video) funnel through.
  opts = { ...opts, count: Math.max(1, Math.min(Number(opts?.count) || 10, 25)) };
  const prompt = buildQuizPrompt(content, opts);

  // FIX ("max completion tokens reached before generating a valid
  // document"): 4000 was a flat token budget no matter how many questions
  // were requested. Each question needs roughly 200-300 tokens once you
  // include 4 options, an explanation, and a topic tag, all as valid JSON
  // — so 10 questions can easily need 2500-3000+ tokens, and 15-20 blow
  // straight through 4000, cutting the response off mid-array. Scaling
  // the budget with the requested count (with a sensible floor and a
  // ceiling matched to the model's real output limit) fixes this for any
  // question count instead of just happening to work for small ones.
  const requestedCount = parseInt(opts?.count) || 10;
  const maxTokens = Math.min(8000, Math.max(2500, requestedCount * 320 + 800));

  const { content: raw, provider } = await chatCompletion({
    messages: [
      {
        role:    'system',
        content: 'You are a JSON-only API. You must respond with a valid JSON array and nothing else. No markdown, no code fences, no explanation text. Only output the raw JSON array starting with [ and ending with ].',
      },
      { role: 'user', content: prompt },
    ],
    model:       MODEL,
    maxTokens,
    temperature: 0.3,
    jsonMode:    true,
  });
  if (provider === 'gemini') {
    console.log('[aiQuiz] question set generated via Gemini fallback (Groq was unavailable).');
  }

  const rawTrimmed = raw.trim();

  // ── Robust JSON extraction ────────────────────────────────
  // Strip markdown fences, BOM, invisible chars
  let cleaned = rawTrimmed
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/^\uFEFF/, '')          // BOM
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // zero-width chars
    .trim();

  // Handle json_object wrapper: Groq may return {"questions":[...]} or just [...]
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      // Direct array - perfect
    } else if (parsed && typeof parsed === 'object') {
      // Find first array value in the object
      const arr = Object.values(parsed).find(v => Array.isArray(v));
      if (arr) { cleaned = JSON.stringify(arr); }
    }
  } catch (_) { /* fall through to bracket extraction below */ }

  // Find the outermost [ ... ] array
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd   = cleaned.lastIndexOf(']');
  if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
    throw new Error('AI did not return a valid JSON array. Please try again.');
  }
  cleaned = cleaned.slice(arrayStart, arrayEnd + 1);

  // Sanitize control characters inside strings that break JSON parsers
  // Replace unescaped newlines/tabs inside the string content
  cleaned = cleaned.replace(/[\r\n\t]+/g, ' ');

  let questions;
  try {
    questions = JSON.parse(cleaned);
  } catch (parseErr) {
    // Last resort: try to fix common AI mistakes (smart quotes → straight quotes)
    const fixed = cleaned
      .replace(/[\u2018\u2019]/g, "'")   // smart single quotes → apostrophe
      .replace(/[\u201C\u201D]/g, '"');  // smart double quotes → straight
    try {
      questions = JSON.parse(fixed);
    } catch {
      throw new Error(`AI returned malformed JSON: ${parseErr.message}. Please try again.`);
    }
  }

  if (!Array.isArray(questions)) throw new Error('AI did not return an array of questions.');

  // Validate and sanitize each question. The A/B/C/D check matters:
  // without it, if the AI ever returns the answer as anything other than a
  // clean single letter (the literal answer text, "Option A", etc.), that
  // question becomes silently unwinnable — no student answer can ever
  // match after normalization mangles a non-letter value. aiQuestionController.js
  // and the admin question generator already guard against this; this path
  // (a student's own "quiz from my notes/PDF") didn't.
  return questions
    .filter(q => q.question && q.option_a && q.option_b && q.option_c && q.option_d && q.correct_answer)
    .map(q => ({
      question:       String(q.question).trim(),
      option_a:       String(q.option_a).trim(),
      option_b:       String(q.option_b).trim(),
      option_c:       String(q.option_c).trim(),
      option_d:       String(q.option_d).trim(),
      correct_answer: String(q.correct_answer).toUpperCase().charAt(0),
      explanation:    q.explanation ? String(q.explanation).trim() : '',
      topic:          q.topic       ? String(q.topic).trim()       : '',
    }))
    .filter(q => ['A', 'B', 'C', 'D'].includes(q.correct_answer));
}

module.exports = {
  generateFromPDF:  exports.generateFromPDF,
  generateFromText: exports.generateFromText,
  generateFromVideo:exports.generateFromVideo,
  saveQuiz:         exports.saveQuiz,
  getMyQuizzes:     exports.getMyQuizzes,
  getQuizById:      exports.getQuizById,
};
