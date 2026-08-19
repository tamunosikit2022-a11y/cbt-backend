/**
 * ARENA BLITZ MODE + SURVIVAL MODE
 * ─────────────────────────────────────────────────────────
 * From the Innovation Doc:
 *
 * BLITZ MODE — "Fast-response gameplay"
 *   - 10 questions, 5 seconds each (no extensions)
 *   - Correct answer = 2 pts, wrong = -1 pt, timeout = 0
 *   - Speed bonus: under 2s = +1 bonus point
 *   - Entry fee: free | token-gated (ranked blitz)
 *   - Sizes: 1v1 | 4-player | 8-player
 *   - Spirit skills ENABLED but cooldown only 1 per match
 *
 * SURVIVAL MODE — "Answer until failure"
 *   - Infinite questions until a player answers wrong
 *   - Answering wrong = eliminated
 *   - Last player standing wins
 *   - Lives: 0 (no lives) | 1 (one retry) | 3 (three retries)
 *   - Players can see each other's elimination in real time
 *   - Entry: public queue | school-only | squad-only
 *   - Rewards scale with questions answered before elimination
 *
 * Socket namespace: /blitz  and  /survival
 * Both integrate with spiritSkillsHandler and badgesController.
 */

const db      = require('../config/db');
const { applyBoosts }                     = require('./spiritSkillsHandler');
const { checkBadgesForStudent, awardBadge } = require('../controllers/badgesController');
const { fxVictory, fxDefeat, fxCoinFly, fxScreenFlash } = require('../controllers/microController');

// ─────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────

async function fetchQuestions(subject, count) {
  const query = subject && subject !== 'Mixed'
    ? `SELECT id,question,option_a,option_b,option_c,option_d,correct_answer,explanation
       FROM questions WHERE subject=$1 AND is_active=true ORDER BY RANDOM() LIMIT $2`
    : `SELECT id,question,option_a,option_b,option_c,option_d,correct_answer,explanation
       FROM questions WHERE is_active=true ORDER BY RANDOM() LIMIT $2`;
  const params = subject && subject !== 'Mixed' ? [subject, count] : [count];
  const { rows } = await db.query(query, params).catch(() => ({ rows: [] }));
  return rows;
}

