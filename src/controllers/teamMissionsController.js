/**
 * TEAM MISSIONS CONTROLLER
 * ─────────────────────────────────────────────────────────
 * From the Innovation Doc:
 *   - Squad / team cooperative missions
 *   - All squad members contribute progress toward shared goals
 *   - Rewards split among squad on completion
 *   - Mission types: exam_streak, arena_wins, blitz_wins,
 *     study_room_time, questions_answered, survival_played
 *
 * Tables (see migrations/innovation_tables.sql):
 *   team_missions         (id, name, description, type, target, reward_coins, reward_gems, expires_at)
 *   squad_mission_progress (squad_id, mission_id, current, completed, completed_at)
 */

const db = require('../config/db');
const { fxCoinFly, fxConfetti } = require('./microController');
const { serverError } = require('../utils/errors');

// ── MISSION CATALOGUE ─────────────────────────────────────

const TEAM_MISSIONS = [
  {
    id:           'team_exam_100',
    name:         'Study Squad',
    description:  'Answer 100 exam questions combined as a squad',
    icon:         '📚',
    type:         'questions_answered',
    target:       100,
    rewardCoins:  500,
    rewardGems:   20,
    rewardXP:     300,
    resetPeriod:  'daily',
  },
  {
    id:           'team_arena_10',
    name:         'Arena Squad',
    description:  'Win 10 Arena battles combined as a squad',
    icon:         '⚔️',
    type:         'arena_wins',
    target:       10,
    rewardCoins:  800,
    rewardGems:   35,
    rewardXP:     500,
    resetPeriod:  'daily',
  },
  {
    id:           'team_blitz_5',
    name:         'Blitz Force',
    description:  'Win 5 Blitz Mode matches combined as a squad',
    icon:         '⚡',
    type:         'blitz_wins',
    target:       5,
    rewardCoins:  600,
    rewardGems:   25,
    rewardXP:     400,
    resetPeriod:  'daily',
  },
  {
    id:           'team_study_room_60',
    name:         'Study Marathon',
    description:  'Spend 60 minutes total in Study Rooms as a squad',
    icon:         '🎓',
    type:         'study_room_minutes',
    target:       60,
    rewardCoins:  400,
    rewardGems:   15,
    rewardXP:     200,
    resetPeriod:  'daily',
  },
  {
    id:           'team_survival_3',
    name:         'Survivors United',
    description:  'Play 3 Survival Mode matches as a squad',
    icon:         '💀',
    type:         'survival_played',
    target:       3,
    rewardCoins:  700,
    rewardGems:   30,
    rewardXP:     450,
    resetPeriod:  'daily',
  },
  {
    id:           'team_school_war_1',
    name:         'Warriors',
    description:  'Participate in 1 School War',
    icon:         '🏰',
    type:         'school_wars_played',
    target:       1,
    rewardCoins:  1000,
    rewardGems:   50,
    rewardXP:     600,
    resetPeriod:  'weekly',
  },
  {
    id:           'team_streak_5',
    name:         'Squad Streak',
    description:  'All squad members maintain a 5-day study streak',
    icon:         '🔥',
    type:         'all_members_streak_5',
    target:       5,
    rewardCoins:  1200,
    rewardGems:   60,
    rewardXP:     800,
    resetPeriod:  'weekly',
  },
  {
    id:           'team_exam_perfect_3',
    name:         'Perfect Scholars',
    description:  'Score 100% in 3 exams combined as a squad',
    icon:         '💯',
    type:         'perfect_scores',
    target:       3,
    rewardCoins:  1500,
    rewardGems:   75,
    rewardXP:     1000,
    resetPeriod:  'weekly',
  },
];

// ── HELPERS ───────────────────────────────────────────────

async function getStudentSquad(studentId) {
  const res = await db.query(
    `SELECT squad_id FROM squad_members WHERE student_id=$1 LIMIT 1`, [studentId]
  ).catch(() => ({ rows: [] }));
  return res.rows[0]?.squad_id || null;
}

async function getSquadMembers(squadId) {
  const res = await db.query(
    `SELECT student_id FROM squad_members WHERE squad_id=$1`, [squadId]
  ).catch(() => ({ rows: [] }));
  return res.rows.map(r => r.student_id);
}

// ── PROGRESS UPDATER — called by other controllers ────────

