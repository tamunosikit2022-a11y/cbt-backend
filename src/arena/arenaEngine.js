/**
 * SCHOLARS ARENA ENGINE v2
 * ─────────────────────────────────────────────────────────
 * ALL MODES FREE — no premium gates
 *
 * Modes:
 *   lone_wolf    — 1v1 (2 players)
 *   duel         — ranked 1v1
 *   duo          — 2v2 team (4 players, 2 squads of 2)
 *   clash_squad  — 2 squads × 2 players (team scoring)
 *   battle_royal — up to 50 players, open public lobby
 *
 * Features:
 *   - Public lobby browser (no code needed)
 *   - Quick-join: instant join to any open public room
 *   - Squad scoring for duo/clash_squad
 *   - Reactions + chat in waiting room
 *   - Auto-start broadcast when battle_royal fills up
 *   - 60s reconnect grace period
 */

const db = require("../config/db");

const rooms   = new Map();
const players = new Map();

const MAX_PLAYERS = {
  lone_wolf:    2,
  duel:         2,
  duo:          4,
  clash_squad:  8,   // 2 teams × 4 players
  battle_royal: 50,
};

const SQUAD_MODES = new Set(["duo", "clash_squad"]);
const LIVES_START = 3;

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? genCode() : code;
}

function uniqueCount(room) {
  return new Set([...room.players.values()].map(p => p.id)).size;
}

function isInRoom(room, pid) {
  return [...room.players.values()].some(p => p.id === pid);
}

function getPlayerObj(room, pid) {
  return [...room.players.values()].find(p => p.id === pid);
}

function assignSquad(room, pid) {
  if (!SQUAD_MODES.has(room.mode)) return null;
  if (room.squads.has(pid)) return room.squads.get(pid);
  const counts = [0, 0];
  for (const [, sq] of room.squads) counts[sq]++;
  const squad = counts[0] <= counts[1] ? 0 : 1;
  room.squads.set(pid, squad);
  return squad;
}

function squadScore(room, idx) {
  let t = 0;
  for (const [pid, sq] of room.squads) if (sq === idx) t += room.scores.get(pid) || 0;
  return t;
}

function newRoom(opts) {
  return {
    code:            opts.code,
    host:            opts.host,
    mode:            opts.mode           || "clash_squad",
    battleType:      opts.battleType     || "speed_battle",
    subject:         opts.subject        || "",
    difficulty:      opts.difficulty     || "mixed",
    questionCount:   Math.min(parseInt(opts.questionCount)   || 10, 30),
    timePerQuestion: Math.min(parseInt(opts.timePerQuestion) || 20, 60),
    isPublic:        opts.isPublic !== false,
    status:          "waiting",
    players:         new Map(),
    scores:          new Map(),
    squads:          new Map(),
    lives:           new Map(),
    eliminated:      new Set(),
    questions:       [],
    currentQ:        -1,
    answers:         new Map(),
    firstCorrect:    new Map(),
    roundTimer:      null,
    createdAt:       Date.now(),
  };
}

function safeRoom(room) {
  const allP = [...room.players.values()];
  const sq = SQUAD_MODES.has(room.mode) ? {
    0: allP.filter(p => room.squads.get(p.id) === 0).map(p => ({ id: p.id, name: p.name })),
    1: allP.filter(p => room.squads.get(p.id) === 1).map(p => ({ id: p.id, name: p.name })),
    score0: squadScore(room, 0),
    score1: squadScore(room, 1),
  } : null;

  return {
    code: room.code, host: room.host,
    mode: room.mode, battleType: room.battleType,
    subject: room.subject, difficulty: room.difficulty,
    questionCount: room.questionCount, timePerQuestion: room.timePerQuestion,
    isPublic: room.isPublic, status: room.status,
    playerCount: uniqueCount(room), maxPlayers: MAX_PLAYERS[room.mode],
    squads: sq,
    players: allP.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, ready: p.ready,
      score:      room.scores.get(p.id)  || 0,
      lives:      room.lives.get(p.id)   ?? LIVES_START,
      eliminated: room.eliminated.has(p.id),
      squad:      room.squads.get(p.id)  ?? null,
    })),
  };
}

