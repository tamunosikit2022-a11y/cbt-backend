/**
 * pushController.js
 * Handles Web Push subscriptions and sending push notifications.
 * Uses VAPID keys — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Render env.
 */

const db      = require('../config/db');
const webpush = require('web-push');
const { serverError } = require('../utils/errors');

// Configure VAPID
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.EMAIL_USER || 'scholarssyndicate70@gmail.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ── Notification templates ─────────────────────────────────
const TEMPLATES = {
  streak_risk: (streak) => ({
    title: `🔥 ${streak}-day streak at risk!`,
    body:  `You haven't practiced today. One quick exam keeps your streak alive!`,
    url:   '/exam-select',
    tag:   'streak-reminder',
  }),
  streak_lost: () => ({
    title: '💔 You lost your streak',
    body:  'Start a new one today — it only takes one exam. You got this, Scholar!',
    url:   '/exam-select',
    tag:   'streak-lost',
  }),
  daily_mission: (count) => ({
    title: '🎯 Daily missions waiting!',
    body:  `You have ${count} missions to complete today. Earn XP and coins!`,
    url:   '/missions',
    tag:   'daily-missions',
  }),
  arena_challenge: (challenger) => ({
    title: `⚔️ ${challenger} challenged you!`,
    body:  `${challenger} wants to battle you in the Arena. Accept and prove your knowledge!`,
    url:   '/arena',
    tag:   'arena-challenge',
  }),
  jamb_countdown: (days) => ({
    title: `⏳ JAMB in ${days} day${days === 1 ? '' : 's'}!`,
    body:  days === 1
      ? 'Your exam is TOMORROW. Do a final review right now!'
      : `${days} days left. Keep practicing every day — consistency wins.`,
    url:   '/dashboard',
    tag:   'jamb-countdown',
  }),
  spin_ready: () => ({
    title: '🎰 Your daily spin is ready!',
    body:  'Spin the wheel and win coins, tokens, or XP boosts. Takes 10 seconds!',
    url:   '/spin',
    tag:   'spin-ready',
  }),
  mission_complete: (name) => ({
    title: '✅ Mission complete! Claim your reward',
    body:  `"${name}" is done. Tap to collect your XP and coins!`,
    url:   '/missions',
    tag:   'mission-complete',
  }),
  welcome_back: (name) => ({
    title: `👋 Welcome back, ${name}!`,
    body:  'Your classmates have been practicing. Time to catch up!',
    url:   '/dashboard',
    tag:   'welcome-back',
  }),
};

// ── Save push subscription ─────────────────────────────────
exports.saveSubscription = async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

    await db.query(
      `INSERT INTO push_subscriptions (student_id, endpoint, p256dh, auth, created_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (endpoint) DO UPDATE SET
         student_id=$1, p256dh=$3, auth=$4, updated_at=NOW()`,
      [
        req.student.id,
        subscription.endpoint,
        subscription.keys?.p256dh,
        subscription.keys?.auth,
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('saveSubscription error:', err);
    serverError(res, err);
  }
};

