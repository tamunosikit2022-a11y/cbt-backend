/**
 * BADGE & IDENTITY SYSTEM
 * ─────────────────────────────────────────────────────────
 * Every badge type from the Innovation Doc:
 *   Academic   — Physics Master, Biology Titan, English Genius, etc.
 *   Competitive — Arena Monster, Unbeatable, Speed Demon, etc.
 *   Social     — Community Helper, Referral King, etc.
 *   Secret     — Hidden achievements, rare unlocks, surprise rewards.
 *
 * Title System — cosmetic identity tags displayed on profiles.
 *
 * Tables needed (see migrations/innovation_tables.sql):
 *   badges          (id, name, icon, type, secret, condition_key, description)
 *   student_badges  (student_id, badge_id, unlocked_at)
 *   titles          (id, name, color, rarity, unlock_condition)
 *   student_titles  (student_id, title_id, unlocked_at, equipped)
 */

const db = require('../config/db');
const { serverError } = require('../utils/errors');

// ── BADGE CATALOGUE ───────────────────────────────────────

const BADGES = [
  // ── ACADEMIC ──────────────────────────────────────────
  { id: 'physics_master',      name: 'Physics Master',      icon: '⚛️',  type: 'academic',     secret: false, description: 'Score 90%+ in Physics 10 times',        condition_key: 'physics_score_90_x10' },
  { id: 'biology_titan',       name: 'Biology Titan',       icon: '🧬',  type: 'academic',     secret: false, description: 'Score 90%+ in Biology 10 times',          condition_key: 'biology_score_90_x10' },
  { id: 'english_genius',      name: 'English Genius',      icon: '📖',  type: 'academic',     secret: false, description: 'Score 90%+ in English 10 times',           condition_key: 'english_score_90_x10' },
  { id: 'chemistry_wizard',    name: 'Chemistry Wizard',    icon: '🧪',  type: 'academic',     secret: false, description: 'Score 90%+ in Chemistry 10 times',         condition_key: 'chemistry_score_90_x10' },
  { id: 'math_god',            name: 'Math God',            icon: '📐',  type: 'academic',     secret: false, description: 'Score 100% in any Math exam',              condition_key: 'math_perfect_score' },
  { id: 'all_rounder',         name: 'All-Rounder',         icon: '🎓',  type: 'academic',     secret: false, description: 'Score 80%+ in 5 different subjects',       condition_key: 'five_subject_80' },
  { id: 'knowledge_vault_pro', name: 'Knowledge Vault Pro', icon: '📚',  type: 'academic',     secret: false, description: 'Unlock 10 PDFs from the Knowledge Vault',  condition_key: 'unlock_10_pdfs' },
  { id: 'flashcard_fanatic',   name: 'Flashcard Fanatic',   icon: '🗂️', type: 'academic',     secret: false, description: 'Complete 100 flashcard sessions',           condition_key: 'flashcard_sessions_100' },
  { id: 'study_streak_30',     name: '30-Day Scholar',      icon: '📅',  type: 'academic',     secret: false, description: 'Maintain a 30-day study streak',           condition_key: 'streak_30' },
  { id: 'study_streak_100',    name: 'Century Scholar',     icon: '💯',  type: 'academic',     secret: false, description: 'Maintain a 100-day study streak',          condition_key: 'streak_100' },

  // ── COMPETITIVE ────────────────────────────────────────
  { id: 'arena_monster',       name: 'Arena Monster',       icon: '👹',  type: 'competitive',  secret: false, description: 'Win 50 Arena battles',                     condition_key: 'arena_wins_50' },
  { id: 'unbeatable',          name: 'Unbeatable',          icon: '🏆',  type: 'competitive',  secret: false, description: 'Win 10 Arena battles in a row',             condition_key: 'arena_win_streak_10' },
  { id: 'speed_demon',         name: 'Speed Demon',         icon: '⚡',  type: 'competitive',  secret: false, description: 'Answer 10 questions in under 5 seconds each', condition_key: 'speed_answers_10' },
  { id: 'battle_royal_king',   name: 'Battle Royal King',   icon: '👑',  type: 'competitive',  secret: false, description: 'Win a 50-player Battle Royal',              condition_key: 'battle_royal_win' },
  { id: 'tournament_champion', name: 'Tournament Champion', icon: '🥇',  type: 'competitive',  secret: false, description: 'Win a Tournament bracket',                  condition_key: 'tournament_win' },
  { id: 'school_war_hero',     name: 'School War Hero',     icon: '⚔️',  type: 'competitive',  secret: false, description: 'Participate in 5 School Wars',             condition_key: 'school_wars_5' },
  { id: 'school_war_legend',   name: 'School War Legend',   icon: '🌟',  type: 'competitive',  secret: false, description: 'Win 3 School Wars as Captain',             condition_key: 'school_wars_captain_3' },
  { id: 'spirit_tamer',        name: 'Spirit Tamer',        icon: '🐉',  type: 'competitive',  secret: false, description: 'Unlock 5 different Scholar Spirits',        condition_key: 'spirits_5' },
  { id: 'blitz_master',        name: 'Blitz Master',        icon: '🌪️', type: 'competitive',  secret: false, description: 'Win 20 Blitz Mode matches',                condition_key: 'blitz_wins_20' },
  { id: 'survival_king',       name: 'Survival King',       icon: '💀',  type: 'competitive',  secret: false, description: 'Last 5 standing in 10 Survival matches',   condition_key: 'survival_top5_x10' },

  // ── SOCIAL ────────────────────────────────────────────
  { id: 'community_helper',    name: 'Community Helper',    icon: '🤝',  type: 'social',       secret: false, description: 'Share 20 study questions in Study Rooms',  condition_key: 'study_room_shares_20' },
  { id: 'referral_recruiter',  name: 'Recruiter',           icon: '🥉',  type: 'social',       secret: false, description: 'Refer 5 friends who register',              condition_key: 'referrals_5' },
  { id: 'referral_king',       name: 'Referral King',       icon: '👑',  type: 'social',       secret: false, description: 'Refer 10 friends who register',             condition_key: 'referrals_10' },
  { id: 'referral_champion',   name: 'Referral Champion',   icon: '🥇',  type: 'social',       secret: false, description: 'Refer 25 friends who register',             condition_key: 'referrals_25' },
  { id: 'referral_legend',     name: 'Referral Legend',     icon: '🏆',  type: 'social',       secret: false, description: 'Refer 50 friends who register',             condition_key: 'referrals_50' },
  { id: 'squad_leader',        name: 'Squad Leader',        icon: '🎖️', type: 'social',       secret: false, description: 'Lead a squad to 10 Arena wins',            condition_key: 'squad_wins_10' },
  { id: 'social_butterfly',    name: 'Social Butterfly',    icon: '🦋',  type: 'social',       secret: false, description: 'Make 20 friends',                           condition_key: 'friends_20' },
  { id: 'voice_room_host',     name: 'Voice Room Host',     icon: '🎙️', type: 'social',       secret: false, description: 'Host 10 Study Rooms',                       condition_key: 'study_room_host_10' },

  // ── SECRET (hidden from UI until unlocked) ────────────
  { id: 'shadow_scholar',      name: 'Shadow Scholar',      icon: '🌑',  type: 'secret',       secret: true,  description: '???',                                       condition_key: 'login_3am' },
  { id: 'first_blood',         name: 'First Blood',         icon: '🔴',  type: 'secret',       secret: true,  description: '???',                                       condition_key: 'first_arena_win' },
  { id: 'the_chosen',          name: 'The Chosen',          icon: '✨',  type: 'secret',       secret: true,  description: '???',                                       condition_key: 'perfect_week' },
  { id: 'obsessed',            name: 'Obsessed',            icon: '🌀',  type: 'secret',       secret: true,  description: '???',                                       condition_key: 'sessions_1000' },
  { id: 'dark_horse',          name: 'Dark Horse',          icon: '🐴',  type: 'secret',       secret: true,  description: '???',                                       condition_key: 'ranked_up_from_bronze_to_legend' },
  { id: 'midnight_grind',      name: 'Midnight Grind',      icon: '🌙',  type: 'secret',       secret: true,  description: '???',                                       condition_key: 'study_past_midnight_10' },
  { id: 'void_touched',        name: 'Void Touched',        icon: '🕸️', type: 'secret',       secret: true,  description: '???',                                       condition_key: 'void_weaver_wins_50' },
  { id: 'celestial_being',     name: 'Celestial Being',     icon: '🌌',  type: 'secret',       secret: true,  description: '???',                                       condition_key: 'any_spirit_max_evolution' },
];