function scoresArr(room) {
  const ids = [...new Set([...room.players.values()].map(p => p.id))];
  return ids
    .map(pid => {
      const p = getPlayerObj(room, pid);
      return {
        playerId: pid, name: p?.name || "Unknown", avatar: p?.avatar || "🎓",
        score: room.scores.get(pid) || 0,
        lives: room.lives.get(pid)  ?? LIVES_START,
        eliminated: room.eliminated.has(pid),
        squad: room.squads.get(pid) ?? null,
      };
    })
    .sort((a, b) => a.eliminated !== b.eliminated ? (a.eliminated ? 1 : -1) : b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

function publicRoomsList() {
  return [...rooms.values()]
    .filter(r => r.isPublic && r.status === "waiting")
    .map(r => ({
      code: r.code, mode: r.mode, battleType: r.battleType,
      subject: r.subject, difficulty: r.difficulty,
      playerCount: uniqueCount(r), maxPlayers: MAX_PLAYERS[r.mode],
      hostName: r.host.name,
    }))
    .sort((a, b) => b.playerCount - a.playerCount);
}

// ── QUESTION REPEAT-PREVENTION ────────────────────────────
// Tracks used question IDs per bucket (subject|difficulty).
// Resets automatically when the pool is exhausted.
const usedQuestionIds = new Map();

function bucketKey(room) {
  return `${(room.subject || "ALL").toLowerCase()}|${room.difficulty || "mixed"}`;
}

function getUsed(room) {
  const k = bucketKey(room);
  if (!usedQuestionIds.has(k)) usedQuestionIds.set(k, new Set());
  return usedQuestionIds.get(k);
}

async function loadQuestions(room) {
  const used = getUsed(room);
  const need = room.questionCount;

  async function runQuery(extraWhere, baseParams, withExclusion) {
    let params = [...baseParams];
    let excl = "";
    let idx = params.length + 1;
    if (withExclusion && used.size) {
      const ids = [...used];
      const ph = ids.map((_, i) => `$${idx + i}`).join(",");
      excl = `AND id NOT IN (${ph})`;
      params = [...params, ...ids];
      idx += ids.length;
    }
    const r = await db.query(
      `SELECT id,subject,question,option_a,option_b,option_c,option_d,correct_answer,difficulty,year
       FROM questions WHERE exam_type='JAMB' ${extraWhere} ${excl} ORDER BY RANDOM() LIMIT $${idx}`,
      [...params, need]
    );
    return r.rows;
  }

  async function query(extraWhere, baseParams) {
    let rows = await runQuery(extraWhere, baseParams, true);
    if (rows.length < need && used.size) {
      console.log(`[Arena] Pool exhausted for "${bucketKey(room)}" — resetting.`);
      used.clear();
      rows = await runQuery(extraWhere, baseParams, false);
    }
    return rows;
  }

  const subj = room.subject;
  const diff = room.difficulty && room.difficulty !== "mixed" ? room.difficulty : null;

  let rows = [];
  if (subj && diff)   rows = await query("AND subject ILIKE $1 AND difficulty = $2", [subj, diff]);
  if (!rows.length && subj)  rows = await query("AND subject ILIKE $1", [subj]);
  if (!rows.length && diff)  rows = await query("AND difficulty = $1", [diff]);
  if (!rows.length)          rows = await query("", []);

  for (const row of rows) used.add(row.id);
  return rows.map(q => ({ ...q, _correct: q.correct_answer.toUpperCase() }));
}

async function saveMatch(room) {
  try {
    const res = await db.query(
      `INSERT INTO arena_matches (room_code,mode,battle_type,subject,status,ended_at)
       VALUES ($1,$2,$3,$4,'finished',NOW()) RETURNING id`,
      [room.code, room.mode, room.battleType, room.subject]
    );
    const matchId = res.rows[0]?.id; if (!matchId) return;
    for (const p of scoresArr(room)) {
      const correct = [...room.answers.values()].filter(m => m.get(p.playerId)?.isCorrect).length;
      await db.query(
        `INSERT INTO arena_results (match_id,student_id,score,rank,correct_count,total_questions)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [matchId, p.playerId, p.score, p.rank, correct, room.questionCount]
      );
      const isWin    = p.rank === 1 ? 1 : 0;
      const arenaXP  = isWin ? 50 : Math.max(10, Math.floor(30 / p.rank));  // Win=50XP, 2nd=15, 3rd=10
      const arenaCoins = isWin ? 20 : Math.max(5, Math.floor(15 / p.rank)); // Win=20, 2nd=7, 3rd=5

      // Update arena leaderboard stats
      await db.query(
        `INSERT INTO arena_stats (student_id,total_matches,wins,win_rate,xp) VALUES ($1,1,$2,$3,$4)
         ON CONFLICT (student_id) DO UPDATE SET
           total_matches=arena_stats.total_matches+1,
           wins=arena_stats.wins+$2,
           win_rate=ROUND(((arena_stats.wins+$2)::numeric/(arena_stats.total_matches+1))*100,1),
           xp=arena_stats.xp+$4, updated_at=NOW()`,
        [p.playerId, isWin, isWin ? 100 : Math.round(100 / p.rank), arenaXP]
      );

      // ── Upgrade: apply Spirit active skill boosts (Ember Wyrm 2× etc.)
      let finalXP = arenaXP, finalCoins = arenaCoins;
      try {
        const { applyBoosts } = require("./spiritSkillsHandler");
        const boosted = applyBoosts(room, p.playerId, arenaXP, arenaCoins);
        finalXP    = boosted.xp;
        finalCoins = boosted.coins;
      } catch {}

      // ── Award XP + coins (with boost applied)
      await db.query(
        `UPDATE students SET
           points = COALESCE(points,0) + $1,
           coins  = COALESCE(coins,0)  + $2
         WHERE id = $3`,
        [finalXP, finalCoins, p.playerId]
      );

      // ── Upgrade: track arena_wins + win_streak on students table
      if (isWin) {
        await db.query(
          `UPDATE students SET
             arena_wins        = COALESCE(arena_wins,0) + 1,
             arena_win_streak  = COALESCE(arena_win_streak,0) + 1
           WHERE id=$1`,
          [p.playerId]
        ).catch(() => {});
      } else {
        await db.query(
          `UPDATE students SET arena_win_streak = 0 WHERE id=$1`, [p.playerId]
        ).catch(() => {});
      }

      // ── Mission progress
      try {
        const { updateMissionProgress } = require("../controllers/missionsController");
        await updateMissionProgress(p.playerId, "arena_played");
        if (isWin) await updateMissionProgress(p.playerId, "arena_won");
      } catch {}

      // ── Upgrade: team mission progress
      try {
        const { updateTeamMissionProgress } = require("../controllers/teamMissionsController");
        updateTeamMissionProgress(p.playerId, "arena_wins", isWin ? 1 : 0, arena?.server).catch(() => {});
      } catch {}

      // ── Upgrade: full badge system (replaces old innovationController call)
      try {
        const { checkBadgesForStudent, checkFirstArenaWin } = require("../controllers/badgesController");
        const io = arena?.server;
        checkBadgesForStudent(p.playerId, io).catch(() => {});
        if (isWin) checkFirstArenaWin(p.playerId, io).catch(() => {});
      } catch {}

      // ── Upgrade: micro-interactions
      try {
        const { fxVictory, fxDefeat } = require("../controllers/microController");
        const io = arena?.server;
        if (io) {
          if (isWin) fxVictory(io, p.playerId, { mode: room.battleType, coinsEarned: finalCoins, xpEarned: finalXP });
          else       fxDefeat(io, p.playerId, { mode: room.battleType, coinsEarned: finalCoins });
        }
      } catch {}
    }
  } catch (e) { console.error("saveMatch:", e.message); }
}

function calcPoints(room, isCorrect, timeSpent, isFirst, playerId) {
  if (!isCorrect) return 0;
  const speed = Math.max(0, 1 - timeSpent / (room.timePerQuestion * 1000));
  let base;
  if (room.battleType === "speed_battle") base = isFirst ? Math.round(10 + speed * 5) : 1;
  else if (room.battleType === "survival") base = Math.round(5 + speed * 3);
  else base = Math.round(5 + speed * 5);

  // FIX: ember_wyrm INFERNO BOOST — was tracked in room.activeBoosts but never actually
  // applied anywhere. Now doubles points while the boost window is active.
  const boost = room.activeBoosts?.get(playerId);
  if (boost && boost.expires > Date.now()) base *= 2;

  return base;
}

function sendQuestion(io, room) {
  room.currentQ++;
  if (room.currentQ >= room.questions.length) { endGame(io, room); return; }
  const { _correct, ...clientQ } = room.questions[room.currentQ];
  io.to(room.code).emit("new_question", {
    question: clientQ, questionIndex: room.currentQ,
    totalQuestions: room.questions.length, timeLimit: room.timePerQuestion,
    activePlayers: uniqueCount(room) - room.eliminated.size,
    scores: scoresArr(room),
    squadScores: SQUAD_MODES.has(room.mode) ? { 0: squadScore(room,0), 1: squadScore(room,1) } : null,
  });
  clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => revealAndNext(io, room), room.timePerQuestion * 1000 + 500);
}

function revealAndNext(io, room) {
  clearTimeout(room.roundTimer);
  const q = room.questions[room.currentQ]; if (!q) return;
  io.to(room.code).emit("question_end", {
    correct: q._correct, questionIndex: room.currentQ,
    scores: scoresArr(room), eliminated: [...room.eliminated],
    squadScores: SQUAD_MODES.has(room.mode) ? { 0: squadScore(room,0), 1: squadScore(room,1) } : null,
  });
  if (room.battleType === "survival" && uniqueCount(room) - room.eliminated.size <= 1) {
    setTimeout(() => endGame(io, room), 2000); return;
  }
  setTimeout(() => sendQuestion(io, room), 2500);
}

function endGame(io, room) {
  clearTimeout(room.roundTimer);
  room.status = "finished";
  const final = scoresArr(room);
  let winningSquad = null;
  if (SQUAD_MODES.has(room.mode)) {
    const s0 = squadScore(room,0), s1 = squadScore(room,1);
    winningSquad = s0 > s1 ? 0 : s1 > s0 ? 1 : -1;
  }
  io.to(room.code).emit("game_over", {
    scores: final, winner: final[0], totalQ: room.questions.length,
    winningSquad,
    squadScores: SQUAD_MODES.has(room.mode) ? { 0: squadScore(room,0), 1: squadScore(room,1) } : null,
  });
  saveMatch(room);
  setTimeout(() => rooms.delete(room.code), 10 * 60 * 1000);
}

function initArena(io) {
  const arena = io.of("/arena");

  arena.on("connection", socket => {

    socket.on("create_room", async (data, cb) => {
      try {
        const { spendTokens } = require('../controllers/tokenController');
        const { isPremiumActive } = require('../controllers/adminPremiumController');

        // Hosting is free for anyone currently "premium" — a real paid
        // subscriber OR a student covered by an active admin Free Day
        // event (isPremiumActive checks both). This is what the Arena
        // screen's own gate promises ("Free players can join... creating
        // and hosting is a Premium feature") and what a Free Day is
        // supposed to unlock. Everyone else still pays the 2-token fee.
        const premium = await isPremiumActive(data.playerId).catch(() => false);
        if (!premium) {
          try {
            await spendTokens(data.playerId, 'arena_host');
          } catch (tokenErr) {
            if (tokenErr.code === 'INSUFFICIENT_TOKENS') {
              return cb({ success: false, error: "🪙 Hosting a battle costs 2 tokens (it's free with Premium or during a Free Day event). Buy tokens from the Tokens page — 50 tokens for ₦200!" });
            }
            throw tokenErr;
          }
        }
        const code = genCode();
        const room = newRoom({ ...data, code, host: { id: data.playerId, name: data.playerName } });
        assignSquad(room, data.playerId);
        room.players.set(socket.id, { id: data.playerId, name: data.playerName, avatar: data.avatar || "🧠", ready: true, socketId: socket.id });
        room.scores.set(data.playerId, 0);
        room.lives.set(data.playerId, LIVES_START);
        rooms.set(code, room);
        players.set(data.playerId, { socketId: socket.id, roomCode: code });
        socket.join(code); socket.roomCode = code; socket.playerId = data.playerId; socket.playerName = data.playerName;
        cb({ success: true, code, room: safeRoom(room) });
        // Broadcast updated public list
        arena.emit("public_rooms_update", publicRoomsList());
      } catch (e) { cb({ success: false, error: e.message }); }
    });

    socket.on("join_room", (data, cb) => {
      const code = data.code?.toUpperCase().trim();
      const room = rooms.get(code);
      if (!room)                      return cb({ success: false, error: "Room not found." });
      if (room.status === "finished") return cb({ success: false, error: "Match already ended." });

      // Reconnect
      if (isInRoom(room, data.playerId)) {
        room.players.forEach((p, sid) => { if (p.id === data.playerId) room.players.delete(sid); });
        room.players.set(socket.id, { id: data.playerId, name: data.playerName, avatar: data.avatar || "🎓", ready: true, socketId: socket.id });
        players.set(data.playerId, { socketId: socket.id, roomCode: code });
        socket.join(code); socket.roomCode = code; socket.playerId = data.playerId; socket.playerName = data.playerName;
        cb({ success: true, reconnected: true, room: safeRoom(room) });
        if (room.status === "playing" && room.questions[room.currentQ]) {
          const { _correct, ...clientQ } = room.questions[room.currentQ];
          socket.emit("new_question", { question: clientQ, questionIndex: room.currentQ, totalQuestions: room.questions.length, timeLimit: room.timePerQuestion, scores: scoresArr(room), reconnected: true });
        }
        arena.to(code).emit("player_reconnected", { name: data.playerName });
        return;
      }

      // Mid-game
      if (room.status !== "waiting") {
        if (room.mode === "battle_royal") {
          socket.join(code); socket.roomCode = code;
          return cb({ success: true, spectator: true, room: safeRoom(room) });
        }
        return cb({ success: false, error: "Match in progress." });
      }

      const cur = uniqueCount(room), max = MAX_PLAYERS[room.mode];
      if (cur >= max) return cb({ success: false, error: `Room full (${cur}/${max}).` });

      const squad = assignSquad(room, data.playerId);
      room.players.set(socket.id, { id: data.playerId, name: data.playerName, avatar: data.avatar || "🎓", ready: false, socketId: socket.id });
      room.scores.set(data.playerId, 0);
      room.lives.set(data.playerId, LIVES_START);
      players.set(data.playerId, { socketId: socket.id, roomCode: code });
      socket.join(code); socket.roomCode = code; socket.playerId = data.playerId; socket.playerName = data.playerName;

      arena.to(code).emit("player_joined", {
        player: { id: data.playerId, name: data.playerName, avatar: data.avatar, squad },
        playerCount: uniqueCount(room), maxPlayers: max, room: safeRoom(room),
      });
      cb({ success: true, room: safeRoom(room) });
      arena.emit("public_rooms_update", publicRoomsList());

      // Battle Royal full → countdown auto-start warning
      if (room.mode === "battle_royal" && uniqueCount(room) >= max) {
        arena.to(code).emit("room_full_autostart", { seconds: 10 });
      }
    });

    // Quick-join: find best open public room
    socket.on("quick_join", (data, cb) => {
      let best = null;
      for (const room of rooms.values()) {
        if (room.isPublic && room.status === "waiting" && uniqueCount(room) < MAX_PLAYERS[room.mode]) {
          if (!best || uniqueCount(room) > uniqueCount(best)) best = room;
        }
      }
      if (!best) return cb({ success: false, error: "No open rooms. Create one!" });
      cb({ success: true, code: best.code, room: safeRoom(best) });
    });

    socket.on("list_public_rooms", (_, cb) => {
      cb({ rooms: publicRoomsList() });
    });

    socket.on("player_ready", () => {
      const room = rooms.get(socket.roomCode); if (!room) return;
      const p = room.players.get(socket.id); if (p) p.ready = true;
      const all = [...room.players.values()];
      arena.to(room.code).emit("ready_update", {
        playerId: socket.playerId,
        readyCount: all.filter(p => p.ready).length,
        totalCount: all.length,
        allReady: all.every(p => p.ready),
      });
    });

    // ── KICK PLAYER (host only) ───────────────────────────
    socket.on("kick_player", (data, cb) => {
      const room = rooms.get(socket.roomCode);
      if (!room) return cb?.({ success: false, error: "Room not found." });
      const host = room.players.get(socket.id);
      if (!host || host.id !== room.host.id) return cb?.({ success: false, error: "Only host can remove players." });

      // Find target socket by playerId
      const targetEntry = [...room.players.entries()].find(([, pl]) => pl.id === data.playerId);
      if (!targetEntry) return cb?.({ success: false, error: "Player not found." });
      const [targetSocketId, targetPlayer] = targetEntry;

      // Remove from room
      room.players.delete(targetSocketId);

      // Tell kicked player
      arena.to(targetSocketId).emit("kicked", { reason: "You were removed from the room by the host." });

      // Update everyone else
      const allPlayers = [...room.players.values()].map(pl => ({
        id: pl.id, name: pl.name, ready: pl.ready, avatar: pl.avatar, squad: pl.squad,
      }));
      arena.to(room.code).emit("player_kicked", {
        playerId: targetPlayer.id,
        playerName: targetPlayer.name,
        players: allPlayers,
      });

      arena.emit("public_rooms_update", publicRoomsList());
      cb?.({ success: true });
    });

    socket.on("start_game", async (_, cb) => {
      const room = rooms.get(socket.roomCode);
      if (!room) return cb?.({ success: false, error: "Room not found." });
      const p = room.players.get(socket.id);
      if (!p || p.id !== room.host.id) return cb?.({ success: false, error: "Only host can start." });
      if (uniqueCount(room) < 2) return cb?.({ success: false, error: "Need at least 2 players." });

      try {
        room.questions = await loadQuestions(room);
        if (!room.questions.length) return cb?.({ success: false, error: "No questions found." });
        room.status = "countdown"; room.currentQ = -1;
        arena.to(room.code).emit("countdown_start", { seconds: 3 });
        let count = 3;
        const tick = setInterval(() => {
          count--;
          if (count > 0) arena.to(room.code).emit("countdown_tick", { seconds: count });
          else { clearInterval(tick); room.status = "playing"; sendQuestion(arena, room); }
        }, 1000);
        cb?.({ success: true });
        arena.emit("public_rooms_update", publicRoomsList());
      } catch (e) { cb?.({ success: false, error: e.message }); }
    });

    socket.on("submit_answer", data => {
      const room = rooms.get(socket.roomCode);
      if (!room || room.status !== "playing") return;
      const player = room.players.get(socket.id);
      if (!player || room.eliminated.has(player.id)) return;
      const qIdx = room.currentQ, q = room.questions[qIdx]; if (!q) return;
      if (!room.answers.has(qIdx)) room.answers.set(qIdx, new Map());
      const qa = room.answers.get(qIdx);
      if (qa.has(player.id)) return;

      // FIX: shadow_lynx SHADOW STEP — was tracked in room.shadowSteps but never consumed.
      // A skipped question now counts as neither correct nor wrong (no streak break, no life lost).
      const isSkip = data.skipped && room.shadowSteps?.has(player.id);
      if (isSkip) room.shadowSteps.delete(player.id);

      const isCorrect = isSkip ? null : (data.answer || "").toUpperCase().trim() === q._correct;
      const timeSpent = Math.min(data.timeSpent || 0, room.timePerQuestion * 1000);
      const isFirst   = isCorrect === true && !room.firstCorrect.has(qIdx);
      if (isFirst) room.firstCorrect.set(qIdx, player.id);
      const points = isSkip ? 0 : calcPoints(room, isCorrect, timeSpent, isFirst, player.id);
      room.scores.set(player.id, (room.scores.get(player.id) || 0) + points);
      qa.set(player.id, { answer: data.answer, isCorrect, points, timeSpent, skipped: !!isSkip });

      if (room.battleType === "survival" && isCorrect === false) {
        let lives = (room.lives.get(player.id) ?? LIVES_START) - 1;

        // FIX: crystal_phoenix REBIRTH FLAME — was tracked in room.rebirths but never
        // actually prevented elimination server-side (source of truth for game_over).
        if (lives <= 0 && room.rebirths?.has(player.id)) {
          room.rebirths.delete(player.id);
          lives = 1; // revive with 1 life
        }

        room.lives.set(player.id, lives);
        if (lives <= 0) room.eliminated.add(player.id);
      }

      socket.emit("answer_result", {
        isCorrect, correct: q._correct, points, skipped: !!isSkip,
        yourScore:  room.scores.get(player.id),
        lives:      room.lives.get(player.id) ?? LIVES_START,
        eliminated: room.eliminated.has(player.id),
        squadScore: SQUAD_MODES.has(room.mode) ? squadScore(room, room.squads.get(player.id)) : null,
      });

      const active = uniqueCount(room) - room.eliminated.size;
      arena.to(room.code).emit("score_update", {
        scores: scoresArr(room), answeredCount: qa.size, activeCount: active,
        squadScores: SQUAD_MODES.has(room.mode) ? { 0: squadScore(room,0), 1: squadScore(room,1) } : null,
      });

      if (room.battleType === "speed_battle" && isFirst && isCorrect) {
        clearTimeout(room.roundTimer); setTimeout(() => revealAndNext(arena, room), 1500); return;
      }
      if (qa.size >= active) { clearTimeout(room.roundTimer); setTimeout(() => revealAndNext(arena, room), 800); }
      if (room.battleType === "survival" && room.eliminated.size >= uniqueCount(room) - 1) {
        clearTimeout(room.roundTimer); setTimeout(() => endGame(arena, room), 2000);
      }
    });

    socket.on("reaction", data => {
      const room = rooms.get(socket.roomCode); if (!room) return;
      arena.to(room.code).emit("player_reaction", { playerName: socket.playerName, emoji: data.emoji });
    });

    socket.on("chat", data => {
      const room = rooms.get(socket.roomCode); if (!room) return;
      arena.to(room.code).emit("chat_msg", { playerName: socket.playerName, msg: String(data.msg || "").slice(0, 100) });
    });

    socket.on("get_room", (code, cb) => {
      const room = rooms.get(code?.toUpperCase());
      if (!room) return cb({ success: false, error: "Room not found." });
      cb({ success: true, room: safeRoom(room) });
    });

    socket.on("disconnect", () => {
      const room = rooms.get(socket.roomCode); if (!room) return;
      const player = room.players.get(socket.id); if (!player) return;
      arena.to(room.code).emit("player_disconnected", { name: player.name, temporary: true });

      if (player.id === room.host.id && room.status === "waiting") {
        setTimeout(() => {
          const r = rooms.get(socket.roomCode); if (!r || r.status !== "waiting") return;
          const back = [...r.players.values()].some(p => p.id === player.id && p.socketId !== socket.id);
          if (!back) { arena.to(socket.roomCode).emit("room_closed", { reason: "Host disconnected." }); rooms.delete(socket.roomCode); arena.emit("public_rooms_update", publicRoomsList()); }
        }, 30000);
      }

      setTimeout(() => {
        const stored = players.get(player.id);
        if (stored && stored.socketId === socket.id) {
          players.delete(player.id);
          if (room.players.get(socket.id)?.id === player.id) room.players.delete(socket.id);
        }
      }, 60000);
    });
  });

  setInterval(() => arena.emit("public_rooms_update", publicRoomsList()), 10000);
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.createdAt > 3 * 60 * 60 * 1000) rooms.delete(code);
  }, 30 * 60 * 1000);

  // ── ARENA ROOM PERSISTENCE — snapshot every 30s to survive restarts ──
  const db = require("../config/db");
  setInterval(async () => {
    for (const [code, room] of rooms.entries()) {
      try {
        await db.query(
          `INSERT INTO arena_snapshots(room_code, state, updated_at)
           VALUES($1,$2,NOW())
           ON CONFLICT(room_code) DO UPDATE SET state=$2, updated_at=NOW()`,
          [code, JSON.stringify(room)]
        );
      } catch (_) { /* non-critical, best-effort */ }
    }
  }, 30_000);

  console.log("🏟️  Arena Engine v2 initialized — all modes FREE, 50-player battle royal");
}

module.exports = { initArena, rooms, players };
