/**
 * TREASURE CHEST SYSTEM
 * ─────────────────────────────────────────────────────────
 * From the Innovation Doc: "treasure chests" listed under
 * Daily Reward Systems alongside streaks, login bonuses,
 * missions, and seasonal rewards.
 *
 * Chest Tiers:
 *   Common  — free, earned every 24h login
 *   Silver  — earned every 3-day streak
 *   Gold    — earned every 7-day streak
 *   Diamond — earned every 30-day streak OR tournament win
 *   Mythic  — earned from legendary events only
 *
 * Each chest contains 2–5 rewards drawn from a loot table.
 * Opening animation is triggered via microController (fxChestOpen).
 */

const db = require('../config/db');
const { fxChestOpen } = require('./microController');
const { serverError } = require('../utils/errors');

// ── LOOT TABLES ───────────────────────────────────────────

const LOOT_TABLES = {
  common: {
    color:    '#A0AEC0',
    icon:     '📦',
    label:    'Common Chest',
    minItems: 2,
    maxItems: 3,
    pool: [
      { type: 'coins',  rarity: 'common',    weight: 50, value: () => rand(50, 150) },
      { type: 'coins',  rarity: 'common',    weight: 20, value: () => rand(150, 300) },
      { type: 'xp',     rarity: 'common',    weight: 20, value: () => rand(30, 80) },
      { type: 'gems',   rarity: 'rare',      weight: 8,  value: () => rand(5, 15) },
      { type: 'spin',   rarity: 'rare',      weight: 2,  value: () => 1 },
    ],
  },
  silver: {
    color:    '#CBD5E0',
    icon:     '🥈',
    label:    'Silver Chest',
    minItems: 2,
    maxItems: 3,
    pool: [
      { type: 'coins',  rarity: 'common',    weight: 35, value: () => rand(200, 500) },
      { type: 'xp',     rarity: 'common',    weight: 25, value: () => rand(80, 200) },
      { type: 'gems',   rarity: 'rare',      weight: 25, value: () => rand(10, 30) },
      { type: 'spin',   rarity: 'rare',      weight: 10, value: () => 1 },
      { type: 'boost',  rarity: 'rare',      weight: 5,  value: () => 'double_xp' },
    ],
  },
  gold: {
    color:    '#FFC857',
    icon:     '🥇',
    label:    'Gold Chest',
    minItems: 3,
    maxItems: 4,
    pool: [
      { type: 'coins',  rarity: 'rare',      weight: 30, value: () => rand(500, 1500) },
      { type: 'gems',   rarity: 'rare',      weight: 25, value: () => rand(25, 75) },
      { type: 'xp',     rarity: 'rare',      weight: 20, value: () => rand(200, 500) },
      { type: 'spin',   rarity: 'epic',      weight: 10, value: () => 2 },
      { type: 'boost',  rarity: 'epic',      weight: 10, value: () => pickOne(['double_xp','coin_magnet','rank_shield']) },
      { type: 'event_token', rarity: 'epic', weight: 5,  value: () => rand(2, 5) },
    ],
  },
  diamond: {
    color:    '#63B3ED',
    icon:     '💎',
    label:    'Diamond Chest',
    minItems: 3,
    maxItems: 5,
    pool: [
      { type: 'coins',  rarity: 'epic',      weight: 20, value: () => rand(1500, 4000) },
      { type: 'gems',   rarity: 'epic',      weight: 25, value: () => rand(75, 200) },
      { type: 'xp',     rarity: 'epic',      weight: 15, value: () => rand(500, 1500) },
      { type: 'spin',   rarity: 'legendary', weight: 15, value: () => rand(2, 5) },
      { type: 'boost',  rarity: 'legendary', weight: 15, value: () => pickOne(['rank_shield','streak_shield','double_xp','coin_magnet']) },
      { type: 'event_token', rarity: 'legendary', weight: 10, value: () => rand(5, 10) },
    ],
  },
  mythic: {
    color:    '#9B59B6',
    icon:     '🌌',
    label:    'Mythic Chest',
    minItems: 4,
    maxItems: 5,
    pool: [
      { type: 'coins',  rarity: 'legendary', weight: 15, value: () => rand(5000, 15000) },
      { type: 'gems',   rarity: 'legendary', weight: 25, value: () => rand(200, 500) },
      { type: 'xp',     rarity: 'mythic',    weight: 15, value: () => rand(2000, 5000) },
      { type: 'spin',   rarity: 'mythic',    weight: 15, value: () => rand(5, 10) },
      { type: 'boost',  rarity: 'mythic',    weight: 15, value: () => pickOne(['rank_shield','streak_shield','double_xp']) },
      { type: 'event_token', rarity: 'mythic', weight: 15, value: () => rand(10, 20) },
    ],
  },
};

