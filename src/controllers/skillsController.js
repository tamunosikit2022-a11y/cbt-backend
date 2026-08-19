const db = require("../config/db");
const { serverError } = require('../utils/errors');

// ── SKILL CATALOG ─────────────────────────────────────────
const CBT_SKILLS = [
  { id: "time_freeze",   name: "Time Freeze",   icon: "⏸️",  type: "cbt",   rarity: "rare",     cost: { coins: 500 },  effect: "Pauses exam timer for 15 seconds", uses: 1 },
  { id: "smart_hint",    name: "Smart Hint",    icon: "💡",  type: "cbt",   rarity: "common",   cost: { coins: 200 },  effect: "Reveals an AI-generated clue for current question", uses: 1 },
  { id: "fifty_fifty",   name: "50/50",         icon: "✂️",  type: "cbt",   rarity: "common",   cost: { coins: 300 },  effect: "Removes 2 wrong answer options", uses: 1 },
  { id: "retry_shield",  name: "Retry Shield",  icon: "🛡️", type: "cbt",   rarity: "rare",     cost: { coins: 400 },  effect: "Allows one question retry without penalty", uses: 1 },
];

const ARENA_BOOSTS = [
  { id: "double_xp",     name: "Double XP",     icon: "⚡",  type: "arena", rarity: "rare",     cost: { coins: 600 },  effect: "2× XP for next Arena match", uses: 1 },
  { id: "coin_magnet",   name: "Coin Magnet",   icon: "🧲",  type: "arena", rarity: "common",   cost: { coins: 400 },  effect: "Extra coins from next Arena match", uses: 1 },
  { id: "rank_shield",   name: "Rank Shield",   icon: "🔰",  type: "arena", rarity: "epic",     cost: { gems: 20 },    effect: "Protects rank from dropping once", uses: 1 },
  { id: "streak_shield", name: "Streak Shield", icon: "🔥",  type: "arena", rarity: "rare",     cost: { coins: 500 },  effect: "Preserves streak even if you lose", uses: 1 },
];

const ALL_SKILLS = [...CBT_SKILLS, ...ARENA_BOOSTS];

