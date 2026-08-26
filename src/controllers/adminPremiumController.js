const { serverError } = require('../utils/errors');
/**
 * ADMIN PREMIUM UNLOCK CONTROLLER
 * ─────────────────────────────────────────────────────────
 * From the Innovation Doc (user request):
 *   "A way admin can activate all accounts based on time he
 *    chooses — like a free day. Everyone uses the premium,
 *    enjoys it. But when locked by admin only paid
 *    subscriptions get to continue."
 *
 * How it works:
 *  1. Admin creates a "premium event" with a start/end time
 *  2. During the event: ALL students get premium features
 *     regardless of subscription status
 *  3. When the event ends: only genuinely paid students keep
 *     premium; everyone else is downgraded automatically
 *  4. Socket.io broadcasts the event state in real time
 *  5. Frontend checks `isPremiumActive` on every protected
 *     feature call — this resolves from event OR subscription
 *
 * Tables (add to migration):
 *   premium_events (id, name, start_at, end_at, activated_by, note, is_active)
 *   students.subscription_type: 'free' | 'premium' (existing column)
 *   students.subscription_expires_at: timestamp (existing or add)
 */

const db = require('../config/db');

// ── IN-MEMORY CACHE: active event ─────────────────────────
let activeEvent = null;
let eventTimer  = null;

async function loadActiveEvent() {
  const { rows } = await db.query(
    `SELECT * FROM premium_events
     WHERE is_active = true AND NOW() BETWEEN start_at AND end_at
     ORDER BY start_at DESC LIMIT 1`
  ).catch(() => ({ rows: [] }));

  activeEvent = rows[0] || null;
  return activeEvent;
}

// ── CORE CHECK: is this student premium right now? ─────────
// Called in middleware/premiumGuard — replaces raw subscription check
async function isPremiumActive(studentId) {
  // 1. Active global event → everyone is premium.
  //    Re-query DB if activeEvent is null — survives Render free-tier cold starts.
  let event = activeEvent;
  if (!event || new Date() >= new Date(event.end_at)) {
    event = await loadActiveEvent();
  }
  if (event && new Date() < new Date(event.end_at)) return true;

  // 2. Check individual subscription using the REAL columns:
  //    is_premium (boolean) + premium_expires_at (timestamp).
  //    NOTE: subscription_type does NOT exist in this DB — never query it.
  const { rows } = await db.query(
    `SELECT is_premium, premium_expires_at FROM students WHERE id=$1`, [studentId]
  ).catch(() => ({ rows: [] }));
  if (!rows.length) return false;

  const { is_premium, premium_expires_at } = rows[0];
  if (!is_premium) return false;
  if (premium_expires_at && new Date() > new Date(premium_expires_at)) return false;
  return true;
}

// ── MIDDLEWARE: requirePremium ─────────────────────────────
// Drop-in replacement anywhere you use requirePremium in routes
const requirePremium = async (req, res, next) => {
  try {
    const sid    = req.student?.id;
    if (!sid) return res.status(401).json({ error: 'Not authenticated.' });

    const premium = await isPremiumActive(sid);
    if (!premium) {
      // Check if event recently ended
      const lastEvent = await db.query(
        `SELECT end_at, name FROM premium_events
         WHERE is_active=false
         ORDER BY end_at DESC LIMIT 1`
      ).catch(() => ({ rows: [] }));

      const recentEnd = lastEvent.rows[0];
      const gracePeriod = recentEnd?.end_at
        ? Date.now() - new Date(recentEnd.end_at).getTime() < 5 * 60_000
        : false;

      return res.status(403).json({
        error:           'Premium required.',
        code:            'PREMIUM_REQUIRED',
        upgradeUrl:      '/upgrade',
        freeTrialEnded:  gracePeriod,
        lastEventName:   gracePeriod ? recentEnd?.name : null,
        message:         gracePeriod
          ? `The free premium event "${recentEnd?.name}" has ended. Upgrade to continue!`
          : 'This feature requires a premium subscription.',
      });
    }
    next();
  } catch (err) {
    serverError(res, err);
  }
};

// ── SOCKET BROADCASTER ────────────────────────────────────
function broadcastEventState(io, event, type) {
  if (!io) return;
  io.emit('premium:event', {
    type,   // 'started' | 'ended' | 'upcoming'
    event: event ? {
      id:       event.id,
      name:     event.name,
      note:     event.note,
      start_at: event.start_at,
      end_at:   event.end_at,
      endsIn:   event.end_at ? new Date(event.end_at) - new Date() : null,
    } : null,
  });
}

