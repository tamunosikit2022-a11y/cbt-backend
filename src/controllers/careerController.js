/**
 * careerController.js — Scholars Syndicate
 * AI-powered career & course suggestion based on CareerQuiz answers.
 * Uses Groq llama-3.3-70b for fast, context-aware results.
 *
 * FIX: This entire controller was missing — CareerQuiz.js posted to
 *      /career/suggest but no backend route or controller existed.
 *      Every career quiz submission returned a 404.
 */

const db = require("../config/db");
const { chatCompletion } = require("../utils/aiProvider");
const { serverError } = require('../utils/errors');

// ── CAREER SUGGESTION ─────────────────────────────────────
// POST /api/career/suggest
// Body: { answers: string[] }   (7 quiz answers from CareerQuiz.js)
exports.suggest = async (req, res) => {
  const { answers } = req.body;
  const student_id  = req.student?.id;

  if (!answers || !Array.isArray(answers) || answers.length < 3) {
    return res.status(400).json({ error: "At least 3 quiz answers required." });
  }

  // Fallback if neither AI provider is configured
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
    const fallback = localFallback(answers);
    return res.json(fallback);
  }

  const prompt = `You are a Nigerian university admissions counsellor.
A student completed a 7-question career personality quiz.
Their answers were:
${answers.map((a, i) => `Q${i + 1}: ${a}`).join("\n")}

Based ONLY on these answers, respond with a JSON object (no markdown, no explanation) in this exact format:
{
  "personality_type": "<one catchy 2-3 word label like 'Creative Analyst'>",
  "description": "<2 sentences describing the student's strengths and natural tendencies>",
  "careers": [
    { "title": "<Career Title>", "icon": "<relevant emoji>", "why": "<one sentence why this fits them>", "jamb_subjects": ["English Language", "Mathematics", "..."] },
    { "title": "<Career Title>", "icon": "<relevant emoji>", "why": "<one sentence>", "jamb_subjects": ["..."] },
    { "title": "<Career Title>", "icon": "<relevant emoji>", "why": "<one sentence>", "jamb_subjects": ["..."] }
  ],
  "study_tip": "<one personalised motivational study tip based on their personality>"
}

Rules:
- All careers must be realistic in the Nigerian university/polytechnic context
- JAMB subjects must be from the official JAMB subject list
- Personality type must be positive and motivating
- JSON only, no extra text`;

  try {
    const completion = await chatCompletion({
      model:       "openai/gpt-oss-120b",
      maxTokens:   700,
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
      taskType: "explain", // personality write-up + career reasoning — prefer Gemini first
    });

    const raw  = completion.content?.trim() || "";
    // Strip any accidental markdown fences
    const clean = raw.replace(/```json\n?|```/g, "").trim();
    let result;
    try {
      result = JSON.parse(clean);
    } catch {
      // AI gave non-JSON — use local fallback
      result = localFallback(answers);
    }

    // Persist to DB (best-effort — don't fail the response if this errors)
    if (student_id) {
      db.query(
        `INSERT INTO career_results (student_id, personality_type, careers, study_tip, created_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (student_id) DO UPDATE
         SET personality_type=$2, careers=$3, study_tip=$4, created_at=NOW()`,
        [student_id, result.personality_type, JSON.stringify(result.careers), result.study_tip]
      ).catch(() => {}); // silent — table may not exist yet
    }

    return res.json(result);
  } catch (err) {
    console.error("career/suggest error:", err.message);
    // Return local fallback rather than a 500 so the UI still works
    return res.json(localFallback(answers));
  }
};

