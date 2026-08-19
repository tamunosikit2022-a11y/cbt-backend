const db = require("../config/db");
const { serverError } = require('../utils/errors');

// ── VAULT CATALOG ─────────────────────────────────────────
const VAULT_ITEMS = [
  {
    id: "formula_sheet_physics",
    title: "Physics Formula Sheet",
    subject: "Physics",
    icon: "⚛️",
    description: "All JAMB/WAEC physics formulas — electricity, mechanics, waves, optics",
    preview: "Includes 120+ formulas with worked examples",
    tags: ["JAMB", "WAEC", "Physics"],
    cost: { coins: 3000, gems: 30, naira: 100 },
    rarity: "common",
    pages: 12,
  },
  {
    id: "biology_summary",
    title: "Biology Summary Notes",
    subject: "Biology",
    icon: "🧬",
    description: "Comprehensive biology notes covering all JAMB topics",
    preview: "Cell biology, genetics, ecology, human anatomy",
    tags: ["JAMB", "Biology"],
    cost: { coins: 7000, gems: 70, naira: 300 },
    rarity: "rare",
    pages: 45,
  },
  {
    id: "chemistry_organic",
    title: "Organic Chemistry Guide",
    subject: "Chemistry",
    icon: "🧪",
    description: "Complete organic chemistry reactions and mechanisms",
    preview: "Functional groups, naming, reactions, isomerism",
    tags: ["JAMB", "WAEC", "Chemistry"],
    cost: { coins: 5000, gems: 50, naira: 200 },
    rarity: "rare",
    pages: 30,
  },
  {
    id: "maths_formulas",
    title: "Mathematics Formula Bank",
    subject: "Mathematics",
    icon: "📐",
    description: "Every formula you need for JAMB/WAEC Mathematics",
    preview: "Algebra, geometry, statistics, trigonometry",
    tags: ["JAMB", "WAEC", "Maths"],
    cost: { coins: 4000, gems: 40, naira: 150 },
    rarity: "common",
    pages: 20,
  },
  {
    id: "english_comprehension",
    title: "English Comprehension Mastery",
    subject: "English",
    icon: "📝",
    description: "Vocabulary, comprehension strategies, essay templates",
    preview: "500+ vocabulary words, passage tactics, model essays",
    tags: ["JAMB", "WAEC", "English"],
    cost: { coins: 4500, gems: 45, naira: 150 },
    rarity: "common",
    pages: 25,
  },
  {
    id: "economics_notes",
    title: "Economics Theory & Practice",
    subject: "Economics",
    icon: "💹",
    description: "Micro & macro economics for JAMB and WAEC",
    preview: "Supply/demand, market structures, national income",
    tags: ["JAMB", "WAEC", "Economics"],
    cost: { coins: 5500, gems: 55, naira: 200 },
    rarity: "rare",
    pages: 35,
  },
  {
    id: "elite_bundle",
    title: "Elite Exam Bundle",
    subject: "All Subjects",
    icon: "👑",
    description: "Complete study bundle for all major JAMB subjects",
    preview: "Physics + Chemistry + Biology + Maths + English in one pack",
    tags: ["JAMB", "WAEC", "Bundle"],
    cost: { coins: 15000, gems: 150, naira: 1000 },
    rarity: "legendary",
    pages: 150,
  },
  {
    id: "prediction_pack_2025",
    title: "2025 Prediction Pack",
    subject: "All Subjects",
    icon: "🔮",
    description: "AI-curated likely exam questions for 2025 based on trends",
    preview: "300 predicted questions with full explanations",
    tags: ["JAMB", "Predictions", "2025"],
    cost: { coins: 12000, gems: 120, naira: 800 },
    rarity: "epic",
    pages: 80,
  },
  {
    id: "flashcard_pack_biology",
    title: "Biology Flashcard Pack",
    subject: "Biology",
    icon: "🗂️",
    description: "200 digital flashcards for quick biology revision",
    preview: "Perfect for last-minute exam prep",
    tags: ["Biology", "Flashcards"],
    cost: { coins: 3500, gems: 35, naira: 150 },
    rarity: "common",
    pages: 40,
  },
];

