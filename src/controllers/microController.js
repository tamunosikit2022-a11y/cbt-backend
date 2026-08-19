/**
 * MICRO-INTERACTIONS SYSTEM
 * ─────────────────────────────────────────────────────────
 * Every action in the app should feel rewarding.
 *
 * From the Innovation Doc:
 *   - coins fly into wallet
 *   - XP bars animate
 *   - victory explosions
 *   - glowing text reveals
 *   - haptic feedback
 *   - sound effects
 *   - confetti bursts
 *   - aura activations
 *   - screen flashes during unlocks
 *
 * Architecture:
 *   - Backend emits typed FX events via Socket.io to the student's
 *     personal room (`student:<id>`)
 *   - Client listens for FX events and plays the matching animation
 *   - No frontend state is stored here — server is the source of truth
 *     on WHEN an event fires; client decides HOW to render it
 *
 * Socket room: student:<id>  (join on auth)
 * Namespace:   / (main namespace)
 *
 * FX Event Types
 * ─────────────────────────────────────────────────────────
 * fx:coin_fly       — coins earned, with amount and source
 * fx:xp_bar         — XP gain animation
 * fx:confetti       — level-up, badge unlock, rare reward
 * fx:victory        — win an Arena battle
 * fx:defeat         — lose an Arena battle (replay/revenge prompt)
 * fx:badge_unlock   — badge earned (confetti + glowing reveal)
 * fx:title_unlock   — new title unlocked
 * fx:spirit_evolve  — spirit evolution animation (cinematic)
 * fx:rank_up        — rank increased (pride moment)
 * fx:spin_win       — spin wheel landed on a reward
 * fx:streak_fire    — streak extended (fire animation)
 * fx:haptic         — haptic feedback instruction for mobile
 * fx:screen_flash   — full-screen flash on unlock/reward
 * fx:aura_activate  — spirit aura activation (during Arena)
 * fx:chest_open     — treasure chest opening animation
 * fx:season_reward  — season reward claimed (cinematic)
 */

const db = require('../config/db');

// ── FX EMITTER ────────────────────────────────────────────
// Central function — all backend systems call this to fire a micro-interaction

function emitFX(io, studentId, event, payload = {}) {
  if (!io) return;
  io.to(`student:${studentId}`).emit(event, {
    ...payload,
    ts: Date.now(),
  });
}

// ── COIN FLY ─────────────────────────────────────────────
// Call whenever coins are awarded.
// source: 'exam' | 'arena' | 'mission' | 'spin' | 'referral' | 'video' | 'pdf'
function fxCoinFly(io, studentId, amount, source = 'exam') {
  emitFX(io, studentId, 'fx:coin_fly', {
    amount,
    source,
    haptic:  'light',       // 'light' | 'medium' | 'heavy'
    sound:   'coin_clink',
  });
}

// ── XP BAR ANIMATION ─────────────────────────────────────
// Call after awarding XP. Include before/after values.
function fxXPBar(io, studentId, { before, after, levelBefore, levelAfter }) {
  emitFX(io, studentId, 'fx:xp_bar', {
    before,
    after,
    delta:       after - before,
    levelBefore,
    levelAfter,
    leveledUp:   levelAfter > levelBefore,
    haptic:      levelAfter > levelBefore ? 'heavy' : 'light',
    sound:       levelAfter > levelBefore ? 'level_up' : 'xp_tick',
  });

  if (levelAfter > levelBefore) {
    // Level-up triggers confetti
    fxConfetti(io, studentId, { reason: `Level ${levelAfter} reached!` });
  }
}

// ── CONFETTI ─────────────────────────────────────────────
function fxConfetti(io, studentId, { reason = '', color = 'gold', intensity = 'medium' } = {}) {
  emitFX(io, studentId, 'fx:confetti', {
    reason,
    color,       // 'gold' | 'purple' | 'rainbow' | 'red'
    intensity,   // 'light' | 'medium' | 'heavy' | 'explosion'
    haptic:      'medium',
    sound:       'confetti_pop',
  });
}

// ── VICTORY / DEFEAT ─────────────────────────────────────
function fxVictory(io, studentId, { mode, coinsEarned, xpEarned, rankChange } = {}) {
  emitFX(io, studentId, 'fx:victory', {
    mode,
    coinsEarned,
    xpEarned,
    rankChange,
    sound:   'victory_fanfare',
    haptic:  'heavy',
  });
  // Victory always triggers confetti + coin fly
  if (coinsEarned) fxCoinFly(io, studentId, coinsEarned, 'arena');
  if (xpEarned)    fxXPBar(io, studentId, { before: 0, after: xpEarned, levelBefore: 0, levelAfter: 0 });
  fxConfetti(io, studentId, { reason: 'Arena Victory!', color: 'gold', intensity: 'explosion' });
}