// Streak milestone → chest type
function chestForStreak(streak) {
  if (streak >= 30) return 'diamond';
  if (streak >= 7)  return 'gold';
  if (streak >= 3)  return 'silver';
  return 'common';
}

// ── LOOT ROLLER ───────────────────────────────────────────

function rollChest(tier) {
  const table   = LOOT_TABLES[tier] || LOOT_TABLES.common;
  const count   = rand(table.minItems, table.maxItems);
  const rewards = [];

  for (let i = 0; i < count; i++) {
    const item  = weightedPick(table.pool);
    const value = item.value();
    rewards.push({
      type:   item.type,
      rarity: item.rarity,
      value,
      label:  formatReward(item.type, value),
    });
  }

  return { tier, ...table, rewards };
}

function weightedPick(pool) {
  const total = pool.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of pool) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}

function formatReward(type, value) {
  switch (type) {
    case 'coins':       return `${value} Coins`;
    case 'gems':        return `${value} Gems`;
    case 'xp':         return `${value} XP`;
    case 'spin':       return `${value} Spin${value > 1 ? 's' : ''}`;
    case 'boost':      return `Boost: ${value}`;
    case 'event_token':return `${value} Event Token${value > 1 ? 's' : ''}`;
    default:           return String(value);
  }
}

// ── APPLY REWARDS ─────────────────────────────────────────

async function applyChestRewards(studentId, rewards) {
  let coins = 0, gems = 0, xp = 0;
  const boosts = [];

  for (const r of rewards) {
    if      (r.type === 'coins')       coins       += r.value;
    else if (r.type === 'gems')        gems        += r.value;
    else if (r.type === 'xp')          xp          += r.value;
    else if (r.type === 'event_token') {
      await db.query(
        `UPDATE students SET event_spin_tokens=COALESCE(event_spin_tokens,0)+$1 WHERE id=$2`,
        [r.value, studentId]
      ).catch(() => {});
    }
    else if (r.type === 'boost') {
      boosts.push(r.value);
      await db.query(
        `INSERT INTO student_skills (student_id, skill_id, quantity)
         VALUES ($1,$2,1)
         ON CONFLICT (student_id, skill_id) DO UPDATE
           SET quantity = student_skills.quantity + 1`,
        [studentId, r.value]
      ).catch(() => {});
    }
    else if (r.type === 'spin') {
      await db.query(
        `UPDATE students SET extra_spins=COALESCE(extra_spins,0)+$1 WHERE id=$2`,
        [r.value, studentId]
      ).catch(() => {});
    }
  }

  if (coins || gems || xp) {
    await db.query(
      `UPDATE students SET
         coins  = COALESCE(coins,0)  + $1,
         gems   = COALESCE(gems,0)   + $2,
         points = COALESCE(points,0) + $3
       WHERE id = $4`,
      [coins, gems, xp, studentId]
    ).catch(() => {});
  }

  return { coins, gems, xp, boosts };
}

// ── REST ENDPOINTS ────────────────────────────────────────

