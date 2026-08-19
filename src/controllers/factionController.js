const db = require("../config/db");
const { serverError } = require('../utils/errors');

// ── GET school leaderboard ────────────────────────────────
exports.getSchoolLeaderboard = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COALESCE(s.school_name, 'Unknown School') as school_name,
        COALESCE(s.state_of_origin, 'Unknown') as state,
        COUNT(s.id) as member_count,
        SUM(COALESCE(s.points,0)) as total_xp,
        AVG(COALESCE(s.points,0)) as avg_xp,
        SUM(COALESCE(s.coins,0)) as total_coins,
        -- FIX BUG 19: arena_wins column never written — count members with >0 points instead
        COUNT(CASE WHEN s.points > 0 THEN 1 END) as active_warriors
      FROM students s
      WHERE s.school_name IS NOT NULL AND s.school_name != ''
      GROUP BY s.school_name, s.state_of_origin
      ORDER BY total_xp DESC
      LIMIT 50
    `).catch(() => ({ rows: [] }));

    res.json({
      schools: rows.map((r, i) => ({
        rank: i + 1,
        school_name: r.school_name,
        state: r.state,
        member_count: parseInt(r.member_count),
        total_xp: parseInt(r.total_xp) || 0,
        avg_xp: Math.round(r.avg_xp) || 0,
        active_warriors: parseInt(r.active_warriors) || 0,
        badge: i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🏫",
      })),
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── GET my school stats ───────────────────────────────────
exports.getMySchool = async (req, res) => {
  try {
    const sid = req.student.id;

    const student = await db.query(
      "SELECT school_name, state_of_origin FROM students WHERE id=$1", [sid]
    );
    const school_name = student.rows[0]?.school_name;
    if (!school_name) return res.json({ school: null });

    const [statsRes, membersRes] = await Promise.all([
      db.query(`
        SELECT COUNT(*) as members, SUM(COALESCE(points,0)) as total_xp,
               AVG(COALESCE(points,0)) as avg_xp,
               MAX(COALESCE(points,0)) as top_xp
        FROM students WHERE school_name=$1
      `, [school_name]).catch(() => ({ rows: [{}] })),
      db.query(`
        SELECT full_name, COALESCE(points,0) as xp, COALESCE(coins,0) as coins, avatar_url
        FROM students WHERE school_name=$1
        ORDER BY points DESC LIMIT 10
      `, [school_name]).catch(() => ({ rows: [] })),
    ]);

    // Get school global rank
    const rankRes = await db.query(`
      SELECT school_name, rank FROM (
        SELECT school_name, RANK() OVER (ORDER BY SUM(COALESCE(points,0)) DESC) as rank
        FROM students WHERE school_name IS NOT NULL
        GROUP BY school_name
      ) ranked WHERE school_name=$1
    `, [school_name]).catch(() => ({ rows: [] }));

    res.json({
      school: {
        name:    school_name,
        state:   student.rows[0]?.state_of_origin,
        rank:    parseInt(rankRes.rows[0]?.rank) || 0,
        members: parseInt(statsRes.rows[0]?.members) || 0,
        total_xp: parseInt(statsRes.rows[0]?.total_xp) || 0,
        avg_xp:   Math.round(statsRes.rows[0]?.avg_xp) || 0,
        top_students: membersRes.rows,
      }
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── GET state leaderboard ──────────────────────────────────
exports.getStateLeaderboard = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COALESCE(state_of_origin, 'Unknown') as state,
        COUNT(*) as members,
        SUM(COALESCE(points,0)) as total_xp
      FROM students
      WHERE state_of_origin IS NOT NULL
      GROUP BY state_of_origin
      ORDER BY total_xp DESC
      LIMIT 37
    `).catch(() => ({ rows: [] }));

    res.json({
      states: rows.map((r, i) => ({
        rank: i + 1,
        state: r.state,
        members: parseInt(r.members),
        total_xp: parseInt(r.total_xp) || 0,
        badge: i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🌍",
      }))
    });
  } catch (err) {
    serverError(res, err);
  }
};
