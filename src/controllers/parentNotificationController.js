/**
 * parentNotificationController.js — Scholars Syndicate
 * FIX: TERMII_API_KEY was in .env.example but never used.
 *      Parents saw exam scores passively but received no proactive alerts.
 *
 * This module:
 *   1. Provides a sendTermiiSMS() helper
 *   2. Exports notifyParent() — call this from examController after saving a session
 *   3. Exports a route handler for manual re-send
 *
 * Usage in examController.js (after saving exam_session):
 *   const { notifyParent } = require("./parentNotificationController");
 *   notifyParent(student_id, { subject, score, total, percentage }).catch(() => {});
 */

const db = require("../config/db");
const { serverError } = require('../utils/errors');

// ── TERMII SMS HELPER ─────────────────────────────────────
async function sendTermiiSMS(phone, message) {
  const apiKey   = process.env.TERMII_API_KEY;
  const senderId = process.env.TERMII_SENDER_ID || "N-Alert";

  if (!apiKey) {
    console.warn("TERMII_API_KEY not set — skipping parent SMS.");
    return;
  }

  // Normalise Nigerian number → international format
  let to = phone.toString().replace(/\s/g, "");
  if (to.startsWith("0")) to = "234" + to.slice(1);
  if (!to.startsWith("234")) to = "234" + to;

  const body = JSON.stringify({
    to,
    from:     senderId,
    sms:      message,
    type:     "plain",
    channel:  "generic",
    api_key:  apiKey,
  });

  try {
    const https = require("https");
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.ng.termii.com",
        path:     "/api/sms/send",
        method:   "POST",
        headers: {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, (res) => {
        let raw = "";
        res.on("data", c => raw += c);
        res.on("end", () => resolve(raw));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error("Termii SMS error:", err.message);
  }
}

// ── NOTIFY PARENT ─────────────────────────────────────────
// Called internally after every exam session save.
// Silently no-ops if: no parent registered, no phone, or Termii unavailable.
exports.notifyParent = async (student_id, { subject, score, total, percentage, exam_type = "JAMB" }) => {
  try {
    // Get parent phone for this student
    const r = await db.query(
      `SELECT p.phone, p.full_name, s.full_name AS student_name
       FROM parents p
       JOIN students s ON s.id = p.student_id
       WHERE p.student_id = $1 AND p.phone IS NOT NULL AND p.phone != ''`,
      [student_id]
    );
    if (!r.rows.length) return; // no parent registered, nothing to do

    const { phone, full_name: parentName, student_name } = r.rows[0];
    const pct = parseFloat(percentage || 0).toFixed(0);
    const emoji = pct >= 70 ? "🟢" : pct >= 50 ? "🟡" : "🔴";

    const msg =
      `${emoji} Scholars Syndicate Update\n` +
      `${student_name} just completed a ${exam_type} ${subject || "practice"} exam.\n` +
      `Score: ${score}/${total} (${pct}%)\n` +
      `Keep encouraging them! — Scholars Syndicate`;

    await sendTermiiSMS(phone, msg);
  } catch (err) {
    // Never let notification failure break the exam flow
    console.error("notifyParent error:", err.message);
  }
};

// ── ROUTE: RESEND NOTIFICATION ────────────────────────────
// POST /api/parent/notify-test  (admin or student can trigger a test ping)
exports.sendTestNotification = async (req, res) => {
  const student_id = req.student?.id;
  if (!student_id) return res.status(401).json({ error: "Not authenticated." });

  try {
    await exports.notifyParent(student_id, {
      subject:    "Practice",
      score:      32,
      total:      40,
      percentage: 80,
      exam_type:  "JAMB",
    });
    res.json({ ok: true, message: "Test notification sent to parent (if registered)." });
  } catch (err) {
    serverError(res, err);
  }
};