function roomCode(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2,7).toUpperCase()}`;
}

// ─────────────────────────────────────────────────────────
// BLITZ MODE ENGINE
// ─────────────────────────────────────────────────────────

const blitzRooms = new Map();  // roomCode -> blitzRoom

function newBlitzRoom(opts) {
  return {
    code:         opts.code,
    subject:      opts.subject || 'Mixed',
    mode:         'blitz',
    ranked:       !!opts.ranked,
    maxPlayers:   opts.maxPlayers || 2,       // 2 | 4 | 8
    players:      new Map(),                   // socketId -> playerObj
    questions:    [],
    currentQ:     0,
    totalQ:       10,
    timePerQ:     5000,                        // 5 seconds
    status:       'waiting',                   // waiting|playing|finished
    timers:       new Map(),                   // playerId -> per-Q timer
    answers:      new Map(),                   // playerId -> [answers]
    startedAt:    null,
    questionPushedAt: null,
  };
}

function blitzScore(answers) {
  return answers.reduce((sum, a) => {
    if (!a) return sum;
    if (!a.answered)         return sum;
    if (!a.correct)          return sum - 1;
    const bonus = a.ms <= 2000 ? 1 : 0;
    return sum + 2 + bonus;
  }, 0);
}

function initBlitz(io) {
  const ns = io.of('/blitz');

  // Matchmaking queue: subject -> { ranked } -> [{ socketId, playerId, name, ... }]
  const queue = new Map();

  function getQueue(subject, ranked) {
    const key = `${subject}:${ranked ? 'ranked' : 'casual'}`;
    if (!queue.has(key)) queue.set(key, []);
    return queue.get(key);
  }

  function tryMatch(subject, ranked, maxPlayers) {
    const q   = getQueue(subject, ranked);
    if (q.length >= maxPlayers) {
      const matched = q.splice(0, maxPlayers);
      launchBlitz(ns, matched, { subject, ranked, maxPlayers });
    }
  }

  async function launchBlitz(ns_, players, opts) {
    const code    = roomCode('BLZ');
    const room    = newBlitzRoom({ code, ...opts });
    const qs      = await fetchQuestions(opts.subject, room.totalQ);
    room.questions = qs;
    blitzRooms.set(code, room);

    for (const p of players) {
      const sock = ns_.sockets.get(p.socketId);
      if (sock) {
        sock.join(code);
        sock.blitzRoom = code;
        room.players.set(p.socketId, { id: p.playerId, name: p.name, socketId: p.socketId, score: 0 });
        room.answers.set(p.playerId, []);
      }
    }

    room.status     = 'playing';
    room.startedAt  = Date.now();
    ns_.to(code).emit('blitz:start', {
      roomCode:   code,
      totalQ:     room.totalQ,
      timePerQ:   room.timePerQ,
      players:    [...room.players.values()].map(p => ({ id: p.id, name: p.name })),
      subject:    room.subject,
    });

    pushBlitzQuestion(ns_, room, code);
  }

  function pushBlitzQuestion(ns_, room, code) {
    if (room.currentQ >= room.questions.length || room.status !== 'playing') {
      return endBlitz(ns_, room, code);
    }

    const q = room.questions[room.currentQ];
    room.questionPushedAt = Date.now();

    // Hide correct answer
    const clientQ = {
      index:    room.currentQ + 1,
      total:    room.totalQ,
      id:       q.id,
      question: q.question,
      options:  { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
      timeMs:   room.timePerQ,
    };

    ns_.to(code).emit('blitz:question', clientQ);

    // Auto-advance after time expires
    const t = setTimeout(() => {
      // Anyone who didn't answer is marked as timed out
      for (const [, p] of room.players) {
        const answers = room.answers.get(p.id);
        if (!answers[room.currentQ]) {
          answers[room.currentQ] = { answered: false, correct: false, ms: room.timePerQ + 1, choice: null };
        }
      }
      room.currentQ++;
      pushBlitzQuestion(ns_, room, code);
    }, room.timePerQ + 500);

    room.timers.set(`q${room.currentQ}`, t);
  }

  async function endBlitz(ns_, room, code) {
    room.status = 'finished';

    // Calculate scores
    const results = [];
    for (const [, p] of room.players) {
      const answers = room.answers.get(p.id) || [];
      const score   = blitzScore(answers);
      results.push({ id: p.id, name: p.name, score, answers });
    }
    results.sort((a, b) => b.score - a.score);

    // Award coins/xp
    const rewards = [
      { coins: 150, xp: 200 },   // 1st
      { coins: 75,  xp: 100 },   // 2nd
      { coins: 40,  xp: 50  },   // 3rd+
    ];
    for (let i = 0; i < results.length; i++) {
      const r     = rewards[Math.min(i, rewards.length - 1)];
      const p     = results[i];
      const boost = applyBoosts(room, p.id, r.xp, r.coins);

      await db.query(
        `UPDATE students SET coins=COALESCE(coins,0)+$1, points=COALESCE(points,0)+$2 WHERE id=$3`,
        [boost.coins, boost.xp, p.id]
      ).catch(() => {});

      if (i === 0) {
        await db.query(
          `UPDATE students SET blitz_wins=COALESCE(blitz_wins,0)+1 WHERE id=$1`, [p.id]
        ).catch(() => {});
        fxVictory(io, p.id, { mode: 'blitz', coinsEarned: boost.coins, xpEarned: boost.xp });
      } else {
        fxDefeat(io, p.id, { mode: 'blitz', coinsEarned: boost.coins });
      }

      await checkBadgesForStudent(p.id, io);
    }

    // Record in blitz_match_results
    for (const p of results) {
      await db.query(
        `INSERT INTO blitz_match_results (student_id, room_code, score, rank, subject, played_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [p.id, code, p.score, results.indexOf(p) + 1, room.subject]
      ).catch(() => {});
    }

    ns_.to(code).emit('blitz:end', {
      results,
      winner: results[0],
    });

    setTimeout(() => blitzRooms.delete(code), 5 * 60_000);
  }

  ns.on('connection', socket => {

    // ── JOIN QUEUE ───────────────────────────────────────
    socket.on('blitz:queue', ({ playerId, playerName, subject = 'Mixed', ranked = false, maxPlayers = 2 }, cb) => {
      const q = getQueue(subject, ranked);

      // Avoid duplicate
      if (q.find(p => p.playerId === playerId)) return cb?.({ success: false, error: 'Already in queue.' });

      q.push({ socketId: socket.id, playerId, name: playerName, subject, ranked });
      socket.blitzPlayerId = playerId;
      socket.blitzSubject  = subject;
      socket.blitzRanked   = ranked;

      cb?.({ success: true, queueSize: q.length, needed: maxPlayers });
      ns.to(socket.id).emit('blitz:queue_update', { position: q.length, needed: maxPlayers });

      tryMatch(subject, ranked, maxPlayers);
    });

    // ── SUBMIT ANSWER ────────────────────────────────────
    socket.on('blitz:answer', ({ choice, questionIndex }, cb) => {
      const code = socket.blitzRoom;
      const room = blitzRooms.get(code);
      if (!room || room.status !== 'playing') return cb?.({ success: false });

      const playerId  = socket.blitzPlayerId;
      const answers   = room.answers.get(playerId);
      if (!answers || answers[questionIndex] !== undefined) return cb?.({ success: false }); // already answered

      const q       = room.questions[questionIndex];
      const correct = choice?.toUpperCase() === q?.correct_answer?.toUpperCase();
      const ms      = Date.now() - room.questionPushedAt;

      answers[questionIndex] = { answered: true, correct, ms, choice };

      cb?.({ success: true, correct, correctAnswer: q.correct_answer, explanation: q.explanation });

      // Broadcast answer submission (not the answer itself)
      ns.to(code).emit('blitz:answer_submitted', {
        playerId,
        questionIndex,
        correct,
        ms,
        speedBonus: ms <= 2000 && correct,
      });
    });

    // ── LEAVE QUEUE ──────────────────────────────────────
    socket.on('blitz:leave_queue', () => {
      const q = getQueue(socket.blitzSubject, socket.blitzRanked);
      const i = q.findIndex(p => p.socketId === socket.id);
      if (i !== -1) q.splice(i, 1);
    });

    socket.on('disconnect', () => {
      const q = getQueue(socket.blitzSubject || 'Mixed', socket.blitzRanked || false);
      const i = q.findIndex(p => p.socketId === socket.id);
      if (i !== -1) q.splice(i, 1);
    });
  });
}

