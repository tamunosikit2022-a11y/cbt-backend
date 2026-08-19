/**
 * studyNotesController.js — Scholars Syndicate
 * NEW FEATURE: After an exam, AI auto-generates concise revision notes
 * covering topics the student got wrong, using Groq.
 * Was per-question explanation only — now covers full topic patterns.
 */

const db = require("../config/db");
const { chatCompletion } = require("../utils/aiProvider");
const { serverError } = require('../utils/errors');

// POST /api/study-notes/generate
// Body: { session_id? } — uses student's most recent exam session if omitted
exports.generateNotes = async (req, res) => {
  const student_id = req.student.id;
  const { session_id } = req.body;

  // 1. Get wrong answers for the specified (or most recent) session
  let wrongQ;
  if (session_id) {
    wrongQ = await db.query(
      `SELECT q.subject, q.topic, q.question, q.correct_answer,
              q.option_a, q.option_b, q.option_c, q.option_d, q.explanation
       FROM wrong_answers wa
       JOIN questions q ON q.id = wa.question_id
       WHERE wa.student_id = $1 AND wa.session_id = $2
       LIMIT 20`,
      [student_id, session_id]
    );
  } else {
    wrongQ = await db.query(
      `SELECT q.subject, q.topic, q.question, q.correct_answer,
              q.option_a, q.option_b, q.option_c, q.option_d, q.explanation
       FROM wrong_answers wa
       JOIN questions q ON q.id = wa.question_id
       WHERE wa.student_id = $1
       ORDER BY wa.created_at DESC
       LIMIT 20`,
      [student_id]
    );
  }

  if (!wrongQ.rows.length) {
    return res.json({
      notes: null,
      message: "No wrong answers found to generate notes from. Keep practising!",
    });
  }

  // Group by subject
  const grouped = wrongQ.rows.reduce((acc, q) => {
    const k = q.subject || "General";
    if (!acc[k]) acc[k] = [];
    acc[k].push(q);
    return acc;
  }, {});

  // Local fallback when Groq isn't available
  if (!process.env.GROQ_API_KEY) {
    return res.json({ notes: buildLocalNotes(grouped), source: "local" });
  }

  const questionsText = wrongQ.rows.map((q, i) =>
    `Q${i+1} [${q.subject} — ${q.topic || "General"}]: ${q.question.slice(0, 150)}... Correct: ${q.correct_answer}. ${q.explanation ? "Hint: " + q.explanation.slice(0, 100) : ""}`
  ).join("\n");

  const prompt = `You are a JAMB exam coach preparing a Nigerian SS3 student's revision notes.
The student got these questions wrong in a practice session:

${questionsText}

Write concise, practical REVISION NOTES in JSON format only (no markdown):
{
  "title": "Your Personalised Revision Notes",
  "generated_at": "${new Date().toISOString()}",
  "sections": [
    {
      "subject": "Subject Name",
      "key_concepts": ["Concept 1", "Concept 2"],
      "common_mistakes": "What students typically get wrong and why",
      "quick_tips": ["Tip 1", "Tip 2"],
      "memory_aids": "A mnemonic or shortcut if applicable"
    }
  ],
  "exam_strategy": "One focused strategy for the student based on their error patterns"
}

Rules:
- Group by subject
- Keep each concept to 1-2 sentences max
- Focus on WHY the answer is what it is, not just what it is
- Use Nigerian curriculum language (JAMB/WAEC style)
- JSON only, nothing else`;

  try {
    const completion = await chatCompletion({
      model: "openai/gpt-oss-120b",
      maxTokens: 1200,
      temperature: 0.4,
      messages: [{ role: "user", content: prompt }],
      taskType: "explain", // full revision-notes writeup — prefer Gemini first
    });

    const raw = completion.content?.trim() || "";
    const clean = raw.replace(/```json\n?|```/g, "").trim();

    let notes;
    try {
      notes = JSON.parse(clean);
    } catch {
      notes = buildLocalNotes(grouped);
    }

    // Save to DB (best-effort)
    if (session_id) {
      await db.query(
        `INSERT INTO study_notes (student_id, session_id, notes_json, created_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (student_id, session_id) DO UPDATE SET notes_json=$3, created_at=NOW()`,
        [student_id, session_id, JSON.stringify(notes)]
      ).catch(() => {});
    }

    return res.json({ notes, source: "ai" });
  } catch (err) {
    console.error("studyNotes error:", err.message);
    return res.json({ notes: buildLocalNotes(grouped), source: "local_fallback" });
  }
};

// GET /api/study-notes/latest
exports.getLatestNotes = async (req, res) => {
  const student_id = req.student.id;
  try {
    const r = await db.query(
      "SELECT notes_json, created_at FROM study_notes WHERE student_id=$1 ORDER BY created_at DESC LIMIT 1",
      [student_id]
    );
    if (!r.rows.length) return res.json({ notes: null });
    const row = r.rows[0];
    return res.json({
      notes: typeof row.notes_json === "string" ? JSON.parse(row.notes_json) : row.notes_json,
      created_at: row.created_at,
    });
  } catch (err) {
    serverError(res, err);
  }
};

function buildLocalNotes(grouped) {
  const sections = Object.entries(grouped).map(([subject, questions]) => ({
    subject,
    key_concepts: [...new Set(questions.map(q => q.topic).filter(Boolean))].slice(0, 4),
    common_mistakes: `You missed ${questions.length} question${questions.length > 1 ? "s" : ""} in ${subject}. Review the foundational concepts for these topics.`,
    quick_tips: [
      `Practice at least 20 past JAMB ${subject} questions daily`,
      `Focus on understanding the reasoning, not just memorising answers`,
    ],
    memory_aids: null,
  }));

  return {
    title: "Your Revision Notes",
    generated_at: new Date().toISOString(),
    sections,
    exam_strategy: "Focus your next 3 study sessions on your weakest subject. One concept at a time, then test yourself with 10 past questions.",
  };
}
