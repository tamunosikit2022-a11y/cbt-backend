const express  = require("express");
const router   = express.Router();
const db       = require("../config/db");
const { rooms } = require("../arena/arenaEngine");
const { requireStudent } = require("../middleware/auth");
const { serverError } = require('../utils/errors');

router.use(requireStudent);

// ── GET ROOM INFO ─────────────────────────────────────────
router.get("/room/:code", (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: "Room not found." });

  res.json({
    code:            room.code,
    mode:            room.mode,
    battleType:      room.battleType,
    subject:         room.subject,
    difficulty:      room.difficulty,
    questionCount:   room.questionCount,
    timePerQuestion: room.timePerQuestion,
    status:          room.status,
    playerCount:     room.players.size,
    host:            room.host,
  });
});

// ── LIST PUBLIC ROOMS (Battle Royal) ─────────────────────
router.get("/rooms/public", (req, res) => {
  const list = [];
  for (const room of rooms.values()) {
    if (room.mode === "battle_royal" && room.status === "waiting") {
      list.push({
        code:        room.code,
        subject:     room.subject,
        difficulty:  room.difficulty,
        battleType:  room.battleType,
        playerCount: room.players.size,
        hostName:    room.host.name,
      });
    }
  }
  res.json(list);
});

// ── MY ARENA STATS ────────────────────────────────────────
router.get("/stats/me", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT s.total_matches, s.wins, s.win_rate, s.xp, s.arena_rank,
              (SELECT COUNT(*) FROM arena_results ar WHERE ar.student_id = $1 AND ar.rank = 1) AS total_wins
       FROM arena_stats s WHERE s.student_id = $1`,
      [req.student.id]
    );
    res.json(result.rows[0] || { total_matches: 0, wins: 0, win_rate: 0, xp: 0, arena_rank: "Bronze" });
  } catch (err) {
    serverError(res, err);
  }
});

// ── ARENA LEADERBOARD ─────────────────────────────────────
router.get("/leaderboard", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT st.full_name, s.xp, s.wins, s.total_matches,
              s.win_rate, s.arena_rank
       FROM arena_stats s
       JOIN students st ON st.id = s.student_id
       WHERE st.is_banned = false
       ORDER BY s.xp DESC
       LIMIT 50`
    );
    res.json(result.rows.map((r, i) => ({ rank: i + 1, ...r })));
  } catch (err) {
    serverError(res, err);
  }
});

// ── MY MATCH HISTORY ──────────────────────────────────────
router.get("/history", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT am.room_code, am.mode, am.battle_type, am.subject,
              am.ended_at, ar.score, ar.rank, ar.correct_count, ar.total_questions
       FROM arena_results ar
       JOIN arena_matches am ON am.id = ar.match_id
       WHERE ar.student_id = $1
       ORDER BY am.ended_at DESC
       LIMIT 30`,
      [req.student.id]
    );
    res.json(result.rows);
  } catch (err) {
    serverError(res, err);
  }
});

module.exports = router;