function fxDefeat(io, studentId, { mode, coinsEarned = 0 } = {}) {
  emitFX(io, studentId, 'fx:defeat', {
    mode,
    coinsEarned,
    showReplay:    true,
    showRevenge:   true,
    message:       'You almost had it! Try again!',
    haptic:        'medium',
    sound:         'defeat_tone',
  });
  if (coinsEarned) fxCoinFly(io, studentId, coinsEarned, 'arena');
}

// ── BADGE UNLOCK ─────────────────────────────────────────
function fxBadgeUnlock(io, studentId, badge) {
  emitFX(io, studentId, 'fx:badge_unlock', {
    badge,
    sound:     badge.type === 'secret' ? 'secret_unlock' : 'badge_unlock',
    haptic:    'heavy',
    flash:     'gold',
    intensity: badge.type === 'secret' ? 'explosion' : 'heavy',
  });
  fxScreenFlash(io, studentId, { color: '#FFC857', duration: 800 });
  fxConfetti(io, studentId, { reason: `Badge: ${badge.name}`, color: 'rainbow', intensity: 'heavy' });
}

// ── TITLE UNLOCK ─────────────────────────────────────────
function fxTitleUnlock(io, studentId, title) {
  emitFX(io, studentId, 'fx:title_unlock', {
    title,
    sound:  'title_reveal',
    haptic: 'heavy',
    flash:  title.color,
  });
  fxScreenFlash(io, studentId, { color: title.color, duration: 1200 });
}

// ── SPIRIT EVOLVE ─────────────────────────────────────────
// Cinematic entry animation
function fxSpiritEvolve(io, studentId, { spirit, newStage, newName }) {
  emitFX(io, studentId, 'fx:spirit_evolve', {
    spiritId:     spirit.id,
    spiritName:   spirit.name,
    newStage,
    newName,
    rarity:       spirit.rarity,
    sound:        'spirit_evolve',
    haptic:       'heavy',
    cinematic:    true,   // client plays full evolution animation
    intensity:    'explosion',
  });
  fxScreenFlash(io, studentId, { color: '#8B5CF6', duration: 2000 });
  fxConfetti(io, studentId, { reason: `${spirit.name} evolved!`, color: 'purple', intensity: 'explosion' });
}

// ── RANK UP ───────────────────────────────────────────────
function fxRankUp(io, studentId, { rankName, rankIcon, prevRank }) {
  emitFX(io, studentId, 'fx:rank_up', {
    rankName,
    rankIcon,
    prevRank,
    sound:   'rank_up',
    haptic:  'heavy',
  });
  fxScreenFlash(io, studentId, { color: '#7C5CFF', duration: 1500 });
  fxConfetti(io, studentId, { reason: `Ranked up to ${rankName}!`, color: 'purple', intensity: 'explosion' });
}

// ── SPIN WIN ─────────────────────────────────────────────
function fxSpinWin(io, studentId, { reward, rarity }) {
  const sounds = { common: 'spin_common', rare: 'spin_rare', epic: 'spin_epic', legendary: 'spin_legendary', mythic: 'spin_mythic' };
  const haptics = { common: 'light', rare: 'medium', epic: 'heavy', legendary: 'heavy', mythic: 'heavy' };
  emitFX(io, studentId, 'fx:spin_win', {
    reward,
    rarity,
    sound:   sounds[rarity] || 'spin_common',
    haptic:  haptics[rarity] || 'light',
  });
  if (['legendary', 'mythic'].includes(rarity)) {
    fxScreenFlash(io, studentId, { color: '#FFC857', duration: 1000 });
    fxConfetti(io, studentId, { reason: 'Rare spin reward!', color: 'rainbow', intensity: 'explosion' });
  }
}

// ── STREAK FIRE ───────────────────────────────────────────
function fxStreakFire(io, studentId, { streak }) {
  emitFX(io, studentId, 'fx:streak_fire', {
    streak,
    milestone: streak % 10 === 0 || streak === 7 || streak === 30 || streak === 100,
    sound:     'streak_fire',
    haptic:    streak % 10 === 0 ? 'heavy' : 'light',
  });
}