// ─────────────────────────────────────────────────────────
// SURVIVAL MODE ENGINE
// ─────────────────────────────────────────────────────────

const survivalRooms = new Map();

function newSurvivalRoom(opts) {
  return {
    code:         opts.code,
    subject:      opts.subject || 'Mixed',
    mode:         'survival',
    maxPlayers:   opts.maxPlayers || 20,
    lives:        opts.lives !== undefined ? parseInt(opts.lives) : 0,   // 0=instant-death
    players:      new Map(),                  // socketId -> playerObj
    eliminated:   new Map(),                  // playerId -> { at, questionNum }
    questions:    [],                         // grows dynamically
    currentQ:     0,
    status:       'waiting',
    questionTimer: null,
    timePerQ:     12000,                      // 12s per question (more generous than blitz)
    questionPushedAt: null,
    startedAt:    null,
  };
}

function initSurvival(io) {
  const ns = io.of('/survival');

  ns.on('connection', socket => {

    // ── CREATE / JOIN ROOM ───────────────────────────────
    socket.on('survival:join', async ({ playerId, playerName, roomCode: code, subject = 'Mixed', maxPlayers = 20, lives = 0 }, cb) => {
      let room = survivalRooms.get(code);

      if (!room) {
        room = newSurvivalRoom({ code, subject, maxPlayers, lives });
        survivalRooms.set(code, room);
      }

      if (room.status !== 'waiting') return cb?.({ success: false, error: 'Match already started.' });
      if (room.players.size >= room.maxPlayers) return cb?.({ success: false, error: 'Room full.' });

      room.players.set(socket.id, {
        id: playerId, name: playerName, socketId: socket.id,
        livesLeft: room.lives, questionsAnswered: 0,
      });

      socket.join(code);
      socket.survivalRoom     = code;
      socket.survivalPlayerId = playerId;

      cb?.({ success: true, roomCode: code, playerCount: room.players.size });
      ns.to(code).emit('survival:player_joined', {
        playerId, playerName,
        playerCount: room.players.size, maxPlayers: room.maxPlayers,
      });
    });

    // ── START (host triggers) ────────────────────────────
    socket.on('survival:start', async ({ roomCode: code }, cb) => {
      const room = survivalRooms.get(code);
      if (!room || room.players.size < 2) return cb?.({ success: false, error: 'Need at least 2 players.' });
      if (room.status !== 'waiting') return cb?.({ success: false, error: 'Already started.' });

      // Pre-fetch first 50 questions — more will be fetched on demand
      room.questions = await fetchQuestions(room.subject, 50);
      if (room.questions.length < 5) return cb?.({ success: false, error: 'Not enough questions in database.' });

      room.status    = 'playing';
      room.startedAt = Date.now();

      ns.to(code).emit('survival:start', {
        subject:    room.subject,
        lives:      room.lives,
        playerCount: room.players.size,
      });

      pushSurvivalQuestion(ns, room, code, io);
      cb?.({ success: true });
    });

    // ── SUBMIT ANSWER ────────────────────────────────────
    socket.on('survival:answer', ({ choice }, cb) => {
      const code = socket.survivalRoom;
      const room = survivalRooms.get(code);
      if (!room || room.status !== 'playing') return;

      const playerId = socket.survivalPlayerId;
      if (room.eliminated.has(playerId)) return;  // already out

      const player  = room.players.get(socket.id);
      if (!player || player.answered) return;     // already answered this Q
      player.answered = true;

      const q       = room.questions[room.currentQ];
      const correct = choice?.toUpperCase() === q?.correct_answer?.toUpperCase();
      player.questionsAnswered++;

      if (correct) {
        cb?.({ success: true, correct: true, correctAnswer: q.correct_answer });
        ns.to(code).emit('survival:answer_result', { playerId, correct: true, name: player.name });
      } else {
        // Wrong answer
        if (player.livesLeft > 0) {
          player.livesLeft--;
          cb?.({ success: true, correct: false, livesLeft: player.livesLeft, correctAnswer: q.correct_answer });
          ns.to(code).emit('survival:answer_result', { playerId, correct: false, livesLeft: player.livesLeft, name: player.name });
        } else {
          // Eliminated
          room.eliminated.set(playerId, { at: Date.now(), questionNum: room.currentQ + 1 });
          cb?.({ success: true, correct: false, eliminated: true, correctAnswer: q.correct_answer });
          ns.to(code).emit('survival:eliminated', {
            playerId, name: player.name,
            questionNum: room.currentQ + 1,
            remaining: room.players.size - room.eliminated.size,
          });
          fxDefeat(io, playerId, { mode: 'survival' });
          fxScreenFlash(io, playerId, { color: '#EF4444', duration: 600 });

          // Check if only 1 remains
          const surviving = [...room.players.values()].filter(p => !room.eliminated.has(p.id));
          if (surviving.length === 1) {
            endSurvival(ns, room, code, surviving[0], io);
          }
        }
      }
    });

    socket.on('disconnect', () => {
      const code = socket.survivalRoom;
      const room = survivalRooms.get(code);
      if (!room) return;
      const player = room.players.get(socket.id);
      if (player && !room.eliminated.has(player.id)) {
        room.eliminated.set(player.id, { at: Date.now(), questionNum: room.currentQ + 1, disconnected: true });
        const surviving = [...room.players.values()].filter(p => !room.eliminated.has(p.id));
        if (surviving.length === 1 && room.status === 'playing') {
          endSurvival(ns, room, code, surviving[0], io);
        }
      }
    });
  });
}