// ── GET SAVED RESULT ──────────────────────────────────────
// GET /api/career/result
exports.getResult = async (req, res) => {
  const student_id = req.student?.id;
  if (!student_id) return res.status(401).json({ error: "Not authenticated." });

  try {
    const r = await db.query(
      `SELECT personality_type, careers, study_tip, created_at
       FROM career_results WHERE student_id=$1`,
      [student_id]
    );
    if (!r.rows.length) return res.json({ result: null });
    const row = r.rows[0];
    return res.json({
      result: {
        personality_type: row.personality_type,
        careers:  typeof row.careers === "string" ? JSON.parse(row.careers) : row.careers,
        study_tip: row.study_tip,
        created_at: row.created_at,
      },
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── LOCAL FALLBACK ────────────────────────────────────────
// Used when GROQ_API_KEY is unset or Groq is unreachable.
function localFallback(answers) {
  // Simple keyword matching to pick a personality bucket
  const text = answers.join(" ").toLowerCase();
  const isScience  = /science|math|tech|engineer|computer|medical|doctor/.test(text);
  const isArt      = /art|creat|design|music|write|story|drama/.test(text);
  const isBusiness = /business|money|market|trade|sell|manage|lead/.test(text);
  const isSocial   = /people|help|teach|communit|social|counsel/.test(text);

  if (isScience) return {
    personality_type: "Analytical Problem-Solver",
    description: "You thrive on logic and enjoy breaking complex problems into manageable pieces. Your curiosity drives you to understand how things work at a fundamental level.",
    careers: [
      { title: "Software Engineer", icon: "💻", why: "Your logical mindset is perfect for building systems.", jamb_subjects: ["English Language","Mathematics","Physics","Chemistry"] },
      { title: "Medical Doctor", icon: "🩺", why: "Your attention to detail suits the precision medicine demands.", jamb_subjects: ["English Language","Biology","Chemistry","Physics"] },
      { title: "Electrical Engineer", icon: "⚡", why: "Your love for understanding systems fits electrical engineering.", jamb_subjects: ["English Language","Mathematics","Physics","Chemistry"] },
    ],
    study_tip: "Use past JAMB questions as your warm-up every morning — your systematic approach will turn patterns into marks.",
  };
  if (isArt) return {
    personality_type: "Creative Visionary",
    description: "You see the world differently and express ideas in unique ways. Your imagination is your greatest asset.",
    careers: [
      { title: "Graphic Designer", icon: "🎨", why: "Your creativity shines in visual communication.", jamb_subjects: ["English Language","Mathematics","Fine Art","Economics"] },
      { title: "Mass Communication", icon: "📡", why: "Your storytelling ability suits broadcast and journalism.", jamb_subjects: ["English Language","Literature in English","Government","Economics"] },
      { title: "Architecture", icon: "🏛️", why: "You can marry creativity with technical skill.", jamb_subjects: ["English Language","Mathematics","Physics","Fine Art"] },
    ],
    study_tip: "Create mind-maps and colourful summaries of topics — your visual memory will absorb information faster than plain notes.",
  };
  if (isBusiness) return {
    personality_type: "Strategic Leader",
    description: "You are goal-driven and naturally think about resources, people and outcomes. You enjoy turning ideas into results.",
    careers: [
      { title: "Business Administration", icon: "📊", why: "Your leadership style and strategic thinking are a natural fit.", jamb_subjects: ["English Language","Mathematics","Economics","Commerce"] },
      { title: "Accounting", icon: "💰", why: "Your attention to numbers and outcomes suits financial roles.", jamb_subjects: ["English Language","Mathematics","Economics","Commerce"] },
      { title: "Law", icon: "⚖️", why: "Your negotiation instincts and logical persuasion are valuable.", jamb_subjects: ["English Language","Literature in English","Government","Economics"] },
    ],
    study_tip: "Set daily score targets and track your progress like a KPI — you are motivated by measurable growth.",
  };
  // Default: Social / Helping
  return {
    personality_type: "Compassionate Connector",
    description: "You are driven by a desire to make a difference in people's lives. You listen well and build trust naturally.",
    careers: [
      { title: "Nursing", icon: "🏥", why: "Your empathy and care make you ideal for patient-centred roles.", jamb_subjects: ["English Language","Biology","Chemistry","Physics"] },
      { title: "Psychology", icon: "🧠", why: "Your ability to understand people is the foundation of this field.", jamb_subjects: ["English Language","Biology","Government","Economics"] },
      { title: "Education / Teaching", icon: "📚", why: "Your patience and communication skills translate directly.", jamb_subjects: ["English Language","Mathematics","Economics","Government"] },
    ],
    study_tip: "Study in groups when you can — explaining topics to others is your fastest path to mastering them.",
  };
}
