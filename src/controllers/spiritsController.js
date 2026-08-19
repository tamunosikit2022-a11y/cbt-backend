const db = require("../config/db");
const { serverError } = require('../utils/errors');

// ── SPIRIT CATALOG ────────────────────────────────────────
const SPIRITS = [
  {
    id: "void_weaver",
    name: "Void Weaver",
    icon: "🕷️",
    rarity: "epic",
    element: "Shadow",
    description: "A cyber spider weaving traps across the arena",
    passive: { label: "+5% Arena confusion resistance", stat: "arena_resist", value: 5 },
    active: { name: "WEB TRAP", desc: "Blurs opponent buttons temporarily in Arena" },
    evolutions: ["Baby Spider", "Void Weaver", "Shadow Weaver", "Cosmic Spider"],
    cost: { coins: 8000, gems: 0 },
    effects: { glow: "#8B5CF6", trail: "purple" },
  },
  {
    id: "oracle_owl",
    name: "Oracle Owl",
    icon: "🦉",
    rarity: "legendary",
    element: "Light",
    description: "Ancient wisdom sealed in glowing golden eyes",
    passive: { label: "+10% Study XP", stat: "study_xp", value: 10 },
    active: { name: "FORESIGHT", desc: "Reveals a hint or removes one wrong answer" },
    evolutions: ["Baby Owl", "Oracle Owl", "Cosmic Owl", "Celestial Owl"],
    cost: { coins: 0, gems: 80 },
    effects: { glow: "#FFC857", trail: "gold" },
  },
  {
    id: "ember_wyrm",
    name: "Ember Wyrm",
    icon: "🐉",
    rarity: "mythic",
    element: "Fire",
    description: "A neon dragon breathing crypto-fire",
    passive: { label: "+20% Coin gain", stat: "coin_bonus", value: 20 },
    active: { name: "INFERNO BOOST", desc: "Grants 2× XP and coin multiplier for 3 mins" },
    evolutions: ["Baby Wyrm", "Ember Wyrm", "Inferno Drake", "Void Dragon"],
    cost: { coins: 0, gems: 150 },
    effects: { glow: "#FF6B35", trail: "fire" },
  },
  {
    id: "neuro_bot",
    name: "Neuro Bot",
    icon: "🤖",
    rarity: "rare",
    element: "Tech",
    description: "AI-powered study companion with laser precision",
    passive: { label: "Faster AI hint recharge", stat: "hint_speed", value: 30 },
    active: { name: "TARGET ANALYSIS", desc: "Highlights weakest answer choices in red" },
    evolutions: ["Nano Bot", "Neuro Bot", "Cyber Bot", "Quantum Bot"],
    cost: { coins: 5000, gems: 0 },
    effects: { glow: "#00D4FF", trail: "cyan" },
  },
  {
    id: "storm_fox",
    name: "Storm Fox",
    icon: "🦊",
    rarity: "rare",
    element: "Lightning",
    description: "Quick as lightning, sharp as thunder",
    passive: { label: "+8% Arena speed bonus", stat: "arena_speed", value: 8 },
    active: { name: "THUNDER DASH", desc: "Speeds up your answer timer briefly" },
    evolutions: ["Kit Fox", "Storm Fox", "Thunder Fox", "Celestial Fox"],
    cost: { coins: 6000, gems: 0 },
    effects: { glow: "#FBBF24", trail: "yellow" },
  },
  {
    id: "crystal_phoenix",
    name: "Crystal Phoenix",
    icon: "🦅",
    rarity: "legendary",
    element: "Crystal",
    description: "Reborn from shattered gems, eternal and radiant",
    passive: { label: "+15% Gem bonus on events", stat: "gem_bonus", value: 15 },
    active: { name: "REBIRTH FLAME", desc: "Revives you once per Arena match at 1HP" },
    evolutions: ["Hatchling", "Crystal Phoenix", "Radiant Phoenix", "Eternal Phoenix"],
    cost: { coins: 0, gems: 120 },
    effects: { glow: "#00D084", trail: "emerald" },
  },
  {
    id: "shadow_lynx",
    name: "Shadow Lynx",
    icon: "🐱",
    rarity: "common",
    element: "Shadow",
    description: "Elusive and cunning, strikes from the dark",
    passive: { label: "+3% Streak protection", stat: "streak_shield", value: 3 },
    active: { name: "SHADOW STEP", desc: "Skips one failed question without streak break" },
    evolutions: ["Shadow Kitten", "Shadow Lynx", "Night Lynx", "Void Lynx"],
    cost: { coins: 2000, gems: 0 },
    effects: { glow: "#6B7280", trail: "smoke" },
  },
  {
    id: "aqua_serpent",
    name: "Aqua Serpent",
    icon: "🐍",
    rarity: "epic",
    element: "Water",
    description: "Fluid wisdom, coiled and ready to strike",
    passive: { label: "+12% Exam accuracy bonus", stat: "accuracy", value: 12 },
    active: { name: "HYDRO SURGE", desc: "Clears all active debuffs in Arena" },
    evolutions: ["Water Snake", "Aqua Serpent", "Tidal Serpent", "Leviathan"],
    cost: { coins: 0, gems: 60 },
    effects: { glow: "#38BDF8", trail: "water" },
  },
];