// ── Delete subscription (opt-out) ─────────────────────────
exports.deleteSubscription = async (req, res) => {
  try {
    await db.query('DELETE FROM push_subscriptions WHERE student_id=$1', [req.student.id]);
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
};

// ── Get VAPID public key ───────────────────────────────────
exports.getVapidKey = (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
};

// ── Internal: send push to one student ────────────────────
async function sendToStudent(studentId, template) {
  try {
    const { rows } = await db.query(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE student_id=$1',
      [studentId]
    );
    if (!rows.length) return;

    const payload = JSON.stringify({
      title:   template.title,
      body:    template.body,
      url:     template.url,
      tag:     template.tag,
      icon:    '/icons/icon-192x192.png',
    });

    for (const sub of rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch (e) {
        // Remove invalid subscriptions (410 = expired)
        if (e.statusCode === 410 || e.statusCode === 404) {
          await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
        }
      }
    }
  } catch (err) {
    console.error('sendToStudent error:', err);
  }
}

// ── Internal: send push to multiple students ───────────────
async function sendToStudents(studentIds, template) {
  await Promise.all(studentIds.map(id => sendToStudent(id, template)));
}

// ── Scheduled jobs (called by cron-like setup on server) ───
exports.runDailyRetentionJobs = async () => {
  const now = new Date();
  const hour = now.getHours(); // server time

  try {
    // Job 1: Streak risk warning (run at 7pm = 19:00)
    if (hour === 19) {
      // BUGFIX: current_streak lives on the `streaks` table (joined by
      // student_id), not directly on `students` — this query was selecting
      // s.current_streak straight off `students`, which has no such column,
      // so Postgres threw a missing-column error on every single run
      // (silently swallowed by the outer try/catch below, hence no student
      // ever actually received a streak-risk notification).
      // Students with streak >= 2 who haven't practiced today
      const { rows } = await db.query(`
        SELECT s.id, st.current_streak
        FROM students s
        JOIN streaks st ON st.student_id = s.id
        WHERE st.current_streak >= 2
          AND s.last_seen < CURRENT_DATE
          AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.student_id = s.id)
      `);
      for (const s of rows) {
        await sendToStudent(s.id, TEMPLATES.streak_risk(s.current_streak));
      }
      console.log(`📬 Streak risk notifications sent to ${rows.length} students`);
    }

    // Job 2: Spin wheel ready reminder (run at 10am)
    if (hour === 10) {
      // Students who haven't spun today
      const { rows } = await db.query(`
        SELECT s.id FROM students s
        WHERE (s.last_spin_at IS NULL OR s.last_spin_at < CURRENT_DATE)
          AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.student_id = s.id)
        LIMIT 500
      `);
      await sendToStudents(rows.map(r => r.id), TEMPLATES.spin_ready());
      console.log(`🎰 Spin ready notifications sent to ${rows.length} students`);
    }

    // Job 3: Daily mission reminder (run at 2pm)
    // BUGFIX: this query was missing its WHERE keyword ("EXISTS (...)" was
    // dangling straight after "FROM students s" with no WHERE in front of it),
    // which is invalid SQL — this job has been throwing a syntax error and
    // silently failing (swallowed by the outer try/catch) on every single run.
    if (hour === 14) {
      const { rows } = await db.query(`
        SELECT DISTINCT s.id FROM students s
        WHERE EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.student_id = s.id)
        LIMIT 500
      `);
      await sendToStudents(rows.map(r => r.id), TEMPLATES.daily_mission(3));
      console.log(`🎯 Mission reminders sent to ${rows.length} students`);
    }

  } catch (err) {
    console.error('runDailyRetentionJobs error:', err);
  }
};

// ── Public trigger functions (used by other controllers) ───
exports.notifyArenaChallenge = (studentId, challengerName) =>
  sendToStudent(studentId, TEMPLATES.arena_challenge(challengerName));

exports.notifyMissionComplete = (studentId, missionName) =>
  sendToStudent(studentId, TEMPLATES.mission_complete(missionName));

exports.TEMPLATES   = TEMPLATES;
exports.sendToStudent = sendToStudent;
exports.sendToStudents = sendToStudents;


// ── DAILY QUESTION PUSH ───────────────────────────────────
// Wired into server.js cron at 07:00 WAT (it previously wasn't scheduled
// anywhere at all, so this feature has never actually run in production).
// Picks a random JAMB question and broadcasts it as a push notification.
// Students tap the notification and land on /exam-select pre-loaded.
exports.sendDailyQuestionPush = async () => {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.log("VAPID keys not set — skipping daily question push.");
    return;
  }

  // Pick a random JAMB question from the last year
  const qRes = await db.query(
    `SELECT id, subject, question FROM questions
     WHERE exam_type = 'JAMB' AND year >= 2015
     ORDER BY RANDOM() LIMIT 1`
  );
  if (!qRes.rows.length) return;
  const q = qRes.rows[0];

  // BUGFIX: this used to select a single JSON "subscription" column and read
  // it with subscription->>'endpoint', but push_subscriptions actually stores
  // endpoint/p256dh/auth as separate columns (see saveSubscription above) —
  // that column doesn't exist, so this query has always thrown a DB error
  // and this whole feature has silently never sent a single notification.
  const subRes = await db.query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions
     WHERE created_at > NOW() - INTERVAL '90 days'`
  );
  if (!subRes.rows.length) return;

  const TEMPLATE = {
    title: `📚 Daily JAMB ${q.subject} Question`,
    body:  q.question.slice(0, 100) + (q.question.length > 100 ? "…" : ""),
    url:   `/exam-select?subject=${encodeURIComponent(q.subject)}&type=JAMB`,
    tag:   "daily-question",
    icon:  "/icons/icon-192x192.png",
  };

  const payload = JSON.stringify(TEMPLATE);
  let sent = 0, failed = 0;

  for (const row of subRes.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload
      );
      sent++;
    } catch (err) {
      failed++;
      // Remove expired subscriptions (410 = gone, 404 = not found)
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [row.endpoint]).catch(() => {});
      }
    }
  }
  console.log(`📲 Daily push: ${sent} sent, ${failed} failed`);
};