async function updateTeamMissionProgress(studentId, missionType, amount = 1, io) {
  try {
    const squadId = await getStudentSquad(studentId);
    if (!squadId) return;

    const missions = TEAM_MISSIONS.filter(m => m.type === missionType);
    if (!missions.length) return;

    for (const mission of missions) {
      // FIX (worse version of the race fixed elsewhere this session):
      // this used to SELECT current/completed, then a separate INSERT/
      // UPDATE — not atomic. Since squad missions are updated by EVERY
      // member's activity, this race is far easier to hit than a
      // single-player claim race: two squad members finishing an exam
      // within moments of each other both call this concurrently, both
      // read completed=false, both compute newCurrent >= target, and
      // both call completeMission — double-awarding coins/gems/XP to
      // EVERY member of the squad, not just one student.
      //
      // Fixed with an atomic upsert: the INSERT...ON CONFLICT DO UPDATE
      // does the read-modify-write as one statement, and completed=false
      // in the WHERE-equivalent (the CASE) ensures a mission already
      // marked complete can't be bumped further. RETURNING tells this
      // exact call whether IT was the one that crossed the target,
      // rather than a second concurrent call also seeing >= target from
      // a stale read.
      const upserted = await db.query(
        `INSERT INTO squad_mission_progress (squad_id, mission_id, current)
         VALUES ($1,$2,LEAST($3,$4))
         ON CONFLICT (squad_id, mission_id) DO UPDATE SET
           current = LEAST(squad_mission_progress.current + $3, $4)
         WHERE squad_mission_progress.completed = false
         RETURNING current, completed`,
        [squadId, mission.id, amount, mission.target]
      ).catch(err => {
        if (err.code !== '42P01') console.error('squad_mission_progress upsert failed:', err.message);
        return { rows: [] };
      });

      if (!upserted.rows.length) continue; // already completed — WHERE clause excluded it, nothing to do
      const newCurrent = upserted.rows[0].current;
      const alreadyCompleted = upserted.rows[0].completed;

      // Broadcast progress to all squad members
      const members = await getSquadMembers(squadId);
      if (io) {
        for (const memberId of members) {
          io.to(`student:${memberId}`).emit('team_mission:progress', {
            missionId:  mission.id,
            missionName: mission.name,
            current:    newCurrent,
            target:     mission.target,
            percent:    Math.round((newCurrent / mission.target) * 100),
          });
        }
      }

      // Check completion — the atomic UPDATE above already guarantees
      // only ONE concurrent caller can be the one whose current value
      // actually crosses the target (everyone else's WHERE clause either
      // saw completed=true already, or a current value that had already
      // been bumped past target by the winner). Still double-check
      // `!alreadyCompleted` so a call that lands exactly on an
      // already-finished mission (edge case: two calls both push current
      // to exactly `target` in the same instant) doesn't complete twice.
      if (newCurrent >= mission.target && !alreadyCompleted) {
        // Atomically flip completed — same compare-and-swap pattern:
        // only the caller whose UPDATE actually flips false→true proceeds
        // to award rewards.
        const claim = await db.query(
          `UPDATE squad_mission_progress SET completed=true, completed_at=NOW()
           WHERE squad_id=$1 AND mission_id=$2 AND completed=false`,
          [squadId, mission.id]
        );
        if (claim.rowCount > 0) {
          await completeMission(squadId, mission, members, io);
        }
      }
    }
  } catch (err) {
    console.error('updateTeamMissionProgress error:', err.message);
  }
}

async function completeMission(squadId, mission, members, io) {
  await db.query(
    `UPDATE squad_mission_progress SET completed=true, completed_at=NOW()
     WHERE squad_id=$1 AND mission_id=$2`,
    [squadId, mission.id]
  ).catch(() => {});

  // Award every squad member
  for (const memberId of members) {
    await db.query(
      `UPDATE students SET
         coins  = COALESCE(coins,0)  + $1,
         gems   = COALESCE(gems,0)   + $2,
         points = COALESCE(points,0) + $3
       WHERE id=$4`,
      [mission.rewardCoins, mission.rewardGems, mission.rewardXP, memberId]
    ).catch(() => {});

    // Track squad wins for badge
    if (mission.type === 'arena_wins') {
      await db.query(
        `UPDATE students SET squad_wins=COALESCE(squad_wins,0)+1 WHERE id=$1`, [memberId]
      ).catch(() => {});
    }

    if (io) {
      fxCoinFly(io, memberId, mission.rewardCoins, 'team_mission');
      fxConfetti(io, memberId, { reason: `Squad Mission: ${mission.name}!`, color: 'gold', intensity: 'heavy' });
      io.to(`student:${memberId}`).emit('team_mission:completed', {
        mission,
        rewards: {
          coins: mission.rewardCoins,
          gems:  mission.rewardGems,
          xp:    mission.rewardXP,
        },
      });
    }
  }

  // Log in mission completions history
  await db.query(
    `INSERT INTO team_mission_history (squad_id, mission_id, completed_at, reward_coins, reward_gems)
     VALUES ($1,$2,NOW(),$3,$4)`,
    [squadId, mission.id, mission.rewardCoins, mission.rewardGems]
  ).catch(() => {});
}