// ── TITLE CATALOGUE ───────────────────────────────────────

const TITLES = [
  { id: 'scholar',          name: 'Scholar',           color: '#7C5CFF', rarity: 'common',    unlock: 'default' },
  { id: 'warrior',          name: 'Arena Warrior',     color: '#FF5A5F', rarity: 'common',    unlock: 'arena_wins_10' },
  { id: 'champion',         name: 'Champion',          color: '#FFC857', rarity: 'rare',      unlock: 'arena_wins_50' },
  { id: 'legend',           name: 'Legend',            color: '#FF8C00', rarity: 'epic',      unlock: 'arena_wins_100' },
  { id: 'void_walker',      name: 'Void Walker',       color: '#8B5CF6', rarity: 'epic',      unlock: 'void_weaver_equipped_50_wins' },
  { id: 'celestial',        name: 'Celestial',         color: '#00D084', rarity: 'legendary', unlock: 'any_spirit_max_evolution' },
  { id: 'the_eternal',      name: 'The Eternal',       color: '#FF00FF', rarity: 'mythic',    unlock: 'streak_100_and_arena_100wins' },
  { id: 'knowledge_seeker', name: 'Knowledge Seeker',  color: '#60A5FA', rarity: 'rare',      unlock: 'unlock_10_pdfs' },
  { id: 'war_captain',      name: 'War Captain',       color: '#EF4444', rarity: 'epic',      unlock: 'school_wars_captain_3' },
  { id: 'blitz_god',        name: 'Blitz God',         color: '#F59E0B', rarity: 'legendary', unlock: 'blitz_wins_20' },
  { id: 'midnight_scholar', name: 'Midnight Scholar',  color: '#1E3A5F', rarity: 'secret',    unlock: 'study_past_midnight_10' },
  { id: 'obsessive',        name: 'Obsessive',         color: '#6B7280', rarity: 'secret',    unlock: 'sessions_1000' },
];