const RARITY_ORDER = { common: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };

// ── GET all spirits + owned ───────────────────────────────
exports.getSpirits = async (req, res) => {
  try {
    const sid = req.student.id;
    const [walletRes, ownedRes] = await Promise.all([
      db.query("SELECT COALESCE(coins,0) as coins, COALESCE(gems,0) as gems FROM students WHERE id=$1", [sid]),
      db.query("SELECT spirit_id, evolution_stage, xp, equipped FROM student_spirits WHERE student_id=$1", [sid]).catch(() => ({ rows: [] })),
    ]);

    const owned    = {};
    let   equipped = null;
    ownedRes.rows.forEach(r => {
      owned[r.spirit_id] = r;
      if (r.equipped) equipped = r.spirit_id;
    });

    const catalog = SPIRITS.map(s => ({
      ...s,
      owned:           !!owned[s.id],
      evolution_stage: owned[s.id]?.evolution_stage || 0,
      spirit_xp:       owned[s.id]?.xp || 0,
      equipped:        equipped === s.id,
    })).sort((a, b) => (RARITY_ORDER[b.rarity] || 0) - (RARITY_ORDER[a.rarity] || 0));

    res.json({
      spirits:  catalog,
      equipped,
      coins:    walletRes.rows[0]?.coins || 0,
      gems:     walletRes.rows[0]?.gems  || 0,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── UNLOCK spirit ─────────────────────────────────────────
exports.unlockSpirit = async (req, res) => {
  try {
    const { spirit_id, currency } = req.body; // currency: 'coins' | 'gems'
    const sid = req.student.id;

    const spirit = SPIRITS.find(s => s.id === spirit_id);
    if (!spirit) return res.status(400).json({ error: "Spirit not found" });

    // Check already owned
    const existing = await db.query(
      "SELECT id FROM student_spirits WHERE student_id=$1 AND spirit_id=$2",
      [sid, spirit_id]
    ).catch(() => ({ rows: [] }));
    if (existing.rows.length) return res.status(400).json({ error: "Spirit already owned" });

    // Deduct currency
    const wallet = await db.query(
      "SELECT COALESCE(coins,0) as coins, COALESCE(gems,0) as gems FROM students WHERE id=$1", [sid]
    );
    const { coins, gems } = wallet.rows[0];

    if (currency === "gems") {
      if (!spirit.cost.gems) return res.status(400).json({ error: "This spirit requires coins" });
      if (gems < spirit.cost.gems) return res.status(400).json({ error: "Insufficient tokens" });
      const drG = await db.query(
        "UPDATE students SET gems = gems - $1 WHERE id=$2 AND gems >= $1 RETURNING id",
        [spirit.cost.gems, sid]
      );
      if (!drG.rows.length) return res.status(400).json({ error: "Insufficient tokens" });
    } else {
      if (!spirit.cost.coins) return res.status(400).json({ error: "This spirit requires tokens" });
      if (coins < spirit.cost.coins) return res.status(400).json({ error: "Insufficient coins" });
      const drC = await db.query(
        "UPDATE students SET coins = coins - $1 WHERE id=$2 AND coins >= $1 RETURNING id",
        [spirit.cost.coins, sid]
      );
      if (!drC.rows.length) return res.status(400).json({ error: "Insufficient coins" });
    }

    // Add to collection
    await db.query(
      `INSERT INTO student_spirits (student_id, spirit_id, evolution_stage, xp, equipped)
       VALUES ($1,$2,0,0,false)`,
      [sid, spirit_id]
    ).catch(() => {});

    res.json({ success: true, spirit_id, message: `${spirit.name} unlocked!` });
  } catch (err) {
    serverError(res, err);
  }
};

// ── EQUIP spirit ──────────────────────────────────────────
exports.equipSpirit = async (req, res) => {
  try {
    const { spirit_id } = req.body;
    const sid = req.student.id;

    // Verify owned
    const { rows } = await db.query(
      "SELECT id FROM student_spirits WHERE student_id=$1 AND spirit_id=$2",
      [sid, spirit_id]
    ).catch(() => ({ rows: [] }));
    if (!rows.length) return res.status(400).json({ error: "Spirit not owned" });

    // Unequip all, then equip selected
    await db.query("UPDATE student_spirits SET equipped=false WHERE student_id=$1", [sid]).catch(() => {});
    await db.query("UPDATE student_spirits SET equipped=true WHERE student_id=$1 AND spirit_id=$2", [sid, spirit_id]).catch(() => {});

    res.json({ success: true, equipped: spirit_id });
  } catch (err) {
    serverError(res, err);
  }
};

// ── FEED XP to spirit (evolve) ────────────────────────────
exports.feedSpirit = async (req, res) => {
  try {
    const { spirit_id } = req.body;
    const sid = req.student.id;

    const spirit = SPIRITS.find(s => s.id === spirit_id);
    if (!spirit) return res.status(400).json({ error: "Spirit not found" });

    const { rows } = await db.query(
      "SELECT xp, evolution_stage FROM student_spirits WHERE student_id=$1 AND spirit_id=$2",
      [sid, spirit_id]
    ).catch(() => ({ rows: [] }));
    if (!rows.length) return res.status(400).json({ error: "Spirit not owned" });

    const currentXP   = (rows[0].xp || 0) + 100; // feeding gives 100 XP
    const maxEvol     = spirit.evolutions.length - 1;
    const newStage    = Math.min(Math.floor(currentXP / 500), maxEvol);
    const evolved     = newStage > (rows[0].evolution_stage || 0);

    await db.query(
      "UPDATE student_spirits SET xp=$1, evolution_stage=$2 WHERE student_id=$3 AND spirit_id=$4",
      [currentXP, newStage, sid, spirit_id]
    ).catch(() => {});

    // Deduct 50 coins for feeding
    await db.query("UPDATE students SET coins=GREATEST(coins-50,0) WHERE id=$1", [sid]);

    res.json({
      success: true,
      xp: currentXP,
      evolution_stage: newStage,
      evolution_name: spirit.evolutions[newStage],
      evolved,
      message: evolved ? `${spirit.name} evolved into ${spirit.evolutions[newStage]}!` : "+100 Spirit XP",
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── GET equipped spirit for Arena/Exam (internal use) ─────
exports.getEquippedSpirit = async (student_id) => {
  try {
    const { rows } = await db.query(
      "SELECT spirit_id FROM student_spirits WHERE student_id=$1 AND equipped=true LIMIT 1",
      [student_id]
    ).catch(() => ({ rows: [] }));
    if (!rows.length) return null;
    return SPIRITS.find(s => s.id === rows[0].spirit_id) || null;
  } catch {
    return null;
  }
};

exports.SPIRITS = SPIRITS;
