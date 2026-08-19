/**
 * studyPlannerController.js — Scholars Syndicate
 * FIX: generatePlan was pure client-side JS with no AI.
 *      Now calls Groq llama-3.3-70b to produce a real personalised plan
 *      based on the student's actual weak subjects from the heatmap.
 *
 * Add route to server.js (already exists as /api/study-planner):
 *   app.use("/api/study-planner", require("./routes/studyPlannerRoutes"));
 */

const db = require("../config/db");
const { chatCompletion } = require("../utils/aiProvider");
const { serverError } = require("../utils/errors");

const DAY_KEYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DEFAULT_WEEKLY_HOURS = { Sun:2, Mon:2, Tue:2, Wed:2, Thu:2, Fri:2, Sat:3 };

// ── GENERATE AI STUDY PLAN ────────────────────────────────
// POST /api/study-planner/generate
// Body: {
//   exam_date: "YYYY-MM-DD",
//   subjects: string[],          // subjects the student actually wants covered
//   weak_subjects: string[],     // subset of `subjects` that need extra sessions
//   weekly_hours: {              // hours the student can realistically study, per weekday
//     Sun:1, Mon:3, Tue:2, Wed:2, Thu:0, Fri:2, Sat:4
//   }
// }
// `weekly_hours` is how "how busy is your week" gets captured — a busy day is
// simply a day with fewer (or 0) hours, rather than a vague label, so the
// schedule can be built directly from real numbers instead of guessing.
exports.generatePlan = async (req, res) => {
  const student_id = req.student.id;
  const {
    exam_date,
    subjects = [],
    weak_subjects = [],
    chosen_subjects = [],   // kept for backward compatibility with older clients
    weekly_hours,
  } = req.body;

  if (!exam_date) return res.status(400).json({ error: "exam_date is required." });

  // Accept either the new `subjects` field or the legacy `chosen_subjects`
  const subjectList0 = subjects.length ? subjects : chosen_subjects;
  if (!subjectList0.length) {
    return res.status(400).json({ error: "Pick at least one subject to build a plan around." });
  }

  const hours = { ...DEFAULT_WEEKLY_HOURS, ...(weekly_hours || {}) };
  // Clamp to something sane — nobody is studying 16 hours a day for JAMB
  DAY_KEYS.forEach(d => { hours[d] = Math.max(0, Math.min(10, Number(hours[d]) || 0)); });

  const today    = new Date();
  const examDay  = new Date(exam_date);
  const daysLeft = Math.max(1, Math.ceil((examDay - today) / (1000 * 60 * 60 * 24)));
  const planDays = Math.min(daysLeft, 28);

  // Save exam date to student profile (fixes localStorage-only bug)
  await db.query(
    "UPDATE students SET jamb_exam_date = $1 WHERE id = $2",
    [exam_date, student_id]
  ).catch(() => {}); // silent if column doesn't exist yet

  // Fast local fallback when Groq is unavailable
  if (!process.env.GROQ_API_KEY) {
    const plan = buildLocalPlan(planDays, weak_subjects, subjectList0, exam_date, hours);
    return res.json({ plan, source: "local" });
  }

  const subjectDesc = [
    ...weak_subjects.map(s => `${s} (WEAK — needs extra sessions)`),
    ...subjectList0.filter(s => !weak_subjects.includes(s)),
  ].join(", ");

  const hoursDesc = DAY_KEYS.map(d => `${d}: ${hours[d]}h`).join(", ");

  const prompt = `You are a JAMB exam prep coach for Nigerian SS3 students.

Student profile:
- Days until JAMB: ${daysLeft}
- Plan length: ${planDays} days
- Subjects to cover: ${subjectDesc}
- Hours available to study, per weekday (this repeats every week — a day listed as 0h is a genuinely busy/rest day, do not schedule tasks that day): ${hoursDesc}

Create a ${planDays}-day study plan starting today. Respond ONLY with a JSON array (no markdown):
[
  {
    "date_offset": 0,
    "day_label": "Day 1",
    "focus": "Subject Name",
    "tasks": [
      { "text": "Task description", "type": "practice|review|mock|reading", "mins": 30 }
    ],
    "tip": "One motivating tip for this day"
  }
]

Rules:
- Day 0 = today
- On a day with 0 available hours, return an empty "tasks" array (rest day) — never schedule anything that day
- Never schedule more total task minutes on a day than that day's available hours × 60
- Only schedule a full JAMB mock exam (all subjects, 120 min) on a day with at least 2 available hours, roughly every 7 days
- Weak subjects get 40% more sessions than strong ones, but still respect the daily hour budget
- Mix task types: practice questions, error review, concept reading, timed drills
- Final 3 days before the exam: only quick revision and rest — no new topics, and keep it light even on high-hour days
- Keep task texts specific (e.g. "Practice 40 JAMB Chemistry questions — focus on organic" not just "Study Chemistry")
- JSON array only, nothing else`;

  try {
    const { content: rawContent } = await chatCompletion({
      model:       "openai/gpt-oss-120b",
      maxTokens:   2500,
      temperature: 0.5,
      messages:    [{ role: "user", content: prompt }],
      taskType:    "explain", // longer, reasoning-heavy plan generation — prefer Gemini first
    });

    const raw   = rawContent?.trim() || "";
    const clean = raw.replace(/```json\n?|```/g, "").trim();
    let days;
    try {
      days = JSON.parse(clean);
      if (!Array.isArray(days)) throw new Error("Not an array");
    } catch {
      // AI returned malformed JSON — fall back to local
      const plan = buildLocalPlan(planDays, weak_subjects, subjectList0, exam_date, hours);
      return res.json({ plan, source: "local_fallback" });
    }

    // Hydrate dates
    const startDate = new Date();
    const planDays2 = days.map((d, i) => {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + (d.date_offset ?? i));
      return {
        ...d,
        date: date.toISOString().split("T")[0],
        day:  DAY_KEYS[date.getDay()],
        tasks: (d.tasks || []).map((t, ti) => ({ ...t, id: `${i}-${ti}` })),
      };
    });

    const plan = {
      created:      new Date().toISOString(),
      exam_date,
      days_left:    daysLeft,
      plan_days:    planDays,
      subjects:     subjectList0,
      weak_subjects,
      weekly_hours: hours,
      days:         planDays2,
      ai_powered:   true,
    };

    // Persist to DB (best-effort)
    await db.query(
      `INSERT INTO study_plans (student_id, exam_date, plan_json, created_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (student_id) DO UPDATE
       SET exam_date=$2, plan_json=$3, created_at=NOW()`,
      [student_id, exam_date, JSON.stringify(plan)]
    ).catch(() => {});

    return res.json({ plan, source: "ai" });

  } catch (err) {
    console.error("study-planner/generate error:", err.message);
    const plan = buildLocalPlan(planDays, weak_subjects, subjectList0, exam_date, hours);
    return res.json({ plan, source: "local_fallback" });
  }
};