// ── REST ENDPOINTS ────────────────────────────────────────

// GET /api/team-missions
exports.getTeamMissions = async (req, res) => {
  try {
    const sid     = req.student.id;
    const squadId = await getStudentSquad(sid);

    if (!squadId) {
      return res.json({ missions: TEAM_MISSIONS.map(m => ({ ...m, current: 0, completed: false, hasSquad: false })) });
    }

    // Get squad member count and names
    const members = await db.query(
      `SELECT s.id, s.full_name, s.avatar_url
       FROM squad_members sm JOIN students s ON s.id=sm.student_id
       WHERE sm.squad_id=$1`,
      [squadId]
    ).catch(() => ({ rows: [] }));

    const progress = await db.query(
      `SELECT mission_id, current, completed, completed_at
       FROM squad_mission_progress WHERE squad_id=$1`,
      [squadId]
    ).then(r => Object.fromEntries(r.rows.map(p => [p.mission_id, p]))).catch(() => ({}));

    const missions = TEAM_MISSIONS.map(m => ({
      ...m,
      current:      parseInt(progress[m.id]?.current || 0),
      completed:    !!progress[m.id]?.completed,
      completedAt:  progress[m.id]?.completed_at || null,
      percent:      Math.round((parseInt(progress[m.id]?.current || 0) / m.target) * 100),
      hasSquad:     true,
    }));

    res.json({ missions, squadId, members: members.rows });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/team-missions/history
exports.getTeamMissionHistory = async (req, res) => {
  try {
    const sid     = req.student.id;
    const squadId = await getStudentSquad(sid);
    if (!squadId) return res.json({ history: [] });

    const { rows } = await db.query(
      `SELECT tmh.*, sq.name as squad_name
       FROM team_mission_history tmh
       JOIN squads sq ON sq.id = tmh.squad_id
       WHERE tmh.squad_id=$1
       ORDER BY tmh.completed_at DESC LIMIT 30`,
      [squadId]
    ).catch(() => ({ rows: [] }));

    const history = rows.map(r => {
      const mission = TEAM_MISSIONS.find(m => m.id === r.mission_id);
      return { ...r, missionName: mission?.name, missionIcon: mission?.icon };
    });

    res.json({ history });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/team-missions/reset  (admin / cron)
exports.resetDailyMissions = async (req, res) => {
  try {
    const dailyIds = TEAM_MISSIONS.filter(m => m.resetPeriod === 'daily').map(m => m.id);
    if (!dailyIds.length) return res.json({ reset: 0 });

    // FIX: this used to run two DELETEs — the first scoped to
    // completed=false, the second unconditional on the same mission_ids
    // (to also clear completed ones for the new day). The second query's
    // effect fully supersedes the first, but the response reported only
    // the FIRST delete's rowCount — undercounting how many rows actually
    // got reset (e.g. 3 incomplete + 5 completed = 8 actually deleted,
    // but the response said "reset: 3"). Not a functional bug (the reset
    // itself worked correctly either way), just a wrong number reported
    // back to whoever's calling this. One unconditional DELETE does the
    // same job in one round trip with an accurate count.
    const result = await db.query(
      `DELETE FROM squad_mission_progress WHERE mission_id = ANY($1)`,
      [dailyIds]
    );

    res.json({ success: true, reset: result.rowCount });
  } catch (err) {
    serverError(res, err);
  }
};

exports.resetWeeklyMissions = async (req, res) => {
  try {
    const weeklyIds = TEAM_MISSIONS.filter(m => m.resetPeriod === 'weekly').map(m => m.id);
    await db.query(`DELETE FROM squad_mission_progress WHERE mission_id = ANY($1)`, [weeklyIds]);
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
};

module.exports = {
  TEAM_MISSIONS,
  updateTeamMissionProgress,
  getTeamMissions:      exports.getTeamMissions,
  getTeamMissionHistory:exports.getTeamMissionHistory,
  resetDailyMissions:   exports.resetDailyMissions,
  resetWeeklyMissions:  exports.resetWeeklyMissions,
};
