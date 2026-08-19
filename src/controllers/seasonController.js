/**
 * seasonController.js — Scholars Syndicate
 * Monthly Arena seasons with ranked leaderboards and rewards.
 * Each season resets on the 1st of every month.
 *
 * Season ranks: Bronze → Silver → Gold → Platinum → Diamond → Legend
 */

const db   = require('../config/db');
const cron = require('node-cron');
const { serverError } = require('../utils/errors');

const RANKS = [
  { name:'Bronze',   min:0,    max:999,  icon:'🥉', color:'#cd7f32', reward_coins:50,  reward_tokens:5  },
  { name:'Silver',   min:1000, max:2499, icon:'🥈', color:'#c0c0c0', reward_coins:150, reward_tokens:15 },
  { name:'Gold',     min:2500, max:4999, icon:'🥇', color:'#ffd700', reward_coins:300, reward_tokens:30 },
  { name:'Platinum', min:5000, max:9999, icon:'💠', color:'#00b4d8', reward_coins:600, reward_tokens:60 },
  { name:'Diamond',  min:10000,max:19999,icon:'💎', color:'#a855f7', reward_coins:1200,reward_tokens:120 },
  { name:'Legend',   min:20000,max:Infinity,icon:'👑',color:'#f59e0b',reward_coins:3000,reward_tokens:300 },
];

function getRank(points) {
  return RANKS.findLast(r => points >= r.min) || RANKS[0];
}

// ── GET CURRENT SEASON ────────────────────────────────────
exports.getCurrentSeason = async (req, res) => {
  try {
    const now    = new Date();
    const year   = now.getFullYear();
    const month  = now.getMonth() + 1;
    const seasonId = `${year}-${String(month).padStart(2,'0')}`;

    // Ensure season row exists
    await db.query(`
      INSERT INTO seasons (season_id, year, month, started_at, ends_at)
      VALUES ($1,$2,$3, DATE_TRUNC('month', NOW()), DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 second')
      ON CONFLICT (season_id) DO NOTHING
    `, [seasonId, year, month]);

    // Student's own stats
    const myRes = await db.query(`
      SELECT season_points, wins, losses, draws
      FROM season_players
      WHERE season_id=$1 AND student_id=$2
    `, [seasonId, req.student.id]);

    const myPoints = parseInt(myRes.rows[0]?.season_points || 0);
    const myRank   = getRank(myPoints);

    // Top 50 for leaderboard
    const lbRes = await db.query(`
      SELECT sp.student_id, sp.season_points, sp.wins, sp.losses,
             s.full_name, s.avatar_url,
             RANK() OVER (ORDER BY sp.season_points DESC) AS position
      FROM season_players sp
      JOIN students s ON s.id = sp.student_id
      WHERE sp.season_id = $1
      ORDER BY sp.season_points DESC
      LIMIT 50
    `, [seasonId]);

    const season = {
      id:       seasonId,
      year,
      month,
      month_name: now.toLocaleString('en', { month:'long' }),
      ends_at:  new Date(year, month, 0, 23, 59, 59).toISOString(),
    };

    res.json({
      season,
      my_stats: {
        points: myPoints,
        wins:   parseInt(myRes.rows[0]?.wins   || 0),
        losses: parseInt(myRes.rows[0]?.losses || 0),
        draws:  parseInt(myRes.rows[0]?.draws  || 0),
        rank:   myRank,
        next_rank: RANKS[RANKS.indexOf(myRank) + 1] || null,
        points_to_next: myRank === RANKS[RANKS.length-1] ? 0 :
          (RANKS[RANKS.indexOf(myRank)+1].min - myPoints),
      },
      leaderboard: lbRes.rows.map(r => ({
        ...r,
        rank_info: getRank(parseInt(r.season_points)),
      })),
      ranks: RANKS,
    });
  } catch (err) {
    console.error('getCurrentSeason error:', err.message);
    serverError(res, err);
  }
};

