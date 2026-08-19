/**
 * SPIRIT ACTIVE SKILLS HANDLER
 * ─────────────────────────────────────────────────────────
 * Integrates with arenaEngine: players activate their
 * equipped Spirit's active skill once per match.
 *
 * Socket events (on /arena namespace):
 *   spirit:activate  → client fires skill
 *   spirit:effect    → server broadcasts effect to target(s)
 *   spirit:cooldown  → server tells activating player their CD status
 */

const { SPIRITS } = require('../controllers/spiritsController');
const db           = require('../config/db');

// Per-match cooldown tracking: matchKey -> Map<playerId, { used, activatedAt }>
const matchSkillState = new Map();

function matchKey(roomCode, playerId) {
  return `${roomCode}:${playerId}`;
}

function getSkillState(roomCode, playerId) {
  const k = matchKey(roomCode, playerId);
  if (!matchSkillState.has(k)) matchSkillState.set(k, { used: false, activatedAt: null });
  return matchSkillState.get(k);
}

function clearMatchState(roomCode) {
  for (const k of matchSkillState.keys()) {
    if (k.startsWith(`${roomCode}:`)) matchSkillState.delete(k);
  }
}

// Skill effect definitions — what each active skill does server-side
const SKILL_EFFECTS = {
  void_weaver: {
    name:        'WEB TRAP',
    targetType:  'opponent',        // fires at opponent(s)
    effectEvent: 'spirit:webTrap',  // client: blur answer buttons for duration
    duration:    3000,
    message:     '🕷️ Web Trap! Your opponent\'s controls are disrupted!',
  },
  oracle_owl: {
    name:        'FORESIGHT',
    targetType:  'self',            // helps the activating player
    effectEvent: 'spirit:foresight',
    duration:    0,
    message:     '🦉 Foresight! One wrong answer is revealed!',
  },
  ember_wyrm: {
    name:        'INFERNO BOOST',
    targetType:  'self',
    effectEvent: 'spirit:infernoBoost',
    duration:    180000,            // 3 minutes server-side flag
    message:     '🐉 Inferno Boost! 2× XP and coins for this match!',
  },
  neuro_bot: {
    name:        'TARGET ANALYSIS',
    targetType:  'self',
    effectEvent: 'spirit:targetAnalysis',
    duration:    0,
    message:     '🤖 Target Analysis! Weakest answers highlighted!',
  },
  storm_fox: {
    name:        'THUNDER DASH',
    targetType:  'self',
    effectEvent: 'spirit:thunderDash',
    duration:    5000,              // +5s added to their next timer
    message:     '🦊 Thunder Dash! +5 seconds on your next question!',
  },
  crystal_phoenix: {
    name:        'REBIRTH FLAME',
    targetType:  'self',
    effectEvent: 'spirit:rebirthFlame',
    duration:    0,
    message:     '🦅 Rebirth Flame! You\'ll revive once if eliminated!',
  },
  shadow_lynx: {
    name:        'SHADOW STEP',
    targetType:  'self',
    effectEvent: 'spirit:shadowStep',
    duration:    0,
    message:     '🐱 Shadow Step! Skip one question without losing your streak!',
  },
  aqua_serpent: {
    name:        'HYDRO SURGE',
    targetType:  'self',
    effectEvent: 'spirit:hydroSurge',
    duration:    0,
    message:     '🐍 Hydro Surge! All active debuffs cleared!',
  },
};

/**
 * Register spirit skill socket events on the arena namespace.
 * Call this inside initArena() after the arena namespace is set up.
 *
 * @param {SocketIO.Namespace} arena  - the /arena namespace
 * @param {Map}                rooms  - shared rooms map from arenaEngine
 * @param {Map}                players - shared players map from arenaEngine
 */
