/**
 * TOURNAMENT CONTROLLER — Bracket Elimination Mode
 * ─────────────────────────────────────────────────────────
 * From the Innovation Doc: "Tournament Mode — Bracket elimination"
 *
 * Flow:
 *  1. Admin or auto-scheduler creates a tournament
 *  2. Students register (up to 64 players per bracket)
 *  3. System seeds the bracket (random or rank-based)
 *  4. Each round: matched players fight in Arena 1v1
 *  5. Winners advance, losers are eliminated
 *  6. Final winner gets Grand Prize (coins + gems + cosmetic + badge)
 *
 * Bracket sizes: 8 | 16 | 32 | 64
 * Socket namespace: /tournament
 */

const db = require('../config/db');
const { fxCoinFly, fxConfetti, fxVictory, fxBadgeUnlock } = require('./microController');
const { serverError } = require('../utils/errors');

const tournaments = new Map();  // stored in memory + synced to DB

// ── BRACKET MATH ─────────────────────────────────────────

function nextPowerOf2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function buildBracket(participants) {
  const size = nextPowerOf2(participants.length);
  // Pad with byes
  while (participants.length < size) participants.push({ id: null, name: 'BYE' });

  // Seed: interleave top half vs bottom half
  const seeded = [];
  const half   = size / 2;
  for (let i = 0; i < half; i++) {
    seeded.push(participants[i]);
    seeded.push(participants[size - 1 - i]);
  }

  const rounds = Math.log2(size);
  const bracket = [];
  let current = seeded;
  for (let r = 0; r < rounds; r++) {
    const matchups = [];
    for (let i = 0; i < current.length; i += 2) {
      matchups.push({
        id:       `R${r + 1}_M${i / 2 + 1}`,
        round:    r + 1,
        player1:  current[i]   || null,
        player2:  current[i + 1] || null,
        winner:   null,
        roomCode: null,
        status:   'pending',
      });
    }
    bracket.push(matchups);
    // Placeholder for next round — winners TBD
    current = new Array(matchups.length / 2).fill(null);
  }
  return bracket;
}

// ── DB HELPERS ────────────────────────────────────────────

async function saveTournamentToDB(t) {
  await db.query(
    `INSERT INTO tournaments (id, name, subject, max_size, bracket_json, status, created_at, start_at, prizes_json)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       bracket_json=$5, status=$6, prizes_json=$8`,
    [t.id, t.name, t.subject, t.maxSize, JSON.stringify(t.bracket), t.status,
     t.startAt, JSON.stringify(t.prizes)]
  ).catch(err => console.error('saveTournamentToDB:', err.message));
}

// ── REST ENDPOINTS ────────────────────────────────────────