// ── RECORD ARENA RESULT (called internally by arenaEngine) ─
exports.recordArenaResult = async (student_id, result, mode) => {
  try {
    const now     = new Date();
    const seasonId = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

    // Points per result
    const POINTS = {
      win:  { duel:50, lone_wolf:30, battle_royal:80, duo:40, clash_squad:60 },
      loss: { duel:-10, lone_wolf:-5, battle_royal:5, duo:-5, clash_squad:-5  },
      draw: { duel:15, lone_wolf:10, battle_royal:10, duo:15, clash_squad:20  },
    };

    const points = POINTS[result]?.[mode] ?? 0;
    const col    = result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws';

    // Get rank before update (for rank-up detection)
    const prevRow = await db.query(
      `SELECT COALESCE(season_points,0) as pts FROM season_players
       WHERE season_id=$1 AND student_id=$2`, [seasonId, student_id]
    ).catch(() => ({ rows: [{ pts: 0 }] }));
    const prevPts  = parseInt(prevRow.rows[0]?.pts || 0);
    const prevRank = getRank(prevPts);

    await db.query(`
      INSERT INTO season_players (season_id, student_id, season_points, wins, losses, draws)
      VALUES ($1,$2,$3, $4, $5, $6)
      ON CONFLICT (season_id, student_id)
      DO UPDATE SET
        season_points = GREATEST(0, season_players.season_points + $3),
        ${col}        = season_players.${col} + 1,
        last_played   = NOW()
    `, [seasonId, student_id, points,
        result==='win'?1:0, result==='loss'?1:0, result==='draw'?1:0]);

    // ── Upgrade: detect rank-up → fire micro-interaction + update arena_rank_score
    const newPts  = Math.max(0, prevPts + points);
    const newRank = getRank(newPts);

    await db.query(
      `UPDATE students SET arena_rank_score=$1 WHERE id=$2`, [newPts, student_id]
    ).catch(() => {});

    // ── Upgrade: update season_tier (every 1000 points = 1 tier, max 20)
    const tier = Math.min(20, Math.floor(newPts / 1000));
    await db.query(
      `UPDATE students SET season_tier = GREATEST(COALESCE(season_tier,0), $1) WHERE id=$2`,
      [tier, student_id]
    ).catch(() => {});

    if (newRank.name !== prevRank.name && newPts > prevPts) {
      // Rank up! Fire micro-interaction
      try {
        const { fxRankUp } = require('./microController');
        const io = global.io; // set global.io = io in server.js
        if (io) fxRankUp(io, student_id, { rankName: newRank.name, rankIcon: newRank.icon, prevRank: prevRank.name });
      } catch {}
    }
  } catch (err) {
    console.error('recordArenaResult error:', err.message);
  }
};

// ── END-OF-SEASON REWARD DISTRIBUTION (run 1st of each month) ─
exports.distributeSeasonRewards = async () => {
  const now = new Date();
  // Get last month's season
  const d  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const seasonId = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

  try {
    const players = await db.query(`
      SELECT student_id, season_points
      FROM season_players WHERE season_id=$1 AND season_points > 0
      ORDER BY season_points DESC
    `, [seasonId]);

    for (const { student_id, season_points } of players.rows) {
      const rank = getRank(parseInt(season_points));
      // Credit coins and tokens
      await db.query(`
        UPDATE students
        SET coins = COALESCE(coins,0) + $1,
            token_balance = COALESCE(token_balance,0) + $2
        WHERE id = $3
      `, [rank.reward_coins, rank.reward_tokens, student_id]);
    }

    console.log(`✅ Season ${seasonId} rewards distributed to ${players.rows.length} players`);
  } catch (err) {
    console.error('distributeSeasonRewards error:', err.message);
  }
};

// ── GET SEASON HISTORY ────────────────────────────────────
exports.getSeasonHistory = async (req, res) => {
  try {
    const res2 = await db.query(`
      SELECT sp.season_id, sp.season_points, sp.wins, sp.losses, sp.draws,
             s.month_name,
             RANK() OVER (PARTITION BY sp.season_id ORDER BY sp.season_points DESC) AS final_position
      FROM season_players sp
      JOIN seasons s ON s.season_id = sp.season_id
      WHERE sp.student_id = $1
      ORDER BY sp.season_id DESC
      LIMIT 6
    `, [req.student.id]);

    res.json({
      history: res2.rows.map(r => ({
        ...r,
        rank_info: getRank(parseInt(r.season_points)),
      })),
    });
  } catch (err) {
    serverError(res, err);
  }
};