// GET /api/chests/available
exports.getAvailableChests = async (req, res) => {
  try {
    const sid = req.student.id;

    // Unclaimed chests in the student_chests table
    const { rows } = await db.query(
      `SELECT id, tier, source, earned_at
       FROM student_chests
       WHERE student_id=$1 AND opened=false
       ORDER BY earned_at ASC`,
      [sid]
    ).catch(() => ({ rows: [] }));

    const chests = rows.map(r => ({
      id:       r.id,
      tier:     r.tier,
      source:   r.source,
      earnedAt: r.earned_at,
      ...LOOT_TABLES[r.tier] || LOOT_TABLES.common,
      rewards:  undefined,   // don't reveal contents before opening
    }));

    res.json({ chests, count: chests.length });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/chests/:id/open
exports.openChest = async (req, res) => {
  try {
    const sid     = req.student.id;
    const io      = req.app.get('io');
    const chestId = parseInt(req.params.id);

    const chest = await db.query(
      `SELECT * FROM student_chests WHERE id=$1 AND student_id=$2 AND opened=false`,
      [chestId, sid]
    ).then(r => r.rows[0]);
    if (!chest) return res.status(404).json({ error: 'Chest not found or already opened.' });

    // Roll rewards
    const result = rollChest(chest.tier);

    // Mark as opened
    await db.query(
      `UPDATE student_chests SET opened=true, opened_at=NOW(), rewards_json=$1 WHERE id=$2`,
      [JSON.stringify(result.rewards), chestId]
    );

    // Apply rewards to student account
    const totals = await applyChestRewards(sid, result.rewards);

    // Fire micro-interaction
    fxChestOpen(io, sid, { rewards: result.rewards, chestType: chest.tier });

    res.json({
      success: true,
      chest:   { tier: result.tier, label: result.label, icon: result.icon, color: result.color },
      rewards: result.rewards,
      totals,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/chests/claim-daily
// Called once per day on login — awards the daily common chest
exports.claimDailyChest = async (req, res) => {
  try {
    const sid = req.student.id;

    // Check if already claimed today
    const alreadyClaimed = await db.query(
      `SELECT id FROM student_chests
       WHERE student_id=$1 AND source='daily' AND earned_at::date = CURRENT_DATE`,
      [sid]
    ).then(r => r.rows.length > 0).catch(() => false);

    if (alreadyClaimed) return res.status(400).json({ error: 'Daily chest already claimed.' });

    // Get streak to determine chest tier
    const streakRow = await db.query(
      `SELECT COALESCE(current_streak,0) as streak FROM streaks WHERE student_id=$1`, [sid]
    ).catch(() => ({ rows: [{ streak: 0 }] }));
    const streak = parseInt(streakRow.rows[0]?.streak || 0);
    const tier   = chestForStreak(streak);

    // Insert chest then immediately open it so rewards apply on claim
    const inserted = await db.query(
      `INSERT INTO student_chests (student_id, tier, source) VALUES ($1,$2,'daily') RETURNING id`,
      [sid, tier]
    );
    const chestId = inserted.rows[0].id;

    // Roll & apply rewards immediately
    const rolled  = rollChest(tier);
    await db.query(
      `UPDATE student_chests SET opened=true, opened_at=NOW(), rewards_json=$1 WHERE id=$2`,
      [JSON.stringify(rolled.rewards), chestId]
    );
    const totals = await applyChestRewards(sid, rolled.rewards);

    // Fire FX
    const io = req.app.get('io');
    fxChestOpen(io, sid, { rewards: rolled.rewards, chestType: tier });

    res.json({
      success:     true,
      chestId,
      tier,
      icon:        LOOT_TABLES[tier].icon,
      label:       LOOT_TABLES[tier].label,
      color:       LOOT_TABLES[tier].color,
      rewards:     rolled.rewards,
      totals,
      streakBonus: tier !== 'common',
      message:     tier !== 'common'
        ? `🔥 ${streak}-day streak! You earned a ${LOOT_TABLES[tier].label}!`
        : `📦 Daily chest opened! You got ${totals.coins ? totals.coins + ' coins' : ''}${totals.gems ? ' + ' + totals.gems + ' gems' : ''}!`,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// Used by other controllers to award chests as prizes
exports.awardChest = async (studentId, tier = 'common', source = 'reward') => {
  await db.query(
    `INSERT INTO student_chests (student_id, tier, source) VALUES ($1,$2,$3)`,
    [studentId, tier, source]
  ).catch(err => console.error('awardChest error:', err.message));
};

// ── HELPERS ───────────────────────────────────────────────
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pickOne(arr)   { return arr[Math.floor(Math.random() * arr.length)]; }

module.exports = {
  LOOT_TABLES,
  chestForStreak,
  rollChest,
  awardChest:         exports.awardChest,
  getAvailableChests: exports.getAvailableChests,
  openChest:          exports.openChest,
  claimDailyChest:    exports.claimDailyChest,
};