const RARITY_ORDER = { common: 1, rare: 2, epic: 3, legendary: 4 };

// ── GET vault catalog + owned items ───────────────────────
exports.getVault = async (req, res) => {
  try {
    const sid = req.student.id;
    const [walletRes, ownedRes] = await Promise.all([
      db.query("SELECT COALESCE(coins,0) as coins, COALESCE(gems,0) as gems FROM students WHERE id=$1", [sid]),
      db.query("SELECT item_id FROM student_vault WHERE student_id=$1", [sid]).catch(() => ({ rows: [] })),
    ]);

    const owned = new Set(ownedRes.rows.map(r => r.item_id));
    const items = VAULT_ITEMS.map(item => ({ ...item, owned: owned.has(item.id) }));

    res.json({
      items,
      coins: walletRes.rows[0]?.coins || 0,
      gems:  walletRes.rows[0]?.gems  || 0,
      owned_count: owned.size,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── UNLOCK vault item ─────────────────────────────────────
exports.unlockItem = async (req, res) => {
  try {
    const { item_id, currency } = req.body; // currency: 'coins' | 'gems'
    const sid = req.student.id;

    const item = VAULT_ITEMS.find(v => v.id === item_id);
    if (!item) return res.status(400).json({ error: "Item not found" });

    // Check already owned
    const existing = await db.query(
      "SELECT id FROM student_vault WHERE student_id=$1 AND item_id=$2",
      [sid, item_id]
    ).catch(() => ({ rows: [] }));
    if (existing.rows.length) return res.status(400).json({ error: "Already owned" });

    const wallet = await db.query(
      "SELECT COALESCE(coins,0) as coins, COALESCE(gems,0) as gems FROM students WHERE id=$1", [sid]
    );
    const { coins, gems } = wallet.rows[0];

    if (currency === "gems") {
      if (gems < item.cost.gems) return res.status(400).json({ error: "Insufficient gems" });
      // Atomic deduct — prevents race condition double-spend
      const deductResult = await db.query(
        "UPDATE students SET gems = gems - $1 WHERE id=$2 AND gems >= $1 RETURNING id",
        [item.cost.gems, sid]
      );
      if (!deductResult.rows.length) return res.status(400).json({ error: "Insufficient gems" });
    } else {
      if (coins < item.cost.coins) return res.status(400).json({ error: "Insufficient coins" });
      // Atomic deduct — prevents race condition double-spend
      const deductResult = await db.query(
        "UPDATE students SET coins = coins - $1 WHERE id=$2 AND coins >= $1 RETURNING id",
        [item.cost.coins, sid]
      );
      if (!deductResult.rows.length) return res.status(400).json({ error: "Insufficient coins" });
    }

    await db.query(
      "INSERT INTO student_vault (student_id, item_id, unlocked_at) VALUES ($1,$2,NOW()) ON CONFLICT DO NOTHING",
      [sid, item_id]
    ).catch(() => {});

    const newWallet = await db.query(
      "SELECT COALESCE(coins,0) as coins, COALESCE(gems,0) as gems FROM students WHERE id=$1", [sid]
    );

    res.json({
      success: true,
      item_id,
      coins: newWallet.rows[0]?.coins || 0,
      gems:  newWallet.rows[0]?.gems  || 0,
      message: `${item.title} unlocked!`,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── GET owned items (student's library) ───────────────────
exports.getMyLibrary = async (req, res) => {
  try {
    const sid = req.student.id;
    const { rows } = await db.query(
      "SELECT item_id, unlocked_at FROM student_vault WHERE student_id=$1 ORDER BY unlocked_at DESC",
      [sid]
    ).catch(() => ({ rows: [] }));

    const owned = rows.map(r => {
      const item = VAULT_ITEMS.find(v => v.id === r.item_id);
      return item ? { ...item, owned: true, unlocked_at: r.unlocked_at } : null;
    }).filter(Boolean);

    res.json({ library: owned });
  } catch (err) {
    serverError(res, err);
  }
};

exports.VAULT_ITEMS = VAULT_ITEMS;