// ── GET SAVED PLAN ────────────────────────────────────────
// GET /api/study-planner/my-plan
exports.getMyPlan = async (req, res) => {
  const student_id = req.student.id;
  try {
    const r = await db.query(
      "SELECT plan_json, exam_date FROM study_plans WHERE student_id=$1",
      [student_id]
    );
    if (!r.rows.length) return res.json({ plan: null });
    const { plan_json, exam_date } = r.rows[0];
    return res.json({
      plan: typeof plan_json === "string" ? JSON.parse(plan_json) : plan_json,
      exam_date,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── LOCAL FALLBACK PLAN ───────────────────────────────────
// Builds a schedule from the student's ACTUAL weekday hours instead of a
// fixed one-task-per-day pattern: a 0h day gets nothing, a 4h day gets a
// full session. Weak subjects are cycled through more often.
function buildLocalPlan(planDays, weak_subjects, subjectList, exam_date, weekly_hours) {
  const SUBJECTS = [...new Set(subjectList.length ? subjectList : ["English Language", "Mathematics"])];
  const hours = weekly_hours || DEFAULT_WEEKLY_HOURS;

  // Weighted rotation: weak subjects appear ~1.7x as often as strong ones
  const rotation = [];
  SUBJECTS.forEach(s => {
    const weight = weak_subjects.includes(s) ? 2 : 1;
    for (let i = 0; i < weight; i++) rotation.push(s);
  });

  const today = new Date();
  const days  = [];
  let rotationIdx  = 0;
  let daysSinceMock = 0;

  for (let d = 0; d < planDays; d++) {
    const date       = new Date(today);
    date.setDate(today.getDate() + d);
    const dayKey     = DAY_KEYS[date.getDay()];
    const budgetMins = Math.round((hours[dayKey] ?? 0) * 60);
    const isLast3    = d >= planDays - 3;

    let tasks = [];
    let focus = null;

    if (budgetMins <= 0) {
      // Genuinely busy/rest day — nothing scheduled
      tasks = [];
    } else if (isLast3) {
      const subj = rotation[rotationIdx % rotation.length];
      focus = subj;
      tasks = [{ id:`${d}-0`, text:`Quick revision — ${subj} key formulas and definitions`, type:"reading", mins: Math.min(30, budgetMins) }];
      rotationIdx++;
    } else if (budgetMins >= 120 && daysSinceMock >= 6) {
      focus = "All subjects";
      tasks = [{ id:`${d}-0`, text:"Full JAMB mock exam — all chosen subjects", type:"mock", mins:120 }];
      const leftover = budgetMins - 120;
      if (leftover >= 20) {
        const subj = rotation[rotationIdx % rotation.length];
        tasks.push({ id:`${d}-1`, text:`Review mock exam mistakes — ${subj}`, type:"review", mins: Math.min(leftover, 30) });
        rotationIdx++;
      }
      daysSinceMock = 0;
    } else {
      // Fill the day's hour budget with 30-45 min practice/review blocks
      let remaining = budgetMins;
      let slot = 0;
      while (remaining >= 20 && slot < 4) {
        const subj   = rotation[rotationIdx % rotation.length];
        if (!focus) focus = subj;
        const isWeak = weak_subjects.includes(subj);
        const mins   = Math.min(remaining, isWeak ? 45 : 35);
        tasks.push({
          id:   `${d}-${slot}`,
          text: slot % 2 === 1 && isWeak
            ? `Review wrong ${subj} answers and re-attempt`
            : `Practice ${Math.max(20, Math.round(mins))} min of JAMB ${subj} questions`,
          type: slot % 2 === 1 && isWeak ? "review" : "practice",
          mins,
        });
        remaining -= mins;
        rotationIdx++;
        slot++;
      }
      daysSinceMock++;
    }

    days.push({
      date:      date.toISOString().split("T")[0],
      day:       dayKey,
      day_label: `Day ${d + 1}`,
      focus:     focus || "Rest day",
      tasks,
      tip: budgetMins <= 0
        ? "Rest day — no sessions scheduled. Recovery is part of the plan."
        : isLast3
          ? "Rest well and trust your preparation."
          : `Focus on ${focus} today — small consistent sessions beat marathon cramming.`,
    });
  }

  return {
    created:      new Date().toISOString(),
    exam_date,
    days_left:    planDays,
    plan_days:    planDays,
    subjects:     SUBJECTS,
    weak_subjects,
    weekly_hours: hours,
    days,
    ai_powered:   false,
  };
}