// ── ADMIN ENDPOINTS ───────────────────────────────────────

// GET /api/admin/premium-events
exports.listEvents = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT pe.*, a.username as activated_by_name
       FROM premium_events pe
       LEFT JOIN admins a ON a.id = pe.activated_by
       ORDER BY pe.start_at DESC LIMIT 30`
    ).catch(() => ({ rows: [] }));
    res.json({ events: rows, activeEvent });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/admin/premium-events — create + optionally auto-start
exports.createEvent = async (req, res) => {
  try {
    const io = req.app.get('io');
    const {
      name,
      note,
      startAt,          // ISO string; omit or 'now' to start immediately
      durationMinutes,  // number of minutes OR endAt
      endAt,
    } = req.body;

    const adminId = req.admin?.id || null;

    const start = (!startAt || startAt === 'now')
      ? new Date()
      : new Date(startAt);

    let end;
    if (endAt) {
      end = new Date(endAt);
    } else if (durationMinutes) {
      end = new Date(start.getTime() + parseInt(durationMinutes) * 60_000);
    } else {
      return res.status(400).json({ error: 'Provide durationMinutes or endAt.' });
    }

    if (end <= start) return res.status(400).json({ error: 'End time must be after start time.' });

    // Deactivate any running events first
    await db.query(
      `UPDATE premium_events SET is_active=false WHERE is_active=true`
    ).catch(() => {});

    const result = await db.query(
      `INSERT INTO premium_events (name, note, start_at, end_at, activated_by, is_active)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING *`,
      [name || 'Free Premium Day', note || '', start.toISOString(), end.toISOString(), adminId]
    );

    const event = result.rows[0];

    // FIX: this used to unconditionally set `activeEvent = event` and
    // broadcast 'started' right here, regardless of whether `start` was
    // actually now or scheduled for later. isPremiumActive()'s cache-
    // refresh guard only ever compares against end_at
    // (`new Date() >= new Date(event.end_at)`), never start_at — so once
    // a future-dated event was cached as `activeEvent`, every premium
    // check would see a non-expired cached event and return true
    // immediately, activating premium for the entire student base from
    // the moment of *scheduling*, not the intended future start time.
    // loadActiveEvent()'s own DB query correctly filters
    // `NOW() BETWEEN start_at AND end_at` — the bug was purely in this
    // in-memory shortcut bypassing that check. Now: only activate
    // immediately if start is now-or-past; otherwise schedule a real
    // activation timer for the future start time and leave activeEvent
    // untouched (null, or whatever the previous genuinely-active event
    // was) until then.
    if (start <= new Date()) {
      activeEvent = event;
      broadcastEventState(io, event, 'started');
    } else {
      scheduleEventStart(io, event);
    }

    // Schedule auto-end
    scheduleEventEnd(io, event);

    // Log
    console.log(`[PREMIUM EVENT] "${event.name}" ${start <= new Date() ? 'started' : 'scheduled'} — ${start <= new Date() ? 'ends' : 'starts ' + start.toISOString() + ', ends'} ${end.toISOString()}`);

    res.json({ success: true, event });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/admin/premium-events/:id/end — end early
exports.endEventEarly = async (req, res) => {
  try {
    const io = req.app.get('io');
    await db.query(
      `UPDATE premium_events SET is_active=false, end_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    if (eventTimer) { clearTimeout(eventTimer); eventTimer = null; }
    // FIX: didn't clear startTimer — cancelling a not-yet-started
    // (future-scheduled) event via this endpoint would set is_active=false
    // in the DB, but the pending scheduleEventStart timer from createEvent
    // would still fire later regardless and activate it anyway, since
    // that timer has no awareness this endpoint was ever called.
    if (startTimer) { clearTimeout(startTimer); startTimer = null; }
    activeEvent = null;
    broadcastEventState(io, null, 'ended');
    res.json({ success: true, message: 'Premium event ended.' });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/admin/premium-events/active
exports.getActiveEvent = async (req, res) => {
  const event = await loadActiveEvent();
  res.json({
    active:  !!event,
    event:   event || null,
    endsIn:  event ? Math.max(0, new Date(event.end_at) - new Date()) : null,
    endsInLabel: event ? formatDuration(new Date(event.end_at) - new Date()) : null,
  });
};