// ── GET skills inventory ──────────────────────────────────
exports.getSkills = async (req, res) => {
  try {
    const sid = req.student.id;
    const [walletRes, inventoryRes] = await Promise.all([
      db.query("SELECT COALESCE(coins,0) as coins, COALESCE(gems,0) as gems FROM students WHERE id=$1", [sid]),
      db.query("SELECT skill_id, quantity FROM student_skills WHERE student_id=$1", [sid]).catch(() => ({ rows: [] })),
    ]);

    const inventory = {};
    inventoryRes.rows.forEach(r => { inventory[r.skill_id] = r.quantity; });

    const skills = ALL_SKILLS.map(s => ({
      ...s,
      owned: inventory[s.id] || 0,
    }));

    res.json({
      cbt_skills:   skills.filter(s => s.type === "cbt"),
      arena_boosts: skills.filter(s => s.type === "arena"),
      coins: walletRes.rows[0]?.coins || 0,
      gems:  walletRes.rows[0]?.gems  || 0,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── BUY skill ─────────────────────────────────────────────
exports.buySkill = async (req, res) => {
  try {
    const { skill_id, qty = 1 } = req.body;
    const sid = req.student.id;

    const skill = ALL_SKILLS.find(s => s.id === skill_id);
    if (!skill) return res.status(400).json({ error: "Skill not found" });

    const wallet = await db.query(
      "SELECT COALESCE(coins,0) as coins, COALESCE(gems,0) as gems FROM students WHERE id=$1", [sid]
    );
    const { coins, gems } = wallet.rows[0];

    if (skill.cost.gems) {
      const total = skill.cost.gems * qty;
      if (gems < total) return res.status(400).json({ error: "Insufficient tokens" });
      // FIX: use parameterized query — was vulnerable to SQL injection via template literal
      await db.query("UPDATE students SET gems = gems - $1 WHERE id=$2", [total, sid]);
    } else {
      const total = skill.cost.coins * qty;
      if (coins < total) return res.status(400).json({ error: "Insufficient coins" });
      await db.query("UPDATE students SET coins = coins - $1 WHERE id=$2", [total, sid]);
    }
    await db.query(
      `INSERT INTO student_skills (student_id, skill_id, quantity)
       VALUES ($1,$2,$3)
       ON CONFLICT (student_id, skill_id)
       DO UPDATE SET quantity = student_skills.quantity + $3`,
      [sid, skill_id, qty]
    ).catch(() => {});

    const newWallet = await db.query(
      "SELECT COALESCE(coins,0) as coins, COALESCE(gems,0) as gems FROM students WHERE id=$1", [sid]
    );

    res.json({
      success: true,
      skill_id,
      quantity_added: qty,
      coins: newWallet.rows[0]?.coins || 0,
      gems:  newWallet.rows[0]?.gems  || 0,
      message: `${skill.name} ×${qty} purchased!`,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── USE skill (consume 1 charge) ──────────────────────────
// Previously this only decremented the inventory counter and returned a
// static "effect" description string — it never actually DID anything to
// the exam (fifty_fifty didn't remove options, smart_hint didn't generate a
// hint, time_freeze had nothing to pause). Skills purchased in the shop had
// zero effect in exam logic. This now actually computes the effect for the
// skills that need server-side data (fifty_fifty needs the correct answer,
// smart_hint needs an AI call) so the frontend can apply it for real.
exports.useSkill = async (req, res) => {
  try {
    const { skill_id, question_id } = req.body;
    const sid = req.student.id;

    const { rows } = await db.query(
      "SELECT quantity FROM student_skills WHERE student_id=$1 AND skill_id=$2",
      [sid, skill_id]
    ).catch(() => ({ rows: [] }));

    if (!rows.length || rows[0].quantity < 1)
      return res.status(400).json({ error: "No charges remaining for this skill" });

    await db.query(
      "UPDATE student_skills SET quantity = quantity - 1 WHERE student_id=$1 AND skill_id=$2",
      [sid, skill_id]
    ).catch(() => {});

    const skill  = ALL_SKILLS.find(s => s.id === skill_id);
    const result = { success: true, skill_id, remaining: rows[0].quantity - 1, effect: skill?.effect };

    // ── fifty_fifty: eliminate 2 wrong options for the current question ──
    if (skill_id === "fifty_fifty") {
      if (!question_id) return res.status(400).json({ error: "question_id is required for this skill." });
      const q = await db.query("SELECT correct_answer FROM questions WHERE id=$1", [question_id]);
      if (!q.rows.length) return res.status(404).json({ error: "Question not found." });
      const correct = q.rows[0].correct_answer;
      const wrongOptions = ["A","B","C","D"].filter(o => o !== correct);
      // Shuffle and drop 2 of the 3 wrong options to hide
      const hide = wrongOptions.sort(() => Math.random() - 0.5).slice(0, 2);
      result.hide_options = hide;
    }

    // ── smart_hint: AI-generated clue that does NOT reveal the answer ──
    if (skill_id === "smart_hint") {
      if (!question_id) return res.status(400).json({ error: "question_id is required for this skill." });
      const q = await db.query("SELECT question, subject, topic FROM questions WHERE id=$1", [question_id]);
      if (!q.rows.length) return res.status(404).json({ error: "Question not found." });
      try {
        const { chatCompletion } = require("../utils/aiProvider");
        const completion = await chatCompletion({
          model: "openai/gpt-oss-20b",
          messages: [{
            role: "user",
            content: `You are a JAMB tutor. A student is stuck on this ${q.rows[0].subject || ""} question:\n"${q.rows[0].question}"\n\nGive ONE short, helpful hint (max 25 words) that nudges them toward the right approach WITHOUT stating or implying which option (A, B, C, or D) is correct.`,
          }],
          maxTokens: 80,
          temperature: 0.5,
          taskType: "quick", // student is mid-exam waiting on this — keep Groq-first speed, Gemini only as fallback
        });
        result.hint = completion.content?.trim() || "Think carefully about each option before deciding.";
      } catch (e) {
        console.error("smart_hint AI error:", e.message);
        result.hint = "Re-read the question carefully and eliminate options that clearly don't fit.";
      }
    }

    // ── time_freeze: purely a client-side timer pause, nothing to compute server-side ──

    res.json(result);
  } catch (err) {
    serverError(res, err);
  }
};

exports.ALL_SKILLS = ALL_SKILLS;
