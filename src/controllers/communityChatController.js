/**
 * communityChatController.js — Scholars Syndicate
 * NEW FEATURE: Community Chat — one global room every logged-in student
 * can post in, unlike Squad Chat which is scoped to a student's own squad.
 *
 * Every message is run through the shared profanity filter
 * (src/utils/profanityFilter.js) before it's saved:
 *   - slurs / hate speech  -> message rejected outright
 *   - milder swear words   -> message saved with the word censored
 *
 * Admins can additionally hide a message after the fact (for anything
 * borderline the automatic filter doesn't catch) and mute a student who
 * keeps breaking the rules.
 */

const db = require('../config/db');
const { serverError } = require('../utils/errors');
const { moderateMessage } = require('../utils/profanityFilter');

const PAGE_LIMIT_MAX = 100;

// ── GET CHAT HISTORY ──────────────────────────────────────
// GET /api/community-chat?limit=50&before=<message_id>
exports.getMessages = async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, PAGE_LIMIT_MAX);
    const before = req.query.before ? parseInt(req.query.before) : null;

    const msgs = await db.query(
      `SELECT m.id, m.content, m.created_at,
              s.id AS sender_id, s.full_name AS sender_name
       FROM community_messages m
       JOIN students s ON s.id = m.student_id
       WHERE m.is_hidden = FALSE
         ${before ? 'AND m.id < $2' : ''}
       ORDER BY m.created_at DESC
       LIMIT $1`,
      before ? [limit, before] : [limit]
    );

    res.json({
      messages: msgs.rows.reverse(), // oldest first for display
      has_more: msgs.rows.length === limit,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── SEND MESSAGE ──────────────────────────────────────────
// POST /api/community-chat   body: { content: string }
exports.sendMessage = async (req, res) => {
  const student_id = req.student.id;
  const { content } = req.body;

  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }
  if (content.length > 500) {
    return res.status(400).json({ error: 'Message too long (max 500 characters).' });
  }

  try {
    // Muted students are blocked before we even touch the profanity filter.
    const muteRes = await db.query(
      `SELECT reason, muted_until FROM community_chat_mutes WHERE student_id=$1`,
      [student_id]
    ).catch(() => ({ rows: [] }));

    if (muteRes.rows.length) {
      const { reason, muted_until } = muteRes.rows[0];
      const stillMuted = !muted_until || new Date(muted_until) > new Date();
      if (stillMuted) {
        return res.status(403).json({
          error: reason
            ? `You've been muted from Community Chat: ${reason}`
            : "You've been muted from Community Chat by an admin.",
          muted_until,
        });
      }
      // Mute has expired — clean it up so we don't check it every time.
      await db.query(`DELETE FROM community_chat_mutes WHERE student_id=$1`, [student_id]).catch(() => {});
    }

    const moderation = moderateMessage(content);
    if (!moderation.ok) {
      return res.status(400).json({ error: moderation.reason });
    }

    const result = await db.query(
      `INSERT INTO community_messages (student_id, content, created_at)
       VALUES ($1,$2,NOW()) RETURNING id, created_at`,
      [student_id, moderation.cleaned]
    );

    const senderRes = await db.query(
      `SELECT full_name FROM students WHERE id=$1`, [student_id]
    );

    res.status(201).json({
      ok: true,
      message: {
        id:          result.rows[0].id,
        sender_id:   student_id,
        sender_name: senderRes.rows[0].full_name,
        content:     moderation.cleaned,
        created_at:  result.rows[0].created_at,
      },
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── DELETE OWN MESSAGE ────────────────────────────────────
// DELETE /api/community-chat/:id
exports.deleteMessage = async (req, res) => {
  const student_id = req.student.id;
  const { id } = req.params;
  try {
    const r = await db.query(
      `DELETE FROM community_messages WHERE id=$1 AND student_id=$2 RETURNING id`,
      [id, student_id]
    );
    if (!r.rows.length) return res.status(403).json({ error: 'Not found or not yours.' });
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
  }
};

// ── ADMIN: HIDE A MESSAGE ─────────────────────────────────
// POST /api/admin/community-chat/:id/hide   body: { reason? }
exports.adminHideMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = null } = req.body;
    const r = await db.query(
      `UPDATE community_messages
       SET is_hidden=TRUE, hidden_by=$1, hidden_reason=$2
       WHERE id=$3 RETURNING id`,
      [req.admin?.id || null, reason, id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Message not found.' });
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
  }
};

// ── ADMIN: MUTE / UNMUTE A STUDENT ────────────────────────
// POST /api/admin/community-chat/mute   body: { student_id, reason?, hours? }
exports.adminMuteStudent = async (req, res) => {
  try {
    const { student_id, reason = null, hours = null } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id is required.' });

    const mutedUntil = hours ? new Date(Date.now() + hours * 3600 * 1000) : null;

    await db.query(
      `INSERT INTO community_chat_mutes (student_id, muted_by, reason, muted_until)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (student_id) DO UPDATE
         SET muted_by=$2, reason=$3, muted_until=$4, created_at=NOW()`,
      [student_id, req.admin?.id || null, reason, mutedUntil]
    );

    res.json({ ok: true, muted_until: mutedUntil });
  } catch (err) {
    serverError(res, err);
  }
};

// DELETE /api/admin/community-chat/mute/:student_id
exports.adminUnmuteStudent = async (req, res) => {
  try {
    await db.query(
      `DELETE FROM community_chat_mutes WHERE student_id=$1`,
      [req.params.student_id]
    );
    res.json({ ok: true });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/admin/community-chat/mutes
exports.adminListMutes = async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cm.*, s.full_name FROM community_chat_mutes cm
       JOIN students s ON s.id = cm.student_id
       ORDER BY cm.created_at DESC`
    );
    res.json({ mutes: rows });
  } catch (err) {
    serverError(res, err);
  }
};
