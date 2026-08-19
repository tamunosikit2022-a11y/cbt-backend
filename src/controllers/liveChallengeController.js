const { serverError } = require('../utils/errors');
/**
 * LIVE CHALLENGES CONTROLLER
 * ─────────────────────────────────────────────────────────
 * From the Innovation Doc: "Live Challenges" listed under
 * Social & Community Features alongside Study Rooms, Squad
 * Systems, Friend Lists, Voice Rooms, Team Missions.
 *
 * A Live Challenge is an instant 1v1 match that:
 *  - Can be sent to any friend or squad member
 *  - Has a 60-second acceptance window
 *  - Runs as a rapid 5-question Blitz match
 *  - Winner gets coins + bragging-rights notification
 *  - Loser gets a revenge option
 *
 * Socket events on main namespace (not /blitz):
 *   challenge:send     → fires notification to target
 *   challenge:accept   → launches quick Blitz match
 *   challenge:decline  → notifies challenger
 *   challenge:expired  → auto-fires if 60s pass with no response
 */

const db = require('../config/db');
const { fxCoinFly, fxVictory, fxDefeat } = require('./microController');

const pendingChallenges = new Map();  // challengeId -> challenge obj
const activeMatches     = new Map();  // matchId -> match obj

function cid() {
  return `CHAL_${Date.now()}_${Math.random().toString(36).slice(2,6).toUpperCase()}`;
}

function newChallenge(opts) {
  return {
    id:           opts.id,
    challengerId: opts.challengerId,
    challengerName: opts.challengerName,
    targetId:     opts.targetId,
    subject:      opts.subject || 'Mixed',
    status:       'pending',
    createdAt:    Date.now(),
    expiresAt:    Date.now() + 60_000,  // 60 second window
    matchId:      null,
  };
}

function newMatch(challenge, questions) {
  const mid = `LIVE_${Date.now()}_${Math.random().toString(36).slice(2,5).toUpperCase()}`;
  return {
    id:           mid,
    challengeId:  challenge.id,
    subject:      challenge.subject,
    players: new Map([
      [challenge.challengerId, { id: challenge.challengerId, score: 0, answers: [] }],
      [challenge.targetId,     { id: challenge.targetId,     score: 0, answers: [] }],
    ]),
    questions,
    currentQ:         0,
    totalQ:           5,
    timePerQ:         8000,
    status:           'active',
    questionPushedAt: null,
    timer:            null,
  };
}