function registerSpiritSkills(arena, rooms, players) {

  arena.on('connection', socket => {

    // ── ACTIVATE SPIRIT SKILL ─────────────────────────────
    socket.on('spirit:activate', async (data, cb) => {
      try {
        const { playerId, roomCode } = data;
        const room = rooms.get(roomCode?.toUpperCase());

        if (!room || room.status !== 'playing') {
          return cb?.({ success: false, error: 'No active match.' });
        }

        const state = getSkillState(roomCode, playerId);
        if (state.used) {
          return cb?.({ success: false, error: 'Spirit skill already used this match.' });
        }

        // Fetch equipped spirit for this player
        const equippedRow = await db.query(
          `SELECT ss.spirit_id FROM student_spirits ss
           WHERE ss.student_id=$1 AND ss.equipped=true LIMIT 1`,
          [playerId]
        ).catch(() => ({ rows: [] }));

        if (!equippedRow.rows.length) {
          return cb?.({ success: false, error: 'No spirit equipped.' });
        }

        const spirit = SPIRITS.find(s => s.id === equippedRow.rows[0].spirit_id);
        if (!spirit) return cb?.({ success: false, error: 'Spirit not found.' });

        const effect = SKILL_EFFECTS[spirit.id];
        if (!effect) return cb?.({ success: false, error: 'Skill not implemented yet.' });

        // Mark as used
        state.used         = true;
        state.activatedAt  = Date.now();
        state.spiritId     = spirit.id;

        // ── RESOLVE TARGETS ───────────────────────────────
        if (effect.targetType === 'self') {
          // Send effect to the activating player's socket
          socket.emit(effect.effectEvent, {
            spirit:   spirit.id,
            name:     spirit.name,
            skill:    effect.name,
            duration: effect.duration,
            message:  effect.message,
          });

          // Track inferno boost multiplier for saveMatch reward calculation
          if (spirit.id === 'ember_wyrm') {
            if (!room.activeBoosts) room.activeBoosts = new Map();
            room.activeBoosts.set(playerId, { type: 'xp2x_coin2x', expires: Date.now() + effect.duration });
          }

          // Track rebirth for crystal_phoenix
          if (spirit.id === 'crystal_phoenix') {
            if (!room.rebirths) room.rebirths = new Set();
            room.rebirths.add(playerId);
          }

          // Track shadow step (skip without streak break)
          if (spirit.id === 'shadow_lynx') {
            if (!room.shadowSteps) room.shadowSteps = new Set();
            room.shadowSteps.add(playerId);
          }

        } else if (effect.targetType === 'opponent') {
          // Find opponent sockets (everyone else in the room)
          const opponents = [...room.players.entries()]
            .filter(([, p]) => p.id !== playerId && !room.eliminated.has(p.id));

          for (const [opponentSocketId] of opponents) {
            arena.to(opponentSocketId).emit(effect.effectEvent, {
              spirit:      spirit.id,
              name:        spirit.name,
              skill:       effect.name,
              duration:    effect.duration,
              fromPlayer:  playerId,
              message:     `🕷️ Opponent activated ${spirit.name}!`,
            });
          }
        }

        // Broadcast activation announcement to the room
        arena.to(roomCode).emit('spirit:activated', {
          playerId,
          playerName: room.players.get(socket.id)?.name || 'Unknown',
          spirit:     spirit.id,
          spiritName: spirit.name,
          icon:       spirit.icon,
          skillName:  effect.name,
          message:    effect.message,
        });

        cb?.({ success: true, skill: effect.name, message: effect.message });

      } catch (err) {
        console.error('spirit:activate error:', err.message);
        cb?.({ success: false, error: 'Failed to activate skill.' });
      }
    });

    // ── QUERY SKILL STATUS ─────────────────────────────────
    socket.on('spirit:status', async (data, cb) => {
      try {
        const { playerId, roomCode } = data;
        const state = getSkillState(roomCode, playerId);

        const equippedRow = await db.query(
          `SELECT ss.spirit_id FROM student_spirits ss
           WHERE ss.student_id=$1 AND ss.equipped=true LIMIT 1`,
          [playerId]
        ).catch(() => ({ rows: [] }));

        const spirit = equippedRow.rows.length
          ? SPIRITS.find(s => s.id === equippedRow.rows[0].spirit_id)
          : null;

        cb?.({
          equipped:  spirit ? spirit.id : null,
          icon:      spirit?.icon || null,
          skillName: spirit ? (SKILL_EFFECTS[spirit.id]?.name || spirit.active.name) : null,
          used:      state.used,
          canUse:    !!spirit && !state.used,
        });
      } catch (err) {
        cb?.({ equipped: null, canUse: false, error: err.message });
      }
    });

    // ── APPLY VOID WEAVER TIMER EXTENSION (storm_fox) ─────
    // Client calls this after a thunderDash question to report extra time
    socket.on('spirit:timerGranted', (data) => {
      // Just an ack — the actual extra time is managed client-side
      // Server already knows it was granted via the spirit:activate flow
    });

    // ── ROOM CLEANUP: clear skill state when room ends ─────
    socket.on('room:cleanup', ({ roomCode }) => {
      clearMatchState(roomCode?.toUpperCase());
    });
  });
}

// Called by saveMatch in arenaEngine to apply Spirit boost multipliers to rewards
function applyBoosts(room, playerId, baseXP, baseCoins) {
  if (!room.activeBoosts) return { xp: baseXP, coins: baseCoins };
  const boost = room.activeBoosts.get(playerId);
  if (!boost || Date.now() > boost.expires) return { xp: baseXP, coins: baseCoins };
  return { xp: baseXP * 2, coins: baseCoins * 2 };
}

module.exports = { registerSpiritSkills, clearMatchState, applyBoosts };
