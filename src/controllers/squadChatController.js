/**
 * squadChatController.js — Scholars Syndicate
 * NEW FEATURE: Persistent async chat for squads.
 * ClassroomSession.js had live session chat but squads had no way to
 * coordinate OUTSIDE active sessions — messages were lost on disconnect.
 *
 * This controller stores squad messages in the DB so they persist.
 * Real-time delivery uses the existing arena socket (if available)
 * with REST as the reliable fallback for poll/page-load.
 */

const db = require("../config/db");
const { serverError } = require('../utils/errors');
// NEW: run every squad message through the shared profanity filter before
// it's saved — same policy as Community Chat, so bad language is caught
// everywhere students can message each other, not just in one room.
const { moderateMessage } = require('../utils/profanityFilter');

// ── GET CHAT HISTORY ──────────────────────────────────────
// GET /api/squads/chat?limit=40&before=<message_id>
exports.getMessages = async (req, res) => {
  const student_id = req.student.id;
  const limit = Math.min(parseInt(req.query.limit) || 40, 100);
  const before = req.query.before ? parseInt(req.query.before) : null;

  try {
    // Get student's squad
    const squadRes = await db.query(
      "SELECT squad_id FROM squad_members WHERE student_id=$1",
      [student_id]
    );
    if (!squadRes.rows.length) {
      return res.status(403).json({ error: "You are not in a squad." });
    }
    const squad_id = squadRes.rows[0].squad_id;

    const msgs = await db.query(
      `SELECT m.id, m.content, m.type, m.created_at,
              s.full_name AS sender_name, s.id AS sender_id
       FROM squad_messages m
       JOIN students s ON s.id = m.student_id
       WHERE m.squad_id = $1
         ${before ? "AND m.id < $3" : ""}
       ORDER BY m.created_at DESC
       LIMIT $2`,
      before ? [squad_id, limit, before] : [squad_id, limit]
    );

    res.json({
      squad_id,
      messages: msgs.rows.reverse(), // oldest first for display
      has_more: msgs.rows.length === limit,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── SEND MESSAGE ──────────────────────────────────────────
// POST /api/squads/chat
// Body: { content: string, type?: "text"|"emoji" }
exports.sendMessage = async (req, res) => {
  const student_id = req.student.id;
  const { content, type = "text" } = req.body;

  if (!content?.trim()) return res.status(400).json({ error: "Message cannot be empty." });
  if (content.length > 500) return res.status(400).json({ error: "Message too long (max 500 chars)." });

  // NEW: profanity check — reject slurs/hate speech outright, censor
  // milder swear words so the message still sends.
  const moderation = moderateMessage(content);
  if (!moderation.ok) return res.status(400).json({ error: moderation.reason });
  const cleanContent = moderation.cleaned;

  try {
    const squadRes = await db.query(
      `SELECT sm.squad_id, sq.name AS squad_name
       FROM squad_members sm JOIN squads sq ON sq.id = sm.squad_id
       WHERE sm.student_id = $1`,
      [student_id]
    );
    if (!squadRes.rows.length) {
      return res.status(403).json({ error: "You are not in a squad." });
    }
    const { squad_id } = squadRes.rows[0];

    const result = await db.query(
      `INSERT INTO squad_messages (squad_id, student_id, content, type, created_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING id, created_at`,
      [squad_id, student_id, cleanContent, type]
    );

    const senderRes = await db.query(
      "SELECT full_name FROM students WHERE id=$1",
      [student_id]
    );

    const message = {
      id:           result.rows[0].id,
      squad_id,
      sender_id:    student_id,
      sender_name:  senderRes.rows[0].full_name,
      content:      cleanContent,
      type,
      created_at:   result.rows[0].created_at,
    };

    res.status(201).json({ ok: true, message });
  } catch (err) {
    serverError(res, err);
  }
};

// ── DELETE OWN MESSAGE ────────────────────────────────────
// DELETE /api/squads/chat/:id
exports.deleteMessage = async (req, res) => {
  const student_id = req.student.id;
  const { id } = req.params;
  try {
    const r = await db.query(
      "DELETE FROM squad_messages WHERE id=$1 AND student_id=$2 RETURNING id",
      [id, student_id]
    );
    if (!r.rows.length) return res.status(403).json({ error: "Not found or not yours." });
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
  }
};
