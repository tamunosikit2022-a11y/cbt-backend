const db = require("../config/db");
const { serverError } = require('../utils/errors');

// ── Spin rewards pool ─────────────────────────────────────
const REWARDS = [
  { type:"coins",  value:"50",   label:"+50 Coins",    weight:25, color:"#FFC857" },
  { type:"coins",  value:"100",  label:"+100 Coins",   weight:20, color:"#FFC857" },
  { type:"coins",  value:"200",  label:"+200 Coins",   weight:10, color:"#FFC857" },
  { type:"coins",  value:"20",   label:"+20 Coins",    weight:20, color:"#FFC857" },
  { type:"gems",   value:"5",    label:"+5 Tokens",    weight:10, color:"#00D4FF" },
  { type:"gems",   value:"15",   label:"+15 Tokens",   weight:5,  color:"#00D4FF" },
  { type:"gems",   value:"50",   label:"+50 Tokens",   weight:2,  color:"#00D4FF" },
  { type:"xp",     value:"100",  label:"+100 XP",      weight:15, color:"#7C5CFF" },
  { type:"xp",     value:"250",  label:"+250 XP",      weight:8,  color:"#7C5CFF" },
  { type:"boost",  value:"xp2x", label:"2× XP Boost",  weight:3,  color:"#00D084" },
  { type:"boost",  value:"coin2x",label:"2× Coins",    weight:2,  color:"#00D084" },
];

function pickReward() {
  const total = REWARDS.reduce((s, r) => s + r.weight, 0);
  let rand = Math.random() * total;
  for (const r of REWARDS) {
    rand -= r.weight;
    if (rand <= 0) return r;
  }
  return REWARDS[0];
}