// ── SCREEN FLASH ─────────────────────────────────────────
function fxScreenFlash(io, studentId, { color = '#7C5CFF', duration = 600 } = {}) {
  emitFX(io, studentId, 'fx:screen_flash', { color, duration });
}

// ── AURA ACTIVATE ─────────────────────────────────────────
function fxAuraActivate(io, studentId, { spiritId, skillName, color }) {
  emitFX(io, studentId, 'fx:aura_activate', {
    spiritId,
    skillName,
    color:   color || '#8B5CF6',
    sound:   'aura_activate',
    haptic:  'medium',
  });
}

// ── CHEST OPEN ────────────────────────────────────────────
function fxChestOpen(io, studentId, { rewards, chestType = 'common' }) {
  emitFX(io, studentId, 'fx:chest_open', {
    rewards,
    chestType,
    sound:   `chest_open_${chestType}`,
    haptic:  'heavy',
  });
  const hasRare = rewards.some(r => ['epic', 'legendary', 'mythic'].includes(r.rarity));
  if (hasRare) {
    fxScreenFlash(io, studentId, { color: '#FFC857', duration: 1000 });
    fxConfetti(io, studentId, { reason: 'Rare chest reward!', color: 'rainbow', intensity: 'explosion' });
  }
}

// ── SEASON REWARD ────────────────────────────────────────
function fxSeasonReward(io, studentId, { reward, tier }) {
  emitFX(io, studentId, 'fx:season_reward', {
    reward,
    tier,
    sound:   'season_reward',
    haptic:  'heavy',
    cinematic: tier >= 10,
  });
  fxScreenFlash(io, studentId, { color: '#00D084', duration: 1000 });
  fxConfetti(io, studentId, { reason: 'Season Reward Claimed!', color: 'gold', intensity: 'heavy' });
}

// ── SOCKET SETUP ─────────────────────────────────────────
// Call once in server.js: registerMicroInteractionSockets(io)
// Students join their personal room on login: socket.join(`student:${studentId}`)

function registerMicroInteractionSockets(io) {
  io.on('connection', socket => {
    // Student joins personal FX room
    socket.on('fx:subscribe', ({ studentId }) => {
      if (studentId) {
        socket.join(`student:${studentId}`);
        socket.studentId = studentId;
      }
    });

    // Client can ack receipt of haptic instruction
    socket.on('fx:haptic_ack', ({ event }) => {
      // Future: analytics on haptic delivery rate
    });

    // Client reporting an animation played (for analytics)
    socket.on('fx:played', async ({ event, studentId: sid }) => {
      await db.query(
        `INSERT INTO fx_event_log (student_id, event, played_at)
         VALUES ($1,$2,NOW()) ON CONFLICT DO NOTHING`,
        [sid || socket.studentId, event]
      ).catch(() => {});
    });
  });
}

// ── REST: Test endpoint (dev only) ────────────────────────
exports.testFX = async (req, res) => {
  const io  = req.app.get('io');
  const sid = req.student.id;
  const { event } = req.body;

  switch (event) {
    case 'coin_fly':    fxCoinFly(io, sid, 500, 'test'); break;
    case 'confetti':    fxConfetti(io, sid, { reason: 'Test', intensity: 'explosion' }); break;
    case 'badge':       fxBadgeUnlock(io, sid, { id: 'test', name: 'Test Badge', icon: '🧪', type: 'secret' }); break;
    case 'rank_up':     fxRankUp(io, sid, { rankName: 'Gold', rankIcon: '🥇', prevRank: 'Silver' }); break;
    case 'spirit':      fxSpiritEvolve(io, sid, { spirit: { id: 'oracle_owl', name: 'Oracle Owl', rarity: 'legendary' }, newStage: 2, newName: 'Cosmic Owl' }); break;
    case 'chest':       fxChestOpen(io, sid, { rewards: [{ name: '1000 Coins', rarity: 'epic' }], chestType: 'gold' }); break;
    default:            fxScreenFlash(io, sid);
  }

  res.json({ success: true, event });
};

module.exports = {
  registerMicroInteractionSockets,
  emitFX,
  fxCoinFly, fxXPBar, fxConfetti, fxVictory, fxDefeat,
  fxBadgeUnlock, fxTitleUnlock, fxSpiritEvolve, fxRankUp,
  fxSpinWin, fxStreakFire, fxScreenFlash, fxAuraActivate,
  fxChestOpen, fxSeasonReward,
  testFX: exports.testFX,
};