// ── HELPERS ───────────────────────────────────────────────

async function awardBadge(studentId, badgeId, io) {
  const badge = BADGES.find(b => b.id === badgeId);
  if (!badge) return false;

  try {
    const result = await db.query(
      `INSERT INTO student_badges (student_id, badge_id)
       VALUES ($1,$2) ON CONFLICT (student_id, badge_id) DO NOTHING RETURNING badge_id`,
      [studentId, badgeId]
    );
    if (!result.rows.length) return false;  // already had it

    // Emit badge unlock event to micro-interaction system
    if (io) {
      io.to(`student:${studentId}`).emit('fx:badge_unlock', {
        badge,
        isSecret: badge.secret,
        message:  `🏅 New Badge: ${badge.name}!`,
      });
    }

    return true;
  } catch (err) {
    console.error('awardBadge error:', err.message);
    return false;
  }
}

async function awardTitle(studentId, titleId, io) {
  const title = TITLES.find(t => t.id === titleId);
  if (!title) return false;

  try {
    await db.query(
      `INSERT INTO student_titles (student_id, title_id)
       VALUES ($1,$2) ON CONFLICT (student_id, title_id) DO NOTHING`,
      [studentId, titleId]
    );

    if (io) {
      io.to(`student:${studentId}`).emit('fx:title_unlock', {
        title,
        message: `✨ New Title Unlocked: "${title.name}"!`,
      });
    }

    return true;
  } catch (err) {
    console.error('awardTitle error:', err.message);
    return false;
  }
}

// ── BADGE CHECKER — run after key events ─────────────────