function pushSurvivalQuestion(ns, room, code, io) {
  if (room.status !== 'playing') return;

  // Refresh batch if running low
  if (room.currentQ >= room.questions.length - 5) {
    fetchQuestions(room.subject, 30).then(qs => {
      room.questions.push(...qs);
    }).catch(() => {});
  }

  const q = room.questions[room.currentQ];
  if (!q) return endSurvival(ns, room, code, null, io);

  room.questionPushedAt = Date.now();

  // Reset player.answered flags
  for (const [, p] of room.players) p.answered = false;

  const clientQ = {
    index:    room.currentQ + 1,
    id:       q.id,
    question: q.question,
    options:  { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
    timeMs:   room.timePerQ,
    remaining: room.players.size - room.eliminated.size,
  };
  ns.to(code).emit('survival:question', clientQ);

  room.questionTimer = setTimeout(() => {
    // Timeout — players who didn't answer lose a life / are eliminated
    for (const [, p] of room.players) {
      if (!room.eliminated.has(p.id) && !p.answered) {
        if (p.livesLeft > 0) {
          p.livesLeft--;
          ns.to(code).emit('survival:timeout_penalty', { playerId: p.id, name: p.name, livesLeft: p.livesLeft });
        } else {
          room.eliminated.set(p.id, { at: Date.now(), questionNum: room.currentQ + 1, reason: 'timeout' });
          ns.to(code).emit('survival:eliminated', {
            playerId: p.id, name: p.name,
            questionNum: room.currentQ + 1, reason: 'timeout',
            remaining: room.players.size - room.eliminated.size,
          });
          if (io) fxDefeat(io, p.id, { mode: 'survival' });
        }
      }
    }

    const surviving = [...room.players.values()].filter(p => !room.eliminated.has(p.id));
    if (surviving.length <= 1) {
      endSurvival(ns, room, code, surviving[0] || null, io);
    } else {
      room.currentQ++;
      setTimeout(() => pushSurvivalQuestion(ns, room, code, io), 2000);
    }
  }, room.timePerQ);
}

async function endSurvival(ns, room, code, winner, io) {
  if (room.status === 'finished') return;
  room.status = 'finished';
  if (room.questionTimer) clearTimeout(room.questionTimer);

  const rankedPlayers = [...room.players.values()]
    .map(p => ({
      ...p,
      eliminatedAt: room.eliminated.get(p.id) || null,
      survived:     !room.eliminated.has(p.id),
    }))
    .sort((a, b) => {
      if (a.survived && !b.survived) return -1;
      if (!a.survived && b.survived) return 1;
      return (b.eliminatedAt?.questionNum || 0) - (a.eliminatedAt?.questionNum || 0);
    });

  ns.to(code).emit('survival:end', {
    winner:        winner ? { id: winner.id, name: winner.name } : null,
    rankings:      rankedPlayers.map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, questionsAnswered: p.questionsAnswered })),
    totalQuestions: room.currentQ + 1,
  });

  // Award rewards
  for (let i = 0; i < rankedPlayers.length; i++) {
    const p = rankedPlayers[i];
    const q = p.questionsAnswered || 0;
    // Coins scale with survival time
    const coins = Math.max(10, q * 5) + (i === 0 ? 200 : i === 1 ? 100 : i === 2 ? 50 : 0);
    const xp    = Math.max(20, q * 10) + (i === 0 ? 500 : i === 1 ? 250 : 0);

    await db.query(
      `UPDATE students SET coins=COALESCE(coins,0)+$1, points=COALESCE(points,0)+$2 WHERE id=$3`,
      [coins, xp, p.id]
    ).catch(() => {});

    await db.query(
      `INSERT INTO survival_match_results (student_id, room_code, rank, questions_answered, subject, played_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [p.id, code, i + 1, q, room.subject]
    ).catch(() => {});

    if (i === 0 && winner) {
      fxVictory(io, winner.id, { mode: 'survival', coinsEarned: coins, xpEarned: xp });
      await db.query(
        `UPDATE students SET survival_top5=COALESCE(survival_top5,0)+1 WHERE id=$1`, [p.id]
      ).catch(() => {});
    }

    await checkBadgesForStudent(p.id, io);
  }

  setTimeout(() => survivalRooms.delete(code), 10 * 60_000);
}

// ── REST: Room info ───────────────────────────────────────

exports.getBlitzHistory = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT room_code, score, rank, subject, played_at
       FROM blitz_match_results WHERE student_id=$1 ORDER BY played_at DESC LIMIT 20`,
      [req.student.id]
    ).catch(() => ({ rows: [] }));
    res.json({ history: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getSurvivalHistory = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT room_code, rank, questions_answered, subject, played_at
       FROM survival_match_results WHERE student_id=$1 ORDER BY played_at DESC LIMIT 20`,
      [req.student.id]
    ).catch(() => ({ rows: [] }));
    res.json({ history: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  initBlitz,
  initSurvival,
  blitzRooms,
  survivalRooms,
  getBlitzHistory:    exports.getBlitzHistory,
  getSurvivalHistory: exports.getSurvivalHistory,
};