// GET /api/premium-status — student-facing, no admin required
exports.getPremiumStatus = async (req, res) => {
  try {
    const sid    = req.student.id;
    const event  = await loadActiveEvent();
    const fromEvent = !!event;
    const fromSub   = !fromEvent && await isPremiumActive(sid);

    const { rows } = await db.query(
      `SELECT is_premium, premium_expires_at FROM students WHERE id=$1`, [sid]
    );
    const sub = rows[0];

    res.json({
      isPremium:        fromEvent || fromSub,
      source:           fromEvent ? 'event' : fromSub ? 'subscription' : 'none',
      event:            fromEvent ? {
        name:    event.name,
        note:    event.note,
        end_at:  event.end_at,
        endsIn:  Math.max(0, new Date(event.end_at) - new Date()),
        endsInLabel: formatDuration(new Date(event.end_at) - new Date()),
      } : null,
      subscription: {
        type:      sub?.is_premium ? 'premium' : 'free',
        expiresAt: sub?.premium_expires_at || null,
        active:    fromSub,
      },
      upgradeUrl: '/upgrade',
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── AUTO-START SCHEDULER (for events created with a future startAt) ────
let startTimer = null;
function scheduleEventStart(io, event) {
  if (startTimer) clearTimeout(startTimer);
  const ms = new Date(event.start_at) - new Date();
  if (ms <= 0) { activeEvent = event; broadcastEventState(io, event, 'started'); return; }

  startTimer = setTimeout(() => {
    activeEvent = event;
    broadcastEventState(io, event, 'started');
    console.log(`[PREMIUM EVENT] "${event.name}" started (scheduled) — ends ${event.end_at}`);
  }, ms);
}

// ── AUTO-END SCHEDULER ────────────────────────────────────
function scheduleEventEnd(io, event) {
  if (eventTimer) clearTimeout(eventTimer);
  const ms = new Date(event.end_at) - new Date();
  if (ms <= 0) return;

  // 5-minute warning
  if (ms > 5 * 60_000) {
    setTimeout(() => {
      if (io) io.emit('premium:event_warning', {
        message:    '⚠️ Free premium ends in 5 minutes! Upgrade to keep access.',
        endsIn:     5 * 60_000,
        upgradeUrl: '/upgrade',
      });
    }, ms - 5 * 60_000);
  }

  eventTimer = setTimeout(async () => {
    await db.query(
      `UPDATE premium_events SET is_active=false WHERE id=$1`, [event.id]
    ).catch(() => {});
    activeEvent = null;
    broadcastEventState(io, null, 'ended');
    console.log(`[PREMIUM EVENT] "${event.name}" ended — reverted to paid-only.`);
  }, ms);
}

// ── STARTUP: restore any active OR pending event on server restart ───
exports.initPremiumEvents = async (io) => {
  const event = await loadActiveEvent();
  if (event) {
    console.log(`[PREMIUM EVENT] Restored active event: "${event.name}"`);
    scheduleEventEnd(io, event);
    return;
  }

  // FIX: loadActiveEvent() only finds events where NOW() is already
  // BETWEEN start_at AND end_at — a future-scheduled event (created with
  // startAt in the future, per the scheduleEventStart fix above) doesn't
  // match that until it actually starts. Without this, a server
  // restart/redeploy between "event created" and "event's start time"
  // would silently lose the pending activation forever — the timer that
  // was going to flip it live at start_at only existed in the crashed
  // process's memory, and nothing would ever re-arm it.
  const { rows } = await db.query(
    `SELECT * FROM premium_events
     WHERE is_active = true AND start_at > NOW()
     ORDER BY start_at ASC LIMIT 1`
  ).catch(() => ({ rows: [] }));

  if (rows[0]) {
    console.log(`[PREMIUM EVENT] Restored pending event: "${rows[0].name}", starts ${rows[0].start_at}`);
    scheduleEventStart(io, rows[0]);
    scheduleEventEnd(io, rows[0]);
  }
};

// ── HELPER ────────────────────────────────────────────────
function formatDuration(ms) {
  if (ms <= 0) return 'Expired';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

module.exports = {
  isPremiumActive,
  requirePremium,
  listEvents:       exports.listEvents,
  createEvent:      exports.createEvent,
  endEventEarly:    exports.endEventEarly,
  getActiveEvent:   exports.getActiveEvent,
  getPremiumStatus: exports.getPremiumStatus,
  initPremiumEvents: exports.initPremiumEvents,
  isPremiumActive,
  loadActiveEvent,
  broadcastEventState,
};
