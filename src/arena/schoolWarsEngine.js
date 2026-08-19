/**
 * SCHOOL WARS ENGINE
 * ─────────────────────────────────────────────────────────
 * Inter-school battles tied to the Factions system.
 *
 * Flow:
 *  1. Any student can issue a "School War Challenge" to a rival school
 *  2. A student from the rival school accepts (becomes battle captain)
 *  3. Both captains recruit up to 5 squad members from their school
 *  4. War consists of a best-of-3 Arena clash_squad match
 *  5. Winning school earns Faction XP, a trophy, coins for participants
 *  6. Leaderboard tracks school win/loss records per Season
 *
 * Socket namespace: /school-wars
 */

const db = require('../config/db');

const wars    = new Map();   // warId -> warObject
const warRooms = new Map();  // warId -> socket room code

function warId() {
  return `WAR_${Date.now()}_${Math.random().toString(36).slice(2,7).toUpperCase()}`;
}

function newWar(opts) {
  return {
    id:              opts.id,
    challengerSchool: opts.challengerSchool,
    challengerName:   opts.challengerName,  // captain name
    challengerId:     opts.challengerId,
    rivalSchool:      opts.rivalSchool,
    rivalCaptainId:   null,
    rivalCaptainName: null,
    subject:          opts.subject || null,  // null = mixed
    status:           'pending',             // pending|accepted|in_progress|finished
    round:            0,
    maxRounds:        3,
    roundResults:     [],                    // [{winner: schoolName, scores: [...]}]
    challengerWins:   0,
    rivalWins:        0,
    members:          {
      challenger: [{ id: opts.challengerId, name: opts.challengerName }],
      rival:      [],
    },
    maxMembers:       5,
    createdAt:        Date.now(),
    expiresAt:        Date.now() + 24 * 60 * 60 * 1000,  // 24h to accept
    currentRoomCode:  null,
    factionXPReward:  200,  // per win for the school
    coinRewardWinner: 100,  // per participant on winning side
    coinRewardLoser:  25,
  };
}

// ── DB HELPERS ────────────────────────────────────────────

async function awardFactionXP(school, xp) {
  try {
    await db.query(
      `UPDATE students SET faction_xp = COALESCE(faction_xp,0) + $1
       WHERE school_name=$2`,
      [xp, school]
    );
    await db.query(
      `INSERT INTO school_faction_stats (school_name, total_faction_xp, wars_won)
       VALUES ($1,$2,1)
       ON CONFLICT (school_name) DO UPDATE SET
         total_faction_xp = school_faction_stats.total_faction_xp + $2,
         wars_won         = school_faction_stats.wars_won + 1,
         updated_at       = NOW()`,
      [school, xp]
    ).catch(() => {});
  } catch (err) {
    console.error('awardFactionXP error:', err.message);
  }
}

async function awardParticipants(war, winningSide) {
  try {
    const winners = war.members[winningSide];
    const losers  = winningSide === 'challenger' ? war.members.rival : war.members.challenger;

    for (const p of winners) {
      await db.query(
        `UPDATE students SET coins=COALESCE(coins,0)+$1, points=COALESCE(points,0)+100 WHERE id=$2`,
        [war.coinRewardWinner, p.id]
      ).catch(() => {});
    }
    for (const p of losers) {
      await db.query(
        `UPDATE students SET coins=COALESCE(coins,0)+$1 WHERE id=$2`,
        [war.coinRewardLoser, p.id]
      ).catch(() => {});
    }

    // Record in war history
    await db.query(
      `INSERT INTO school_war_history
         (war_id, challenger_school, rival_school, winner_school,
          challenger_wins, rival_wins, subject, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (war_id) DO NOTHING`,
      [
        war.id, war.challengerSchool, war.rivalSchool,
        winningSide === 'challenger' ? war.challengerSchool : war.rivalSchool,
        war.challengerWins, war.rivalWins, war.subject,
      ]
    ).catch(() => {});
  } catch (err) {
    console.error('awardParticipants error:', err.message);
  }
}