async function checkBadgesForStudent(studentId, io) {
  try {
    const [stats, badgesOwned] = await Promise.all([
      db.query(`
        SELECT
          COALESCE(streak,0)                                     AS streak,
          COALESCE(arena_wins,0)                                 AS arena_wins,
          COALESCE(arena_win_streak,0)                           AS arena_win_streak,
          COALESCE(total_sessions,0)                             AS total_sessions,
          COALESCE(referrals_count,0)                            AS referrals_count,
          COALESCE(friends_count,0)                              AS friends_count,
          COALESCE(spirits_count,0)                              AS spirits_count,
          COALESCE(pdfs_unlocked,0)                              AS pdfs_unlocked,
          COALESCE(flashcard_sessions,0)                         AS flashcard_sessions,
          COALESCE(study_room_hosted,0)                          AS study_room_hosted,
          COALESCE(study_room_shares,0)                          AS study_room_shares,
          COALESCE(school_wars_played,0)                         AS school_wars_played,
          COALESCE(school_wars_captain_won,0)                    AS school_wars_captain_won,
          COALESCE(blitz_wins,0)                                 AS blitz_wins,
          COALESCE(tournament_wins,0)                            AS tournament_wins,
          COALESCE(battle_royal_wins,0)                          AS battle_royal_wins,
          COALESCE(squad_wins,0)                                 AS squad_wins,
          COALESCE(survival_top5,0)                              AS survival_top5,
          COALESCE(speed_answers_count,0)                        AS speed_answers_count,
          COALESCE(midnight_sessions,0)                          AS midnight_sessions
        FROM students WHERE id=$1
      `, [studentId]).then(r => r.rows[0] || {}),

      db.query(
        `SELECT badge_id FROM student_badges WHERE student_id=$1`, [studentId]
      ).then(r => new Set(r.rows.map(b => b.badge_id))),
    ]);

    const toAward = [];

    const check = (cond, badgeId) => {
      if (cond && !badgesOwned.has(badgeId)) toAward.push(badgeId);
    };

    // Academic
    check(parseInt(stats.streak) >= 30,                'study_streak_30');
    check(parseInt(stats.streak) >= 100,               'study_streak_100');
    check(parseInt(stats.pdfs_unlocked) >= 10,         'knowledge_vault_pro');
    check(parseInt(stats.flashcard_sessions) >= 100,   'flashcard_fanatic');

    // Competitive
    check(parseInt(stats.arena_wins) >= 50,            'arena_monster');
    check(parseInt(stats.arena_win_streak) >= 10,      'unbeatable');
    check(parseInt(stats.speed_answers_count) >= 10,   'speed_demon');
    check(parseInt(stats.battle_royal_wins) >= 1,      'battle_royal_king');
    check(parseInt(stats.tournament_wins) >= 1,        'tournament_champion');
    check(parseInt(stats.school_wars_played) >= 5,     'school_war_hero');
    check(parseInt(stats.school_wars_captain_won) >= 3,'school_war_legend');
    check(parseInt(stats.spirits_count) >= 5,          'spirit_tamer');
    check(parseInt(stats.blitz_wins) >= 20,            'blitz_master');
    check(parseInt(stats.survival_top5) >= 10,         'survival_king');

    // Social
    check(parseInt(stats.study_room_shares) >= 20,     'community_helper');
    check(parseInt(stats.referrals_count) >= 5,        'referral_recruiter');
    check(parseInt(stats.referrals_count) >= 10,       'referral_king');
    check(parseInt(stats.referrals_count) >= 25,       'referral_champion');
    check(parseInt(stats.referrals_count) >= 50,       'referral_legend');
    check(parseInt(stats.squad_wins) >= 10,            'squad_leader');
    check(parseInt(stats.friends_count) >= 20,         'social_butterfly');
    check(parseInt(stats.study_room_hosted) >= 10,     'voice_room_host');

    // Secret
    check(parseInt(stats.arena_wins) === 0 && parseInt(stats.total_sessions) > 0, 'first_blood'); // first arena win check is done at win event
    check(parseInt(stats.total_sessions) >= 1000,      'obsessed');
    check(parseInt(stats.midnight_sessions) >= 10,     'midnight_grind');

    for (const badgeId of toAward) {
      await awardBadge(studentId, badgeId, io);
    }

    // Title checks
    const titlesOwned = await db.query(
      `SELECT title_id FROM student_titles WHERE student_id=$1`, [studentId]
    ).then(r => new Set(r.rows.map(t => t.title_id))).catch(() => new Set());

    const checkTitle = (cond, titleId) => {
      if (cond && !titlesOwned.has(titleId)) awardTitle(studentId, titleId, io);
    };

    checkTitle(parseInt(stats.arena_wins) >= 10,               'warrior');
    checkTitle(parseInt(stats.arena_wins) >= 50,               'champion');
    checkTitle(parseInt(stats.arena_wins) >= 100,              'legend');
    checkTitle(parseInt(stats.pdfs_unlocked) >= 10,            'knowledge_seeker');
    checkTitle(parseInt(stats.blitz_wins) >= 20,               'blitz_god');
    checkTitle(parseInt(stats.school_wars_captain_won) >= 3,   'war_captain');
    checkTitle(parseInt(stats.midnight_sessions) >= 10,        'midnight_scholar');
    checkTitle(parseInt(stats.total_sessions) >= 1000,         'obsessive');

  } catch (err) {
    console.error('checkBadgesForStudent error:', err.message);
  }
}

