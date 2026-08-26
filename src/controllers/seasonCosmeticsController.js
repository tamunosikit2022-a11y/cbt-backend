const { serverError } = require('../utils/errors');
/**
 * SEASON COSMETICS & SPIN WHEEL EVENTS
 * ─────────────────────────────────────────────────────────
 * From the Innovation Doc:
 *   - Seasons tied to cosmetic rewards
 *   - Spin Wheel events (event-exclusive rewards)
 *
 * Season Cosmetics:
 *   - Season Pass tiers (1-20) each have cosmetic rewards
 *   - Cosmetics: avatar frames, spirit skins, title colors,
 *     profile effects, chat badges, banner backgrounds
 *
 * Spin Wheel Events:
 *   - Limited-time event periods where the spin wheel has
 *     BONUS seasonal prizes alongside the regular prizes
 *   - Event spins show a themed overlay (Halloween, Christmas, etc.)
 *
 * Tables (see migrations/innovation_tables.sql):
 *   season_cosmetics         (id, season_id, tier, type, name, preview_url, rarity)
 *   student_season_cosmetics (student_id, cosmetic_id, equipped, unlocked_at)
 *   spin_events              (id, name, start_at, end_at, theme_color, prizes JSON)
 *   student_equipped_cosmetics (student_id, slot, cosmetic_id) — active cosmetic loadout
 */

const db = require('../config/db');
const { fxSeasonReward, fxSpinWin } = require('./microController');

// ── COSMETIC TYPES & SLOTS ────────────────────────────────

const COSMETIC_SLOTS = [
  'avatar_frame',    // glowing ring around avatar
  'spirit_skin',     // alternate colour/particle effect for equipped spirit
  'title_color',     // custom colour for the equipped title
  'profile_effect',  // floating particles or background effect on profile
  'chat_badge',      // small icon next to name in study rooms / chat
  'banner_bg',       // profile banner background image/gradient
  'arena_entry',     // animation played when entering an Arena match
];

// ── CURRENT SEASON COSMETICS CATALOGUE ───────────────────
// Normally fetched from DB, but seed data here for reference / seeding

const SEASON_COSMETIC_SEEDS = [
  // ── TIER 1-5 (Common/Rare)
  { tier: 1,  type: 'avatar_frame',  name: 'Scholar Silver',     rarity: 'common',    preview: '🔵' },
  { tier: 2,  type: 'chat_badge',    name: 'Season Flame',        rarity: 'common',    preview: '🔥' },
  { tier: 3,  type: 'banner_bg',     name: 'Neon Pulse',          rarity: 'rare',      preview: '🌌' },
  { tier: 4,  type: 'title_color',   name: 'Electric Violet',     rarity: 'rare',      preview: '#7C5CFF' },
  { tier: 5,  type: 'spirit_skin',   name: 'Frost Void Weaver',   rarity: 'rare',      preview: '❄️' },
  // ── TIER 6-10 (Epic)
  { tier: 6,  type: 'avatar_frame',  name: 'Gold Scholar Halo',   rarity: 'epic',      preview: '✨' },
  { tier: 7,  type: 'profile_effect', name: 'Particle Storm',       rarity: 'epic',      preview: '🌀' },
  { tier: 8,  type: 'spirit_skin',   name: 'Ember Gold Wyrm',     rarity: 'epic',      preview: '🌟' },
  { tier: 9,  type: 'chat_badge',    name: 'Elite Scholar',       rarity: 'epic',      preview: '💎' },
  { tier: 10, type: 'arena_entry',   name: 'Neon Entrance',       rarity: 'epic',      preview: '⚡' },
  // ── TIER 11-15 (Legendary)
  { tier: 11, type: 'banner_bg',     name: 'Cosmic Galaxy',       rarity: 'legendary', preview: '🌌' },
  { tier: 12, type: 'title_color',   name: 'Mythic Gold',         rarity: 'legendary', preview: '#FFC857' },
  { tier: 13, type: 'spirit_skin',   name: 'Celestial Owl',       rarity: 'legendary', preview: '🦉' },
  { tier: 14, type: 'avatar_frame',  name: 'Legend Aura',         rarity: 'legendary', preview: '👑' },
  { tier: 15, type: 'arena_entry',   name: 'Legendary Drop',      rarity: 'legendary', preview: '💥' },
  // ── TIER 16-20 (Mythic)
  { tier: 16, type: 'profile_effect', name: 'Void Rift',            rarity: 'mythic',    preview: '🌑' },
  { tier: 17, type: 'spirit_skin',   name: 'Quantum Neuro Bot',   rarity: 'mythic',    preview: '🤖' },
  { tier: 18, type: 'banner_bg',     name: 'The Void',            rarity: 'mythic',    preview: '⬛' },
  { tier: 19, type: 'chat_badge',    name: 'Season MVP',          rarity: 'mythic',    preview: '🏆' },
  { tier: 20, type: 'arena_entry',   name: 'MYTHIC DESCENT',      rarity: 'mythic',    preview: '🌪️' },
];