// ── SOCKET ENGINE ─────────────────────────────────────────
function initLiveChallenges(io) {

  io.on('connection', socket => {

    // ── SEND A CHALLENGE ─────────────────────────────────
    socket.on('challenge:send', async ({ challengerId, challengerName, targetId, subject }, cb) => {
      try {
        // Check they're friends
        const [a, b] = [challengerId, targetId].sort((x, y) => x - y);
        const areFriends = await db.query(
          `SELECT id FROM friends WHERE student_a=$1 AND student_b=$2`, [a, b]
        ).then(r => r.rows.length > 0).catch(() => false);

        if (!areFriends) return cb?.({ success: false, error: 'You can only challenge friends.' });

        // Prevent double-challenge
        const alreadyPending = [...pendingChallenges.values()].find(
          c => c.challengerId === challengerId && c.targetId === targetId && c.status === 'pending'
        );
        if (alreadyPending) return cb?.({ success: false, error: 'Challenge already pending.' });

        const challenge = newChallenge({ id: cid(), challengerId, challengerName, targetId, subject });
        pendingChallenges.set(challenge.id, challenge);

        // Notify target
        io.to(`student:${targetId}`).emit('challenge:incoming', {
          challengeId:   challenge.id,
          from:          challengerName,
          fromId:        challengerId,
          subject:       subject || 'Mixed',
          expiresIn:     60,
          message:       `⚔️ ${challengerName} challenges you to a Live Battle!`,
        });

        cb?.({ success: true, challengeId: challenge.id });

        // Auto-expire after 60s
        setTimeout(() => {
          const c = pendingChallenges.get(challenge.id);
          if (c && c.status === 'pending') {
            c.status = 'expired';
            io.to(`student:${challengerId}`).emit('challenge:expired', {
              challengeId: challenge.id,
              message: 'Your challenge expired — they didn\'t respond in time.',
            });
            pendingChallenges.delete(challenge.id);
          }
        }, 60_000);

      } catch (err) {
        cb?.({ success: false, error: err.message });
      }
    });

    // ── ACCEPT CHALLENGE ─────────────────────────────────
    socket.on('challenge:accept', async ({ challengeId, accepterId }, cb) => {
      try {
        const challenge = pendingChallenges.get(challengeId);
        if (!challenge || challenge.status !== 'pending') {
          return cb?.({ success: false, error: 'Challenge not found or expired.' });
        }
        if (challenge.targetId !== accepterId) {
          return cb?.({ success: false, error: 'Not your challenge.' });
        }

        challenge.status = 'accepted';

        // Fetch 5 questions
        const qQuery = challenge.subject && challenge.subject !== 'Mixed'
          ? `SELECT id,question,option_a,option_b,option_c,option_d,correct_answer,explanation
             FROM questions WHERE subject=$1 AND is_active=true ORDER BY RANDOM() LIMIT 5`
          : `SELECT id,question,option_a,option_b,option_c,option_d,correct_answer,explanation
             FROM questions WHERE is_active=true ORDER BY RANDOM() LIMIT 5`;
        const params  = challenge.subject && challenge.subject !== 'Mixed' ? [challenge.subject] : [];
        const { rows: questions } = await db.query(qQuery, params).catch(() => ({ rows: [] }));

        if (questions.length < 3) return cb?.({ success: false, error: 'Not enough questions.' });

        const match = newMatch(challenge, questions);
        activeMatches.set(match.id, match);
        challenge.matchId = match.id;

        // Notify both players: match starts
        const startPayload = {
          matchId:  match.id,
          subject:  match.subject,
          totalQ:   match.totalQ,
          timePerQ: match.timePerQ,
          opponent: {
            challenger: { id: challenge.challengerId, name: challenge.challengerName },
            accepter:   { id: accepterId },
          },
        };

        io.to(`student:${challenge.challengerId}`).emit('challenge:match_start', startPayload);
        io.to(`student:${accepterId}`).emit('challenge:match_start', startPayload);

        cb?.({ success: true, matchId: match.id });
        pendingChallenges.delete(challengeId);

        // Start the match
        pushLiveQuestion(io, match);

      } catch (err) {
        cb?.({ success: false, error: err.message });
      }
    });

    // ── DECLINE CHALLENGE ────────────────────────────────
    socket.on('challenge:decline', ({ challengeId, declinerId }) => {
      const challenge = pendingChallenges.get(challengeId);
      if (!challenge || challenge.status !== 'pending') return;
      challenge.status = 'declined';
      pendingChallenges.delete(challengeId);

      io.to(`student:${challenge.challengerId}`).emit('challenge:declined', {
        challengeId,
        message: 'They declined your challenge.',
      });
    });

    // ── ANSWER IN LIVE MATCH ─────────────────────────────
    socket.on('challenge:answer', ({ matchId, playerId, choice }, cb) => {
      const match = activeMatches.get(matchId);
      if (!match || match.status !== 'active') return cb?.({ success: false });

      const player = match.players.get(playerId);
      if (!player) return cb?.({ success: false });

      if (player.answers[match.currentQ] !== undefined) return cb?.({ success: false }); // already answered

      const q       = match.questions[match.currentQ];
      const correct = choice?.toUpperCase() === q?.correct_answer?.toUpperCase();
      const ms      = Date.now() - match.questionPushedAt;
      const speed   = ms <= 3000 && correct ? 1 : 0;
      const points  = correct ? 2 + speed : 0;

      player.answers[match.currentQ] = { choice, correct, ms, points };
      player.score += points;

      cb?.({ success: true, correct, correctAnswer: q.correct_answer, explanation: q.explanation, points });

      // Broadcast to opponent (show their progress, not the answer)
      const opponentId = [...match.players.keys()].find(id => id !== playerId);
      if (opponentId) {
        io.to(`student:${opponentId}`).emit('challenge:opponent_answered', {
          correct,
          opponentScore: player.score,
        });
      }

      // Check if both answered
      const bothAnswered = [...match.players.values()].every(p => p.answers[match.currentQ] !== undefined);
      if (bothAnswered) {
        if (match.timer) { clearTimeout(match.timer); match.timer = null; }
        advanceLiveQuestion(io, match);
      }
    });
  });
}

// ── MATCH ENGINE ─────────────────────────────────────────