// ── GET spin status ───────────────────────────────────────
exports.getSpinStatus = async (req, res) => {
  try {
    // Try with last_spin2_at first, fall back if column doesn't exist yet
    let rows;
    try {
      ({ rows } = await db.query(
        `SELECT last_spin_at, last_spin2_at, COALESCE(coins,0) as coins, COALESCE(gems,0) as gems, is_premium
         FROM students WHERE id=$1`,
        [req.student.id]
      ));
    } catch (colErr) {
      // Column doesn't exist yet — query without it
      ({ rows } = await db.query(
        `SELECT last_spin_at, COALESCE(coins,0) as coins, COALESCE(gems,0) as gems, is_premium
         FROM students WHERE id=$1`,
        [req.student.id]
      ));
    }
    const student   = rows[0];
    const now       = new Date();

    // Spin 1 — free daily
    const lastSpin  = student?.last_spin_at;
    const next1     = lastSpin ? new Date(new Date(lastSpin).getTime() + 24*60*60*1000) : now;
    const canSpin1  = !lastSpin || now >= next1;

    // Spin 2 — available to everyone (costs 1 token)
    const lastSpin2 = student?.last_spin2_at;
    const next2     = lastSpin2 ? new Date(new Date(lastSpin2).getTime() + 24*60*60*1000) : now;
    const canSpin2  = !lastSpin2 || now >= next2;

    const canSpin   = canSpin1 || canSpin2;
    const msUntil   = canSpin ? 0 : Math.min(
      canSpin1 ? 0 : next1 - now,
      canSpin2 ? 0 : next2 - now
    );

    res.json({
      canSpin,
      msUntil,
      spinsLeft: (canSpin1 ? 1 : 0) + (canSpin2 ? 1 : 0),
      spin2CostsToken: !canSpin1 && canSpin2,
      coins: student?.coins || 0,
      gems:  student?.gems  || 0,
      rewards: REWARDS.map(r => ({ type:r.type, label:r.label, color:r.color })),
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── DO spin ───────────────────────────────────────────────
exports.doSpin = async (req, res) => {
  try {
    const sid = req.student.id;

    // Check cooldown — pick which spin slot to use
    let rows;
    try {
      ({ rows } = await db.query(
        `SELECT last_spin_at, last_spin2_at, is_premium FROM students WHERE id=$1`, [sid]
      ));
    } catch (colErr) {
      ({ rows } = await db.query(
        `SELECT last_spin_at, is_premium FROM students WHERE id=$1`, [sid]
      ));
    }
    const student   = rows[0];
    const now       = new Date();

    const lastSpin  = student?.last_spin_at;
    const lastSpin2 = student?.last_spin2_at;
    const canSpin1  = !lastSpin  || now >= new Date(new Date(lastSpin).getTime()  + 24*60*60*1000);
    const canSpin2  = !lastSpin2 || now >= new Date(new Date(lastSpin2).getTime() + 24*60*60*1000);

    if (!canSpin1 && !canSpin2) {
      return res.status(400).json({ error: "Already spun today. Come back tomorrow!" });
    }

    // Use spin slot 1 first (free); slot 2 costs 1 token
    const hasSlot2   = 'last_spin2_at' in (student || {});
    const useSlot2   = !canSpin1 && canSpin2 && hasSlot2;

    // Guard: if column doesn't exist, block second spin gracefully
    if (!canSpin1 && !hasSlot2) {
      return res.status(400).json({ error: "Already spun today. Come back tomorrow!", code: "NO_SPINS" });
    }

    const spinField  = useSlot2 ? "last_spin2_at" : "last_spin_at";

    // Charge token for second spin — AFTER confirming column exists
    if (useSlot2) {
      const { spendTokens } = require('./tokenController');
      try {
        await spendTokens(sid, 'extra_spin');
      } catch (tokenErr) {
        if (tokenErr.code === 'INSUFFICIENT_TOKENS') {
          return res.status(400).json({ error: "Your free spin is used up. Buy tokens for an extra spin — 1 token per spin!", code: "INSUFFICIENT_TOKENS" });
        }
        throw tokenErr;
      }
    }

    const reward = pickReward();

    // Award the reward — gems type now credits token_balance (unified currency)
    let updateSQL = `UPDATE students SET ${spinField}=NOW()`;
    if      (reward.type === "coins")  updateSQL += `, coins=COALESCE(coins,0)+${parseInt(reward.value)}`;
    else if (reward.type === "gems")   updateSQL += `, token_balance=COALESCE(token_balance,0)+${parseInt(reward.value)}`;
    else if (reward.type === "tokens") updateSQL += `, token_balance=COALESCE(token_balance,0)+${parseInt(reward.value)}`;
    else if (reward.type === "xp")     updateSQL += `, points=COALESCE(points,0)+${parseInt(reward.value)}`;
    else if (reward.type === "boost") {
      await db.query(
        `INSERT INTO student_boosts (student_id, boost_type, multiplier, expires_at)
         VALUES ($1,$2,$3,NOW()+INTERVAL '24 hours')`,
        [sid, reward.value, 2.0]
      ).catch(()=>{});
    }
    updateSQL += " WHERE id=$1";
    await db.query(updateSQL, [sid]);

    // Log spin
    await db.query(
      `INSERT INTO spin_history (student_id,reward_type,reward_value)
       VALUES ($1,$2,$3)`,
      [sid, reward.type, reward.value]
    );

    // ── Upgrade: also log to spin_results for event token tracking
    await db.query(
      `INSERT INTO spin_results (student_id, prize_label, prize_type, prize_rarity, source, spun_at)
       VALUES ($1,$2,$3,$4,'regular',NOW())`,
      [sid, reward.label, reward.type, reward.rarity || 'common']
    ).catch(() => {});

    // ── Upgrade: every 3rd regular spin earns 1 event spin token
    const spinCount = await db.query(
      `SELECT COUNT(*) as cnt FROM spin_results WHERE student_id=$1 AND source='regular'`, [sid]
    ).then(r => parseInt(r.rows[0]?.cnt || 0)).catch(() => 0);
    if (spinCount % 3 === 0) {
      await db.query(
        `UPDATE students SET event_spin_tokens=COALESCE(event_spin_tokens,0)+1 WHERE id=$1`, [sid]
      ).catch(() => {});
    }

    // Get updated balance
    const updated = await db.query(
      `SELECT COALESCE(coins,0) as coins, COALESCE(gems,0) as gems,
              COALESCE(points,0) as points,
              COALESCE(event_spin_tokens,0) as event_tokens
       FROM students WHERE id=$1`, [sid]
    );

    // ── Upgrade: micro-interaction — spin win FX
    try {
      const { fxSpinWin } = require('./microController');
      const io = req.app?.get('io');
      if (io) fxSpinWin(io, sid, { reward: reward.label, rarity: reward.rarity || 'common' });
    } catch {}

    // FIX BUG 15: Send both rewardIndex AND rewardLabel
    res.json({
      success: true,
      reward: { ...reward, rewardIndex: REWARDS.indexOf(reward), rewardLabel: reward.label },
      coins:       updated.rows[0]?.coins        || 0,
      gems:        updated.rows[0]?.gems         || 0,
      points:      updated.rows[0]?.points       || 0,
      eventTokens: updated.rows[0]?.event_tokens || 0,
    });
  } catch (err) {
    serverError(res, err);
  }
};