// ── SPIN WHEEL EVENT PRIZES (seasonal bonus) ──────────────

// ── EVENT-EXCLUSIVE COSMETIC SEEDS ────────────────────────
// FIX: buildEventSpinPrizes() below promises cosmetics like
// 'halloween_ghost_frame' and 'xmas_gold_frame' as spin rewards, but
// nothing ever inserted rows for them into season_cosmetics —
// seedSeasonCosmetics() only seeded the 20 generic SEASON_COSMETIC_SEEDS
// tier cosmetics, a completely different name set. awardSpinPrize's
// cosmetic lookup (`WHERE name=$1`) always came back empty for any event
// prize, so the grant was silently skipped while doEventSpin still told
// the student they'd won it. These are the exact `reward.cosmetic`
// strings referenced in buildEventSpinPrizes, so the name lookup there
// actually resolves.
//
// tier is set well above the real season-pass range (1-20) specifically
// so these never collide with SEASON_COSMETIC_SEEDS under the
// UNIQUE(season_id, tier, type) constraint, and each gets its own unique
// tier number (not shared by type) so multiple event items of the same
// `type` don't collide with each other either.
const EVENT_COSMETIC_SEEDS = [
  { tier: 1001, type: 'avatar_frame',   name: 'halloween_ghost_frame', rarity: 'epic',      preview: '👻' },
  { tier: 1002, type: 'spirit_skin',    name: 'halloween_dark_skin',   rarity: 'legendary', preview: '🕷️' },
  { tier: 1003, type: 'avatar_frame',   name: 'xmas_gold_frame',       rarity: 'legendary', preview: '🎄' },
  { tier: 1004, type: 'avatar_frame',   name: 'season_trophy_frame',   rarity: 'mythic',     preview: '🏆' },
];

function buildEventSpinPrizes(eventName) {
  const events = {
    halloween: [
      { label: 'Ghost Frame',        type: 'cosmetic', rarity: 'epic',      reward: { cosmetic: 'halloween_ghost_frame' }, probability: 0.05 },
      { label: 'Dark Spirit Skin',   type: 'cosmetic', rarity: 'legendary', reward: { cosmetic: 'halloween_dark_skin' },  probability: 0.02 },
      { label: '2000 Coins 🎃',      type: 'coins',    rarity: 'rare',      reward: { coins: 2000 },                     probability: 0.10 },
      { label: '100 Gems 🎃',        type: 'gems',     rarity: 'epic',      reward: { gems: 100 },                       probability: 0.05 },
      { label: 'XP Boost 2× (1hr)',  type: 'boost',    rarity: 'rare',      reward: { boost: 'xp2x', duration: 3600 },  probability: 0.15 },
    ],
    christmas: [
      { label: 'Gold Star Frame',    type: 'cosmetic', rarity: 'legendary', reward: { cosmetic: 'xmas_gold_frame' },     probability: 0.03 },
      { label: '5000 Coins 🎄',      type: 'coins',    rarity: 'epic',      reward: { coins: 5000 },                    probability: 0.05 },
      { label: '250 Gems 🎄',        type: 'gems',     rarity: 'legendary', reward: { gems: 250 },                      probability: 0.02 },
      { label: 'Coin Magnet (2hr)',   type: 'boost',    rarity: 'rare',      reward: { boost: 'coin_magnet', duration: 7200 }, probability: 0.10 },
    ],
    season_finale: [
      { label: 'Season Trophy',      type: 'cosmetic', rarity: 'mythic',    reward: { cosmetic: 'season_trophy_frame' }, probability: 0.01 },
      { label: 'Season Title',       type: 'title',    rarity: 'legendary', reward: { title: 'season_legend' },          probability: 0.02 },
      { label: '10000 Coins 🏆',     type: 'coins',    rarity: 'legendary', reward: { coins: 10000 },                   probability: 0.03 },
      { label: '500 Gems 🏆',        type: 'gems',     rarity: 'mythic',    reward: { gems: 500 },                      probability: 0.01 },
    ],
  };
  return events[eventName] || [];
}