function pushLiveQuestion(io, match) {
  if (match.currentQ >= match.questions.length) {
    return endLiveMatch(io, match);
  }

  const q = match.questions[match.currentQ];
  match.questionPushedAt = Date.now();

  const payload = {
    matchId:  match.id,
    index:    match.currentQ + 1,
    total:    match.totalQ,
    id:       q.id,
    question: q.question,
    options:  { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
    timeMs:   match.timePerQ,
  };

  for (const [playerId] of match.players) {
    io.to(`student:${playerId}`).emit('challenge:question', payload);
  }

  match.timer = setTimeout(() => {
    // Auto-mark unanswered players
    for (const [, p] of match.players) {
      if (p.answers[match.currentQ] === undefined) {
        p.answers[match.currentQ] = { choice: null, correct: false, ms: match.timePerQ + 1, points: 0 };
      }
    }
    advanceLiveQuestion(io, match);
  }, match.timePerQ + 500);
}

function advanceLiveQuestion(io, match) {
  // Show Q results to both players
  const qResults = {};
  for (const [pid, p] of match.players) {
    qResults[pid] = {
      answer:  p.answers[match.currentQ],
      score:   p.score,
    };
  }

  for (const [playerId] of match.players) {
    io.to(`student:${playerId}`).emit('challenge:question_result', {
      matchId:   match.id,
      questionIndex: match.currentQ,
      results:   qResults,
      correctAnswer: match.questions[match.currentQ].correct_answer,
    });
  }

  match.currentQ++;

  if (match.currentQ >= match.totalQ) {
    setTimeout(() => endLiveMatch(io, match), 2000);
  } else {
    setTimeout(() => pushLiveQuestion(io, match), 2000);
  }
}

async function endLiveMatch(io, match) {
  if (match.status === 'finished') return;
  match.status = 'finished';

  const results = [...match.players.entries()].map(([pid, p]) => ({
    playerId: pid,
    score:    p.score,
  })).sort((a, b) => b.score - a.score);

  const winnerId = results[0].score > results[1].score ? results[0].playerId : null;
  const isDraw   = results[0].score === results[1].score;

  // Award coins
  const winnerCoins = 200, loserCoins = 50, drawCoins = 100;
  for (const r of results) {
    const coins = isDraw ? drawCoins : r.playerId === winnerId ? winnerCoins : loserCoins;
    await db.query(
      `UPDATE students SET coins=COALESCE(coins,0)+$1 WHERE id=$2`, [coins, r.playerId]
    ).catch(() => {});

    if (!isDraw) {
      if (r.playerId === winnerId) {
        fxVictory(io, r.playerId, { mode: 'live_challenge', coinsEarned: coins });
      } else {
        fxDefeat(io, r.playerId, { mode: 'live_challenge', coinsEarned: coins });
      }
    } else {
      fxCoinFly(io, r.playerId, drawCoins, 'live_challenge');
    }

    io.to(`student:${r.playerId}`).emit('challenge:match_end', {
      matchId:    match.id,
      isDraw,
      isWinner:   !isDraw && r.playerId === winnerId,
      results:    results.map(res => ({
        playerId: res.playerId,
        score:    res.score,
        isWinner: !isDraw && res.playerId === winnerId,
      })),
      coins,
      revengeAvailable: true,
    });
  }

  // Log
  await db.query(
    `INSERT INTO live_challenge_history (challenge_id, match_id, winner_id, subject, player1_id, player2_id, played_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
    [
      match.challengeId, match.id, winnerId, match.subject,
      results[0].playerId, results[1].playerId,
    ]
  ).catch(() => {});

  setTimeout(() => activeMatches.delete(match.id), 5 * 60_000);
}

// ── REST ENDPOINTS ────────────────────────────────────────

// GET /api/live-challenges/history
exports.getLiveChallengeHistory = async (req, res) => {
  try {
    const sid = req.student.id;
    const { rows } = await db.query(
      `SELECT lch.*,
              s1.full_name as player1_name,
              s2.full_name as player2_name,
              sw.full_name as winner_name
       FROM live_challenge_history lch
       LEFT JOIN students s1 ON s1.id = lch.player1_id
       LEFT JOIN students s2 ON s2.id = lch.player2_id
       LEFT JOIN students sw ON sw.id = lch.winner_id
       WHERE lch.player1_id=$1 OR lch.player2_id=$1
       ORDER BY lch.played_at DESC LIMIT 20`,
      [sid]
    ).catch(() => ({ rows: [] }));
    res.json({ history: rows });
  } catch (err) {
    serverError(res, err);
  }
};

module.exports = {
  initLiveChallenges,
  getLiveChallengeHistory: exports.getLiveChallengeHistory,
};