// ── REST CONTROLLERS ──────────────────────────────────────

// GET /api/school-wars/leaderboard
exports.getWarLeaderboard = async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT school_name,
             COALESCE(total_faction_xp,0) as faction_xp,
             COALESCE(wars_won,0)         as wars_won,
             COALESCE(wars_played,0)      as wars_played
      FROM school_faction_stats
      ORDER BY total_faction_xp DESC
      LIMIT 50
    `).catch(() => ({ rows: [] }));

    res.json({
      leaderboard: rows.map((r, i) => ({
        rank:       i + 1,
        school:     r.school_name,
        factionXP:  parseInt(r.faction_xp)  || 0,
        warsWon:    parseInt(r.wars_won)     || 0,
        warsPlayed: parseInt(r.wars_played)  || 0,
        winRate:    r.wars_played > 0
          ? Math.round((r.wars_won / r.wars_played) * 100)
          : 0,
        badge: i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : '⚔️',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/school-wars/active
exports.getActiveWars = async (req, res) => {
  const school = req.student.school_name;
  const active = [...wars.values()].filter(
    w => (w.challengerSchool === school || w.rivalSchool === school) && w.status !== 'finished'
  );
  res.json({ wars: active });
};

// GET /api/school-wars/history
exports.getWarHistory = async (req, res) => {
  try {
    const school = req.student.school_name;
    const { rows } = await db.query(
      `SELECT * FROM school_war_history
       WHERE challenger_school=$1 OR rival_school=$1
       ORDER BY ended_at DESC LIMIT 20`,
      [school]
    ).catch(() => ({ rows: [] }));
    res.json({ history: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/school-wars/challenge
exports.issueChallenge = async (req, res) => {
  try {
    const { rivalSchool, subject } = req.body;
    const sid  = req.student.id;
    const name = req.student.full_name;
    const mySchool = req.student.school_name;

    if (!mySchool)    return res.status(400).json({ error: 'You must have a school to issue a war.' });
    if (!rivalSchool) return res.status(400).json({ error: 'Specify the rival school.' });
    if (mySchool.toLowerCase() === rivalSchool.toLowerCase())
      return res.status(400).json({ error: 'Cannot challenge your own school.' });

    // Check if war already pending between these schools
    const alreadyPending = [...wars.values()].find(
      w => w.status === 'pending' &&
           ((w.challengerSchool === mySchool && w.rivalSchool === rivalSchool) ||
            (w.challengerSchool === rivalSchool && w.rivalSchool === mySchool))
    );
    if (alreadyPending) return res.status(400).json({ error: 'A war challenge is already pending between these schools.' });

    const war = newWar({ id: warId(), challengerSchool: mySchool, challengerName: name, challengerId: sid, rivalSchool, subject });
    wars.set(war.id, war);

    res.json({ success: true, war });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/school-wars/:warId/accept
exports.acceptChallenge = async (req, res) => {
  try {
    const war  = wars.get(req.params.warId);
    if (!war || war.status !== 'pending') return res.status(404).json({ error: 'War not found or already started.' });
    if (war.rivalSchool !== req.student.school_name)
      return res.status(403).json({ error: 'You are not from the rival school.' });

    war.rivalCaptainId   = req.student.id;
    war.rivalCaptainName = req.student.full_name;
    war.members.rival.push({ id: req.student.id, name: req.student.full_name });
    war.status = 'accepted';

    res.json({ success: true, war });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/school-wars/:warId/join
exports.joinWar = async (req, res) => {
  try {
    const war = wars.get(req.params.warId);
    if (!war || war.status !== 'accepted') return res.status(404).json({ error: 'War not found or not accepting members.' });

    const school = req.student.school_name;
    const sid    = req.student.id;
    const name   = req.student.full_name;

    let side = null;
    if (school === war.challengerSchool)      side = 'challenger';
    else if (school === war.rivalSchool)      side = 'rival';
    else return res.status(403).json({ error: 'Not your war.' });

    const alreadyIn = war.members[side].find(m => m.id === sid);
    if (alreadyIn) return res.status(400).json({ error: 'Already joined.' });

    if (war.members[side].length >= war.maxMembers)
      return res.status(400).json({ error: `${side} side is full (${war.maxMembers} members max).` });

    war.members[side].push({ id: sid, name });
    res.json({ success: true, side, memberCount: war.members[side].length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── SOCKET ENGINE ──────────────────────────────────────────
function initSchoolWars(io) {
  const ns = io.of('/school-wars');

  ns.on('connection', socket => {

    // Captain starts the war (launches next round)
    socket.on('war:start_round', async ({ warId: wId, captainId }, cb) => {
      const war = wars.get(wId);
      if (!war) return cb?.({ success: false, error: 'War not found.' });
      if (captainId !== war.challengerId && captainId !== war.rivalCaptainId)
        return cb?.({ success: false, error: 'Only captains can start rounds.' });
      if (war.status === 'finished')
        return cb?.({ success: false, error: 'War is over.' });

      war.round++;
      war.status = 'in_progress';

      // Notify both schools to join the Arena clash_squad room
      const code = `WAR${war.round}_${war.id.slice(-4)}`;
      war.currentRoomCode = code;
      warRooms.set(wId, code);

      ns.to(wId).emit('war:round_start', {
        round: war.round, maxRounds: war.maxRounds,
        roomCode: code, subject: war.subject,
        challengerSchool: war.challengerSchool,
        rivalSchool:      war.rivalSchool,
        members:          war.members,
      });

      cb?.({ success: true, round: war.round, roomCode: code });
    });

    // Record a round result (called internally when arena match ends)
    socket.on('war:record_result', async ({ warId: wId, winnerSchool }, cb) => {
      const war = wars.get(wId);
      if (!war) return cb?.({ success: false });

      war.roundResults.push({ round: war.round, winner: winnerSchool });

      if (winnerSchool === war.challengerSchool) war.challengerWins++;
      else war.rivalWins++;

      const roundsToWin = Math.ceil(war.maxRounds / 2);

      if (war.challengerWins >= roundsToWin || war.rivalWins >= roundsToWin) {
        // War decided
        war.status       = 'finished';
        const winningSide  = war.challengerWins >= roundsToWin ? 'challenger' : 'rival';
        const winnerSchool = winningSide === 'challenger' ? war.challengerSchool : war.rivalSchool;

        await awardFactionXP(winnerSchool, war.factionXPReward);
        await awardParticipants(war, winningSide);

        ns.to(wId).emit('war:finished', {
          winner:          winnerSchool,
          challengerWins:  war.challengerWins,
          rivalWins:       war.rivalWins,
          factionXP:       war.factionXPReward,
          coinReward:      war.coinRewardWinner,
        });

        // Cleanup after 10 minutes
        setTimeout(() => wars.delete(wId), 10 * 60 * 1000);

      } else {
        // Continue to next round
        war.status = 'accepted';
        ns.to(wId).emit('war:round_end', {
          roundWinner:     winnerSchool,
          challengerWins:  war.challengerWins,
          rivalWins:       war.rivalWins,
          nextRound:       war.round + 1,
        });
      }

      cb?.({ success: true });
    });

    socket.on('war:join_room', ({ warId: wId }) => {
      socket.join(wId);
    });

    socket.on('war:leave_room', ({ warId: wId }) => {
      socket.leave(wId);
    });
  });
}

module.exports = { initSchoolWars, wars, warRooms,
  getWarLeaderboard: exports.getWarLeaderboard,
  getActiveWars: exports.getActiveWars,
  getWarHistory: exports.getWarHistory,
  issueChallenge: exports.issueChallenge,
  acceptChallenge: exports.acceptChallenge,
  joinWar: exports.joinWar,
};