// ── REST ENDPOINTS ────────────────────────────────────────

// GET /api/badges
exports.getBadgeCatalogue = async (req, res) => {
  try {
    const sid    = req.student.id;
    const owned  = await db.query(
      `SELECT badge_id, unlocked_at FROM student_badges WHERE student_id=$1`, [sid]
    ).then(r => Object.fromEntries(r.rows.map(b => [b.badge_id, b.unlocked_at])))
     .catch(() => ({}));

    const badges = BADGES.map(b => ({
      ...b,
      description: (b.secret && !owned[b.id]) ? '???' : b.description,
      icon:        (b.secret && !owned[b.id]) ? '🔒'  : b.icon,
      owned:       !!owned[b.id],
      unlockedAt:  owned[b.id] || null,
    }));

    res.json({ badges, total: BADGES.length, owned: Object.keys(owned).length });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/badges/my
exports.getMyBadges = async (req, res) => {
  try {
    const sid = req.student.id;
    const { rows } = await db.query(
      `SELECT badge_id, unlocked_at FROM student_badges
       WHERE student_id=$1 ORDER BY unlocked_at DESC`,
      [sid]
    );
    const badges = rows.map(r => {
      const b = BADGES.find(b => b.id === r.badge_id);
      return b ? { ...b, unlockedAt: r.unlocked_at } : null;
    }).filter(Boolean);

    res.json({ badges });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/titles
exports.getTitleCatalogue = async (req, res) => {
  try {
    const sid    = req.student.id;
    const owned  = await db.query(
      `SELECT title_id, equipped FROM student_titles WHERE student_id=$1`, [sid]
    ).then(r => Object.fromEntries(r.rows.map(t => [t.title_id, t.equipped])))
     .catch(() => ({}));

    const titles = TITLES.map(t => ({
      ...t,
      owned:    Object.prototype.hasOwnProperty.call(owned, t.id),
      equipped: owned[t.id] === true,
    }));

    res.json({ titles });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/titles/equip
exports.equipTitle = async (req, res) => {
  try {
    const sid = req.student.id;
    const { titleId } = req.body;

    const owned = await db.query(
      `SELECT id FROM student_titles WHERE student_id=$1 AND title_id=$2`, [sid, titleId]
    );
    if (!owned.rows.length) return res.status(403).json({ error: 'Title not unlocked.' });

    // Unequip all, equip the chosen one
    await db.query(`UPDATE student_titles SET equipped=false WHERE student_id=$1`, [sid]);
    await db.query(`UPDATE student_titles SET equipped=true WHERE student_id=$1 AND title_id=$2`, [sid, titleId]);
    await db.query(`UPDATE students SET equipped_title=$1 WHERE id=$2`, [titleId, sid]);

    const title = TITLES.find(t => t.id === titleId);
    res.json({ success: true, equipped: title });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/badges/check  — manually trigger a badge check (admin or post-event)
exports.triggerBadgeCheck = async (req, res) => {
  const sid = req.student.id;
  const io  = req.app.get('io');
  await checkBadgesForStudent(sid, io);
  res.json({ success: true, message: 'Badge check complete.' });
};

// Award a first-arena-win secret badge (called from arenaEngine after match)
exports.checkFirstArenaWin = async (studentId, io) => {
  const prev = await db.query(
    `SELECT COUNT(*) as wins FROM arena_match_results WHERE student_id=$1 AND result='win'`,
    [studentId]
  ).catch(() => ({ rows: [{ wins: 0 }] }));

  if (parseInt(prev.rows[0].wins) === 1) {
    await awardBadge(studentId, 'first_blood', io);
  }
};

module.exports = {
  BADGES, TITLES,
  awardBadge, awardTitle,
  checkBadgesForStudent,
  getBadgeCatalogue:    exports.getBadgeCatalogue,
  getMyBadges:          exports.getMyBadges,
  getTitleCatalogue:    exports.getTitleCatalogue,
  equipTitle:           exports.equipTitle,
  triggerBadgeCheck:    exports.triggerBadgeCheck,
  checkFirstArenaWin:   exports.checkFirstArenaWin,
};