// GET /api/tournaments
exports.listTournaments = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, subject, max_size, status, start_at, prizes_json,
              (SELECT COUNT(*) FROM tournament_registrations WHERE tournament_id=t.id) as registered
       FROM tournaments t
       WHERE status IN ('open','in_progress')
       ORDER BY start_at ASC`
    ).catch(() => ({ rows: [] }));
    res.json({ tournaments: rows });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/tournaments/:id
exports.getTournament = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT t.*,
              (SELECT json_agg(json_build_object(
                'id',s.id,'name',s.full_name,'avatar',s.avatar_url,
                'school',s.school_name,'seed',tr.seed
              ) ORDER BY tr.seed)
               FROM tournament_registrations tr
               JOIN students s ON s.id = tr.student_id
               WHERE tr.tournament_id=t.id
              ) as participants
       FROM tournaments t WHERE t.id=$1`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!rows.length) return res.status(404).json({ error: 'Tournament not found.' });
    res.json(rows[0]);
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/tournaments  (admin)
exports.createTournament = async (req, res) => {
  try {
    const { name, subject, maxSize = 16, startAt, prizes } = req.body;
    const id = `TOUR_${Date.now()}_${Math.random().toString(36).slice(2,5).toUpperCase()}`;

    const t = {
      id,
      name:    name || 'Scholar Tournament',
      subject: subject || 'Mixed',
      maxSize: parseInt(maxSize),
      bracket: [],
      status:  'open',
      startAt: startAt || new Date(Date.now() + 24 * 3600_000).toISOString(),
      prizes:  prizes || {
        first:  { coins: 5000, gems: 200, badge: 'tournament_champion', title: 'champion' },
        second: { coins: 2000, gems: 80 },
        third:  { coins: 1000, gems: 30 },
      },
      participants: [],
    };

    await saveTournamentToDB(t);
    tournaments.set(id, t);
    res.json({ success: true, tournament: t });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/tournaments/:id/register
exports.registerForTournament = async (req, res) => {
  try {
    const sid = req.student.id;
    const tid = req.params.id;

    const tournament = await db.query(
      `SELECT * FROM tournaments WHERE id=$1`, [tid]
    ).then(r => r.rows[0]);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });
    if (tournament.status !== 'open') return res.status(400).json({ error: 'Registration is closed.' });

    const count = await db.query(
      `SELECT COUNT(*) FROM tournament_registrations WHERE tournament_id=$1`, [tid]
    ).then(r => parseInt(r.rows[0].count));
    if (count >= tournament.max_size)
      return res.status(400).json({ error: 'Tournament is full.' });

    const already = await db.query(
      `SELECT id FROM tournament_registrations WHERE tournament_id=$1 AND student_id=$2`, [tid, sid]
    );
    if (already.rows.length) return res.status(400).json({ error: 'Already registered.' });

    await db.query(
      `INSERT INTO tournament_registrations (tournament_id, student_id, registered_at)
       VALUES ($1,$2,NOW())`,
      [tid, sid]
    );

    res.json({ success: true, position: count + 1, message: 'Registered! Check back before start time.' });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/tournaments/:id/start  (admin)
exports.startTournament = async (req, res) => {
  try {
    const tid = req.params.id;
    const io  = req.app.get('io');

    const tournament = await db.query(`SELECT * FROM tournaments WHERE id=$1`, [tid]).then(r => r.rows[0]);
    if (!tournament) return res.status(404).json({ error: 'Not found.' });
    if (tournament.status !== 'open') return res.status(400).json({ error: 'Already started.' });

    const participants = await db.query(
      `SELECT s.id, s.full_name as name, s.avatar_url, s.school_name,
              COALESCE(s.arena_rank_score,0) as rank_score
       FROM tournament_registrations tr
       JOIN students s ON s.id = tr.student_id
       WHERE tr.tournament_id=$1
       ORDER BY COALESCE(s.arena_rank_score,0) DESC`,
      [tid]
    ).then(r => r.rows);

    if (participants.length < 4) return res.status(400).json({ error: 'Need at least 4 players.' });

    const bracket = buildBracket([...participants]);

    await db.query(
      `UPDATE tournaments SET status='in_progress', bracket_json=$1 WHERE id=$2`,
      [JSON.stringify(bracket), tid]
    );

    // Assign room codes for round 1 matches
    for (const match of bracket[0]) {
      if (match.player1?.id && match.player2?.id) {
        match.roomCode = `TOUR_${tid.slice(-4)}_R1M${match.id.slice(-1)}`;
        match.status   = 'active';
      } else if (!match.player2?.id) {
        // BYE — auto-advance player1
        match.winner = match.player1;
        match.status = 'done';
      }
    }

    // Notify all participants
    for (const p of participants) {
      const match = bracket[0].find(m => m.player1?.id === p.id || m.player2?.id === p.id);
      if (match) {
        io.to(`student:${p.id}`).emit('tournament:match_assigned', {
          tournamentId: tid,
          match,
          opponent: match.player1?.id === p.id ? match.player2 : match.player1,
          roomCode: match.roomCode,
        });
      }
    }

    res.json({ success: true, bracket, participants: participants.length });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/tournaments/:id/submit-result  (called by Arena engine)
exports.submitMatchResult = async (req, res) => {
  try {
    const { matchId, winnerId } = req.body;
    const tid = req.params.id;
    const io  = req.app.get('io');

    const tournament = await db.query(`SELECT * FROM tournaments WHERE id=$1`, [tid]).then(r => r.rows[0]);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found.' });

    const bracket = JSON.parse(tournament.bracket_json || '[]');

    // Find the match across all rounds
    let foundRound = -1, foundMatchIdx = -1;
    bracket.forEach((round, ri) => {
      round.forEach((match, mi) => {
        if (match.id === matchId) { foundRound = ri; foundMatchIdx = mi; }
      });
    });
    if (foundRound === -1) return res.status(404).json({ error: 'Match not found in bracket.' });

    const match = bracket[foundRound][foundMatchIdx];
    const winner = [match.player1, match.player2].find(p => p?.id === parseInt(winnerId));
    if (!winner) return res.status(400).json({ error: 'Winner not found in match.' });

    match.winner = winner;
    match.status = 'done';

    // Advance winner to next round
    const nextRound = foundRound + 1;
    if (nextRound < bracket.length) {
      const nextMatchIdx = Math.floor(foundMatchIdx / 2);
      const isFirstSlot  = foundMatchIdx % 2 === 0;
      if (!bracket[nextRound][nextMatchIdx]) bracket[nextRound][nextMatchIdx] = {};
      if (isFirstSlot) bracket[nextRound][nextMatchIdx].player1 = winner;
      else             bracket[nextRound][nextMatchIdx].player2 = winner;

      // Assign room code if both players are now set
      const nm = bracket[nextRound][nextMatchIdx];
      if (nm.player1?.id && nm.player2?.id && !nm.roomCode) {
        nm.roomCode = `TOUR_${tid.slice(-4)}_R${nextRound + 1}M${nextMatchIdx + 1}`;
        nm.status   = 'active';
        nm.id       = `R${nextRound + 1}_M${nextMatchIdx + 1}`;

        // Notify both players
        for (const p of [nm.player1, nm.player2]) {
          io.to(`student:${p.id}`).emit('tournament:match_assigned', {
            tournamentId: tid,
            match:        nm,
            opponent:     nm.player1.id === p.id ? nm.player2 : nm.player1,
            roomCode:     nm.roomCode,
          });
        }
      }
    }

    // Check if tournament is finished (all last-round matches done)
    const lastRound = bracket[bracket.length - 1];
    const allDone   = lastRound.every(m => m.status === 'done');

    if (allDone) {
      const grandWinner = lastRound[0].winner;
      await endTournament(tid, bracket, grandWinner, io);
    } else {
      await db.query(`UPDATE tournaments SET bracket_json=$1 WHERE id=$2`, [JSON.stringify(bracket), tid]);
    }

    res.json({ success: true, bracket });
  } catch (err) {
    serverError(res, err);
  }
};

async function endTournament(tid, bracket, grandWinner, io) {
  await db.query(
    `UPDATE tournaments SET status='finished', winner_id=$1, bracket_json=$2, ended_at=NOW() WHERE id=$3`,
    [grandWinner.id, JSON.stringify(bracket), tid]
  );

  // Award prizes
  const prizes = await db.query(
    `SELECT prizes_json FROM tournaments WHERE id=$1`, [tid]
  ).then(r => JSON.parse(r.rows[0]?.prizes_json || '{}')).catch(() => ({}));

  if (prizes.first) {
    const p = prizes.first;
    if (p.coins) await db.query(`UPDATE students SET coins=COALESCE(coins,0)+$1 WHERE id=$2`, [p.coins, grandWinner.id]);
    if (p.gems)  await db.query(`UPDATE students SET gems=COALESCE(gems,0)+$1 WHERE id=$2`, [p.gems, grandWinner.id]);
    await db.query(`UPDATE students SET tournament_wins=COALESCE(tournament_wins,0)+1 WHERE id=$1`, [grandWinner.id]);

    fxVictory(io, grandWinner.id, { mode: 'tournament', coinsEarned: p.coins || 0, xpEarned: 1000 });
    fxConfetti(io, grandWinner.id, { reason: 'Tournament Champion!', color: 'rainbow', intensity: 'explosion' });

    if (p.badge) {
      const { awardBadge } = require('./badgesController');
      const badge = require('./badgesController').BADGES.find(b => b.id === p.badge);
      if (badge) { await awardBadge(grandWinner.id, p.badge, io); }
    }
  }

  // Broadcast tournament end to all participants
  if (io) {
    io.of('/tournament').to(tid).emit('tournament:finished', {
      winner:       grandWinner,
      tournamentId: tid,
    });
  }
}

// ── SOCKET ENGINE ─────────────────────────────────────────
function initTournament(io) {
  const ns = io.of('/tournament');

  ns.on('connection', socket => {
    socket.on('tournament:join_room', ({ tournamentId }) => {
      socket.join(tournamentId);
    });
    socket.on('tournament:leave_room', ({ tournamentId }) => {
      socket.leave(tournamentId);
    });
  });
}

module.exports = {
  listTournaments:     exports.listTournaments,
  getTournament:       exports.getTournament,
  createTournament:    exports.createTournament,
  registerForTournament: exports.registerForTournament,
  startTournament:     exports.startTournament,
  submitMatchResult:   exports.submitMatchResult,
  initTournament,
};