// ── REST ENDPOINTS ────────────────────────────────────────

// GET /api/season-cosmetics
exports.getSeasonCosmetics = async (req, res) => {
  try {
    const sid = req.student.id;

    const [cosmetics, owned] = await Promise.all([
      // tier < 1000 excludes event-exclusive spin prizes (see
      // EVENT_COSMETIC_SEEDS) — those are spin-only, never tier-unlockable,
      // so they'd otherwise show up here permanently "locked" and clutter
      // the season-pass progression list.
      db.query(`
        SELECT sc.*, se.name as season_name, se.season_number
        FROM season_cosmetics sc
        JOIN seasons se ON se.id = sc.season_id
        WHERE se.is_active = true AND sc.tier < 1000
        ORDER BY sc.tier
      `).catch(() => ({ rows: [] })),

      db.query(`
        SELECT cosmetic_id, equipped FROM student_season_cosmetics WHERE student_id=$1
      `, [sid]).then(r => Object.fromEntries(r.rows.map(c => [c.cosmetic_id, c.equipped])))
               .catch(() => ({})),
    ]);

    // Get student's current season tier
    const tierRow = await db.query(
      `SELECT COALESCE(season_tier,0) as tier FROM students WHERE id=$1`, [sid]
    ).catch(() => ({ rows: [{ tier: 0 }] }));
    const currentTier = parseInt(tierRow.rows[0]?.tier || 0);

    const list = cosmetics.rows.map(c => ({
      ...c,
      owned:    Object.prototype.hasOwnProperty.call(owned, c.id),
      equipped: owned[c.id] === true,
      locked:   c.tier > currentTier,
    }));

    res.json({ cosmetics: list, currentTier });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/season-cosmetics/:id/claim
exports.claimSeasonCosmetic = async (req, res) => {
  try {
    const sid       = req.student.id;
    const cosmeticId = parseInt(req.params.id);
    const io        = req.app.get('io');

    // Check ownership
    const alreadyOwned = await db.query(
      `SELECT id FROM student_season_cosmetics WHERE student_id=$1 AND cosmetic_id=$2`,
      [sid, cosmeticId]
    );
    if (alreadyOwned.rows.length) return res.status(400).json({ error: 'Already claimed.' });

    // Check tier requirement
    const [cosmetic, tierRow] = await Promise.all([
      db.query(`SELECT * FROM season_cosmetics WHERE id=$1`, [cosmeticId]).then(r => r.rows[0]),
      db.query(`SELECT COALESCE(season_tier,0) as tier FROM students WHERE id=$1`, [sid]).then(r => r.rows[0]),
    ]);

    if (!cosmetic) return res.status(404).json({ error: 'Cosmetic not found.' });
    if (cosmetic.tier > parseInt(tierRow?.tier || 0))
      return res.status(403).json({ error: `You need Season Tier ${cosmetic.tier} to claim this.` });

    // FIX: student_season_cosmetics has a PRIMARY KEY (student_id,
    // cosmetic_id), so a genuine race here can't double-grant — the
    // losing concurrent request's INSERT fails with a unique_violation.
    // It was falling through to a raw 500 (serverError) though, instead
    // of the same clean "Already claimed" message the earlier check
    // above gives a non-racing duplicate request.
    await db.query(
      `INSERT INTO student_season_cosmetics (student_id, cosmetic_id) VALUES ($1,$2)`,
      [sid, cosmeticId]
    ).catch(err => {
      if (err.code === '23505') { const e = new Error('Already claimed.'); e.code = 'ALREADY_CLAIMED'; throw e; }
      throw err;
    });

    // Fire micro-interaction
    fxSeasonReward(io, sid, { reward: cosmetic, tier: cosmetic.tier });

    res.json({ success: true, cosmetic });
  } catch (err) {
    if (err.code === 'ALREADY_CLAIMED') return res.status(400).json({ error: err.message });
    serverError(res, err);
  }
};

// POST /api/season-cosmetics/equip
exports.equipCosmetic = async (req, res) => {
  try {
    const sid         = req.student.id;
    const { cosmeticId } = req.body;

    const cosmetic = await db.query(
      `SELECT sc.* FROM season_cosmetics sc
       JOIN student_season_cosmetics ssc ON ssc.cosmetic_id = sc.id
       WHERE sc.id=$1 AND ssc.student_id=$2`,
      [cosmeticId, sid]
    ).then(r => r.rows[0]);

    if (!cosmetic) return res.status(404).json({ error: 'Cosmetic not owned.' });

    // Unequip same slot, equip new one
    await db.query(
      `UPDATE student_season_cosmetics
       SET equipped=false
       WHERE student_id=$1 AND cosmetic_id IN (
         SELECT ssc2.cosmetic_id FROM student_season_cosmetics ssc2
         JOIN season_cosmetics sc2 ON sc2.id = ssc2.cosmetic_id
         WHERE ssc2.student_id=$1 AND sc2.type=$2
       )`,
      [sid, cosmetic.type]
    ).catch(() => {});

    await db.query(
      `UPDATE student_season_cosmetics SET equipped=true WHERE student_id=$1 AND cosmetic_id=$2`,
      [sid, cosmeticId]
    );

    // Update students loadout column
    await db.query(
      `UPDATE student_equipped_cosmetics SET cosmetic_id=$1 WHERE student_id=$2 AND slot=$3`,
      [cosmeticId, sid, cosmetic.type]
    ).catch(async () => {
      await db.query(
        `INSERT INTO student_equipped_cosmetics (student_id, slot, cosmetic_id)
         VALUES ($1,$2,$3) ON CONFLICT (student_id, slot) DO UPDATE SET cosmetic_id=$3`,
        [sid, cosmetic.type, cosmeticId]
      ).catch(() => {});
    });

    res.json({ success: true, slot: cosmetic.type, cosmetic });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/season-cosmetics/loadout/:studentId
// Returns the full cosmetic loadout for any student (for profile display)
exports.getStudentLoadout = async (req, res) => {
  try {
    const targetId = parseInt(req.params.studentId);
    const { rows } = await db.query(
      `SELECT sec.slot, sc.name, sc.type, sc.rarity, sc.preview_url
       FROM student_equipped_cosmetics sec
       JOIN season_cosmetics sc ON sc.id = sec.cosmetic_id
       WHERE sec.student_id=$1`,
      [targetId]
    ).catch(() => ({ rows: [] }));

    const loadout = Object.fromEntries(rows.map(r => [r.slot, r]));
    res.json({ loadout });
  } catch (err) {
    serverError(res, err);
  }
};

// ── SPIN WHEEL EVENTS ──────────────────────────────────────

// GET /api/spin-events/active
exports.getActiveSpinEvent = async (req, res) => {
  try {
    const event = await db.query(
      `SELECT * FROM spin_events WHERE NOW() BETWEEN start_at AND end_at ORDER BY id DESC LIMIT 1`
    ).catch(() => ({ rows: [] }));

    if (!event.rows.length) return res.json({ event: null });

    const e = event.rows[0];
    res.json({
      event: {
        id:         e.id,
        name:       e.name,
        themeColor: e.theme_color,
        endsAt:     e.end_at,
        prizes:     e.prizes || buildEventSpinPrizes(e.event_type),
      },
    });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/spin-events/spin (event-exclusive spin — uses event tokens)
exports.doEventSpin = async (req, res) => {
  // FIX: this used to deduct the event-spin token and award the prize as
  // two separate, unguarded writes, then respond { success:true, prize }
  // unconditionally — awardSpinPrize swallowed its own errors internally
  // (including the "cosmetic name not found" case, which was ALWAYS true
  // for event prizes, see EVENT_COSMETIC_SEEDS above), so a student could
  // be told they won a legendary/mythic reward and receive nothing, with
  // their token already spent either way. Now the whole thing is one
  // transaction: if the grant genuinely fails (e.g. this environment's
  // migration hasn't seeded EVENT_COSMETIC_SEEDS yet), it rolls back —
  // token isn't spent, and the response says so honestly instead of
  // claiming success.
  const client = await db.connect();
  try {
    const sid = req.student.id;
    const io  = req.app.get('io');

    const event = await client.query(
      `SELECT * FROM spin_events WHERE NOW() BETWEEN start_at AND end_at ORDER BY id DESC LIMIT 1`
    ).catch(() => ({ rows: [] }));
    if (!event.rows.length) { client.release(); return res.status(400).json({ error: 'No active spin event.' }); }
    const ev = event.rows[0];

    const tokenRow = await client.query(
      `SELECT COALESCE(event_spin_tokens,0) as tokens FROM students WHERE id=$1`, [sid]
    );
    const tokens = parseInt(tokenRow.rows[0]?.tokens || 0);
    if (tokens < 1) { client.release(); return res.status(400).json({ error: 'No event spin tokens. Earn them through event missions!' }); }

    const prizes = ev.prizes || buildEventSpinPrizes(ev.event_type);
    const prize  = weightedRandom(prizes);

    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE students SET event_spin_tokens = COALESCE(event_spin_tokens,0) - 1 WHERE id=$1`, [sid]
      );

      const granted = await awardSpinPrize(client, sid, prize);
      if (!granted) {
        await client.query('ROLLBACK');
        console.error(`Spin prize grant failed for student ${sid}, prize:`, prize);
        return res.status(500).json({ error: "Couldn't award your prize — your spin token hasn't been used. Please try again." });
      }

      await client.query(
        `INSERT INTO spin_results (student_id, prize_label, prize_type, prize_rarity, source, spun_at)
         VALUES ($1,$2,$3,$4,'event',NOW())`,
        [sid, prize.label, prize.type, prize.rarity]
      ).catch(() => {}); // analytics-only, never worth failing the spin over

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    }

    fxSpinWin(io, sid, { reward: prize.label, rarity: prize.rarity });
    res.json({ success: true, prize, remainingTokens: tokens - 1 });
  } catch (err) {
    serverError(res, err);
  } finally {
    client.release();
  }
};

// ── ADMIN: Create Spin Event ──────────────────────────────

// POST /api/spin-events (admin)
exports.createSpinEvent = async (req, res) => {
  try {
    const { name, startAt, endAt, themeColor, eventType, prizes } = req.body;

    const result = await db.query(
      `INSERT INTO spin_events (name, start_at, end_at, theme_color, event_type, prizes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, startAt, endAt, themeColor, eventType, JSON.stringify(prizes || buildEventSpinPrizes(eventType))]
    );

    res.json({ success: true, eventId: result.rows[0].id });
  } catch (err) {
    serverError(res, err);
  }
};

// ── ADMIN: Seed Season Cosmetics ─────────────────────────

exports.seedSeasonCosmetics = async (req, res) => {
  try {
    // Get active season
    const season = await db.query(
      `SELECT id FROM seasons WHERE is_active=true LIMIT 1`
    ).catch(() => ({ rows: [] }));

    if (!season.rows.length) return res.status(400).json({ error: 'No active season found.' });
    const seasonId = season.rows[0].id;

    for (const c of SEASON_COSMETIC_SEEDS) {
      await db.query(
        `INSERT INTO season_cosmetics (season_id, tier, type, name, rarity, preview_url)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (season_id, tier, type) DO UPDATE SET name=$4, rarity=$5, preview_url=$6`,
        [seasonId, c.tier, c.type, c.name || 'Unnamed', c.rarity, c.preview || '']
      ).catch(() => {});
    }

    // FIX: event-exclusive spin prizes (see EVENT_COSMETIC_SEEDS above)
    // were never seeded anywhere, so they could never actually be won —
    // seed them alongside the regular tier cosmetics here so one admin
    // action keeps both in sync.
    for (const c of EVENT_COSMETIC_SEEDS) {
      await db.query(
        `INSERT INTO season_cosmetics (season_id, tier, type, name, rarity, preview_url)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (season_id, tier, type) DO UPDATE SET name=$4, rarity=$5, preview_url=$6`,
        [seasonId, c.tier, c.type, c.name, c.rarity, c.preview || '']
      ).catch(() => {});
    }

    res.json({ success: true, seeded: SEASON_COSMETIC_SEEDS.length + EVENT_COSMETIC_SEEDS.length });
  } catch (err) {
    serverError(res, err);
  }
};

// ── HELPERS ───────────────────────────────────────────────

function weightedRandom(prizes) {
  const total = prizes.reduce((sum, p) => sum + (p.probability || 0.1), 0);
  let rand    = Math.random() * total;
  for (const p of prizes) {
    rand -= (p.probability || 0.1);
    if (rand <= 0) return p;
  }
  return prizes[prizes.length - 1];
}

// Returns true if the prize was actually granted, false otherwise — the
// caller (doEventSpin) uses this to decide whether to commit or roll back
// the token deduction, instead of the old behavior of always claiming
// success regardless of what actually happened.
async function awardSpinPrize(client, studentId, prize) {
  try {
    if (prize.type === 'coins' && prize.reward.coins) {
      await client.query(`UPDATE students SET coins=COALESCE(coins,0)+$1 WHERE id=$2`,
        [prize.reward.coins, studentId]);
      return true;
    }
    if (prize.type === 'gems' && prize.reward.gems) {
      await client.query(`UPDATE students SET gems=COALESCE(gems,0)+$1 WHERE id=$2`,
        [prize.reward.gems, studentId]);
      return true;
    }
    if (prize.type === 'cosmetic' && prize.reward.cosmetic) {
      const cos = await client.query(
        `SELECT id FROM season_cosmetics WHERE name=$1 LIMIT 1`, [prize.reward.cosmetic]
      );
      if (!cos.rows.length) return false; // not seeded in this environment — see EVENT_COSMETIC_SEEDS
      await client.query(
        `INSERT INTO student_season_cosmetics (student_id, cosmetic_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [studentId, cos.rows[0].id]
      );
      return true;
    }
    // FIX: 'title' prizes (e.g. season_finale's 'season_legend') had no
    // handler at all — silently fell through every branch above with no
    // grant and no error.
    if (prize.type === 'title' && prize.reward.title) {
      await client.query(
        `INSERT INTO student_titles (student_id, title_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [studentId, prize.reward.title]
      );
      return true;
    }
    if (prize.type === 'boost' && prize.reward.boost) {
      // Reuses the same student_boosts table spinController.js already
      // writes to for regular (non-event) boost spins — was previously
      // unhandled here entirely, always silently ungranted.
      const durationSeconds = prize.reward.duration || 3600;
      await client.query(
        `INSERT INTO student_boosts (student_id, boost_type, multiplier, expires_at)
         VALUES ($1,$2,$3,NOW() + ($4 || ' seconds')::interval)`,
        [studentId, prize.reward.boost, 2.0, durationSeconds]
      );
      return true;
    }
    return false; // unrecognized prize shape
  } catch (err) {
    console.error('awardSpinPrize error:', err.message);
    return false;
  }
}

module.exports = {
  getSeasonCosmetics:    exports.getSeasonCosmetics,
  claimSeasonCosmetic:   exports.claimSeasonCosmetic,
  equipCosmetic:         exports.equipCosmetic,
  getStudentLoadout:     exports.getStudentLoadout,
  getActiveSpinEvent:    exports.getActiveSpinEvent,
  doEventSpin:           exports.doEventSpin,
  createSpinEvent:       exports.createSpinEvent,
  seedSeasonCosmetics:   exports.seedSeasonCosmetics,
  SEASON_COSMETIC_SEEDS,
  buildEventSpinPrizes,
};
