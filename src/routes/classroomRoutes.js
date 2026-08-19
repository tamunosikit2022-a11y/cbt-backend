const express = require("express");
const router  = express.Router();
const db      = require("../config/db");
const { requireStudent } = require("../middleware/auth");
const { serverError } = require('../utils/errors');

router.use(requireStudent);

// Get active sessions (students can browse)
router.get("/sessions", async (req, res) => {
  try {
    const r = await db.query(
      `SELECT code, teacher_name, subject, title, description, theme_color, icon, created_at
       FROM classroom_sessions WHERE status='active'
       ORDER BY created_at DESC LIMIT 20`
    );
    res.json(r.rows);
  } catch(err) { serverError(res, err); }
});

// Get session history for teacher
router.get("/my-sessions", async (req, res) => {
  try {
    const r = await db.query(
      `SELECT code, subject, title, description, theme_color, icon,
              status, created_at, ended_at, peak_count
       FROM classroom_sessions WHERE teacher_id=$1
       ORDER BY created_at DESC LIMIT 50`,
      [req.student.id]
    );
    res.json(r.rows);
  } catch(err) { serverError(res, err); }
});

// ── PAST CLASSES (student side) ───────────────────────────
// FIX: students previously had no way to look back at classes they
// attended — only the teacher's own `/my-sessions` existed. This joins
// the new classroom_participants attendance table back to the sessions
// they belong to.
router.get("/my-attended", async (req, res) => {
  try {
    const r = await db.query(
      `SELECT DISTINCT ON (cs.code)
              cs.code, cs.subject, cs.title, cs.description, cs.theme_color,
              cs.icon, cs.teacher_name, cs.status, cs.created_at, cs.ended_at
       FROM classroom_participants cp
       JOIN classroom_sessions cs ON cs.code = cp.session_code
       WHERE cp.student_id = $1
       ORDER BY cs.code, cs.created_at DESC`,
      [req.student.id]
    );
    // Most recent first
    r.rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(r.rows);
  } catch(err) { serverError(res, err); }
});

// ── REPLAY A PAST CLASS ────────────────────────────────────
// Returns the archived whiteboard + chat for an ended session. Only the
// teacher who ran it, or a student who actually attended it, can open it.
router.get("/session/:code/archive", async (req, res) => {
  try {
    const code = (req.params.code || "").toUpperCase();
    const sessRes = await db.query(
      `SELECT code, teacher_id, teacher_name, subject, title, description,
              theme_color, icon, status, created_at, ended_at,
              board_archive, chat_archive, peak_count
       FROM classroom_sessions WHERE code=$1`,
      [code]
    );
    if (!sessRes.rows.length) return res.status(404).json({ error: "Class not found." });
    const sess = sessRes.rows[0];

    const isTeacher = sess.teacher_id === req.student.id;
    let attended = isTeacher;
    if (!attended) {
      const p = await db.query(
        `SELECT 1 FROM classroom_participants WHERE session_code=$1 AND student_id=$2 LIMIT 1`,
        [code, req.student.id]
      );
      attended = p.rows.length > 0;
    }
    if (!attended) return res.status(403).json({ error: "You didn't attend this class." });

    res.json({
      session: {
        code: sess.code, teacherName: sess.teacher_name, subject: sess.subject,
        title: sess.title, description: sess.description, themeColor: sess.theme_color,
        icon: sess.icon, status: sess.status, createdAt: sess.created_at,
        endedAt: sess.ended_at, peakCount: sess.peak_count,
      },
      board: sess.board_archive || [],
      chat:  sess.chat_archive  || [],
    });
  } catch(err) { serverError(res, err); }
});

module.exports = router;
