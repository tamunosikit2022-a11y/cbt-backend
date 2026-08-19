/**
 * parentController.js
 * Handles parent registration (via student link code), login, and dashboard data.
 */

const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const db     = require("../config/db");
const { serverError } = require('../utils/errors');
const { computePredictedScore } = require('./innovationController');

const generateToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "30d" });

// ── REGISTER PARENT ───────────────────────────────────────
// POST /api/parent/register
// Body: { full_name, email, phone, password, link_code }
exports.register = async (req, res) => {
  try {
    const { full_name, email, phone, password, link_code } = req.body;
    if (!full_name?.trim()) return res.status(400).json({ error: "Full name is required." });
    if (!email?.trim())     return res.status(400).json({ error: "Email is required." });
    if (!password)          return res.status(400).json({ error: "Password is required." });
    if (!link_code?.trim()) return res.status(400).json({ error: "Student link code is required." });

    // Find student by link code
    const studentRes = await db.query(
      "SELECT id, full_name, school_class, target_university FROM students WHERE UPPER(parent_link_code) = UPPER($1)",
      [link_code.trim()]
    );
    if (!studentRes.rows.length) {
      return res.status(404).json({ error: "Invalid link code. Ask your child for their code from the app." });
    }
    const student = studentRes.rows[0];

    // Check email not already used
    const existing = await db.query("SELECT id FROM parents WHERE LOWER(email) = LOWER($1)", [email.trim()]);
    if (existing.rows.length) return res.status(400).json({ error: "Email already registered." });

    const hash   = await bcrypt.hash(password, 12);
    const result = await db.query(
      `INSERT INTO parents (full_name, email, phone, password_hash, student_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, full_name, email, student_id`,
      [full_name.trim(), email.trim().toLowerCase(), phone || null, hash, student.id]
    );

    const parent = result.rows[0];
    const token  = generateToken({ id: parent.id, role: "parent", student_id: student.id });

    res.status(201).json({
      token,
      parent,
      student: { id: student.id, full_name: student.full_name },
    });
  } catch (err) {
    console.error("Parent register error:", err.message);
    serverError(res, err);
  }
};

// ── LOGIN PARENT ──────────────────────────────────────────
// POST /api/parent/login
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required." });

    const result = await db.query(
      "SELECT * FROM parents WHERE LOWER(email) = LOWER($1)",
      [email.trim()]
    );
    if (!result.rows.length) return res.status(401).json({ error: "Invalid email or password." });

    const parent  = result.rows[0];
    const valid   = await bcrypt.compare(password, parent.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password." });

    const token = generateToken({ id: parent.id, role: "parent", student_id: parent.student_id });
    res.json({ token, parent: { id: parent.id, full_name: parent.full_name, student_id: parent.student_id } });
  } catch (err) {
    serverError(res, err);
  }
};

// ── SHARED: fetch all dashboard data for a student ────────
// Used by both the JSON dashboard endpoint and the PDF report endpoint,
// so the two never drift out of sync with each other.
async function fetchStudentDashboardData(student_id) {
  const profileRes = await db.query(
    `SELECT s.id, s.full_name, s.email, s.phone, s.avatar_url,
            s.school_class, s.target_university, s.target_course,
            s.state_of_origin, s.is_premium, s.last_seen, s.created_at,
            COALESCE(s.points, 0) AS points,
            COALESCE(s.coins,  0) AS coins,
            COALESCE(s.gems,   0) AS gems,
            COALESCE(s.level,  1) AS level,
            st.current_streak, st.longest_streak
     FROM students s
     LEFT JOIN streaks st ON st.student_id = s.id
     WHERE s.id = $1`,
    [student_id]
  );
  if (!profileRes.rows.length) return null;
  const profile = profileRes.rows[0];

  const historyRes = await db.query(
    `SELECT id, exam_type, subject, score, total_questions, percentage,
            time_taken_seconds, created_at
     FROM exam_sessions
     WHERE student_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [student_id]
  );

  const subjectRes = await db.query(
    `SELECT subject,
            COUNT(*)                          AS total_exams,
            ROUND(AVG(percentage), 1)         AS avg_score,
            MAX(percentage)                   AS best_score,
            MIN(percentage)                   AS worst_score,
            SUM(score)                        AS total_correct,
            SUM(total_questions)              AS total_questions
     FROM exam_sessions
     WHERE student_id = $1
     GROUP BY subject
     ORDER BY avg_score DESC`,
    [student_id]
  );

  const trendRes = await db.query(
    `SELECT percentage, subject, completed_at
     FROM exam_sessions
     WHERE student_id = $1
     ORDER BY completed_at DESC
     LIMIT 10`,
    [student_id]
  );

  const statsRes = await db.query(
    `SELECT COUNT(*)                        AS total_exams,
            ROUND(AVG(percentage), 1)       AS overall_avg,
            MAX(percentage)                 AS best_score,
            SUM(time_taken_seconds)         AS total_study_seconds,
            COUNT(DISTINCT subject)         AS subjects_practiced
     FROM exam_sessions
     WHERE student_id = $1`,
    [student_id]
  );
  const stats = statsRes.rows[0];

  const jambRes = await db.query(
    `SELECT percentage FROM exam_sessions
     WHERE student_id=$1 AND exam_type='JAMB'
     ORDER BY completed_at DESC LIMIT 5`,
    [student_id]
  );
  // FIX: this used to compute its own predicted score from a plain average
  // of the last 5 JAMB percentages (±8% for a range) — a different formula
  // from the student's own /predicted page (which weights lifetime accuracy
  // vs. recent performance per-subject and always counts English +
  // top-3-others, matching real JAMB scoring). That meant a parent could
  // see a materially different predicted score than their child saw for
  // the same underlying performance. Now both use the exact same
  // calculation, and the ±margin below is purely presentational (a range
  // around the one true number, not a second calculation of it).
  let predictedScore = null;
  if (jambRes.rows.length >= 2) {
    const { predicted_jamb_score } = await computePredictedScore(student_id);
    const low  = Math.max(0, predicted_jamb_score - 15);
    const high = Math.min(400, predicted_jamb_score + 15);
    predictedScore = { low, high, avg: predicted_jamb_score };
  }

  const activityRes = await db.query(
    `SELECT DATE(completed_at) AS day, COUNT(*) AS exams
     FROM exam_sessions
     WHERE student_id = $1 AND completed_at > NOW() - INTERVAL '7 days'
     GROUP BY DATE(completed_at) ORDER BY day`,
    [student_id]
  );

  return {
    profile,
    stats: {
      total_exams:          parseInt(stats.total_exams) || 0,
      overall_avg:          parseFloat(stats.overall_avg) || 0,
      best_score:           parseFloat(stats.best_score) || 0,
      total_study_hours:    Math.round((parseInt(stats.total_study_seconds) || 0) / 3600 * 10) / 10,
      subjects_practiced:   parseInt(stats.subjects_practiced) || 0,
    },
    subjects:        subjectRes.rows,
    recent_exams:    historyRes.rows,
    score_trend:     trendRes.rows.reverse(),
    predicted_score: predictedScore,
    weekly_activity: activityRes.rows,
  };
}

// ── GET STUDENT DASHBOARD DATA ────────────────────────────
// GET /api/parent/dashboard
// Requires parent JWT (req.parent set by middleware)
exports.getDashboard = async (req, res) => {
  try {
    const student_id = req.parent.student_id;
    const data = await fetchStudentDashboardData(student_id);
    if (!data) return res.status(404).json({ error: "Student not found." });
    res.json(data);
  } catch (err) {
    console.error("Parent dashboard error:", err.message);
    serverError(res, err);
  }
};

// ── DOWNLOADABLE PROGRESS REPORT (PDF) ────────────────────
// GET /api/parent/report.pdf
// Generates a one-page performance summary for the parent to save/print/
// share — same data as the dashboard, just rendered server-side with
// pdfkit so it works with zero client-side dependencies.
exports.getProgressReportPDF = async (req, res) => {
  try {
    const student_id = req.parent.student_id;
    const data = await fetchStudentDashboardData(student_id);
    if (!data) return res.status(404).json({ error: "Student not found." });

    const PDFDocument = require("pdfkit");
    const { profile, stats, subjects, recent_exams, predicted_score } = data;

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${(profile.full_name || "student").replace(/[^a-z0-9]/gi, "_")}_progress_report.pdf"`);
    doc.pipe(res);

    const purple = "#7C5CFF", teal = "#00D4AA", dark = "#0A0F1E", gray = "#6B7280";

    // Header
    doc.rect(0, 0, doc.page.width, 80).fill(dark);
    doc.fillColor("#FFFFFF").fontSize(20).font("Helvetica-Bold").text("Scholars Syndicate", 40, 24);
    doc.fillColor(teal).fontSize(11).font("Helvetica").text("Student Progress Report", 40, 50);
    doc.fillColor(gray).fontSize(9).text(new Date().toLocaleDateString("en-NG", { year: "numeric", month: "long", day: "numeric" }), doc.page.width - 160, 50, { width: 120, align: "right" });

    doc.moveDown(3);
    doc.y = 100;

    // Student name / summary block
    doc.fillColor(dark).fontSize(16).font("Helvetica-Bold").text(profile.full_name || "Student", 40, doc.y);
    doc.fillColor(gray).fontSize(10).font("Helvetica").text(
      `${profile.school_class || "Class not set"}${profile.target_university ? " · Targeting " + profile.target_university : ""}`,
      40, doc.y + 4
    );

    doc.moveDown(1.5);

    // Stat cards
    const statY = doc.y + 6;
    const cardW = (doc.page.width - 80 - 30) / 4;
    const cards = [
      ["Exams Taken", stats.total_exams],
      ["Average Score", `${stats.overall_avg}%`],
      ["Best Score", `${stats.best_score}%`],
      ["Study Hours", `${stats.total_study_hours}h`],
    ];
    cards.forEach(([label, value], i) => {
      const x = 40 + i * (cardW + 10);
      doc.roundedRect(x, statY, cardW, 56, 6).fillAndStroke("#F4F2FF", "#E5E0FF");
      doc.fillColor(purple).fontSize(16).font("Helvetica-Bold").text(String(value), x, statY + 10, { width: cardW, align: "center" });
      doc.fillColor(gray).fontSize(8).font("Helvetica").text(label, x, statY + 32, { width: cardW, align: "center" });
    });
    doc.y = statY + 70;

    // Predicted JAMB score
    if (predicted_score) {
      doc.moveDown(1);
      doc.fillColor(dark).fontSize(12).font("Helvetica-Bold").text("Predicted JAMB Score");
      doc.fillColor(teal).fontSize(20).font("Helvetica-Bold").text(`${predicted_score.low} – ${predicted_score.high}`, { continued: false });
      doc.fillColor(gray).fontSize(8).font("Helvetica").text("Based on the last 5 JAMB-type practice exams. Not an official score.");
    }

    // Subject breakdown table
    doc.moveDown(1.5);
    doc.fillColor(dark).fontSize(12).font("Helvetica-Bold").text("Performance by Subject");
    doc.moveDown(0.3);
    const tblX = 40, tblW = doc.page.width - 80;
    const colW = [tblW * 0.34, tblW * 0.16, tblW * 0.16, tblW * 0.16, tblW * 0.18];
    let ty = doc.y + 4;
    doc.fontSize(8.5).font("Helvetica-Bold").fillColor(gray);
    ["Subject", "Exams", "Avg", "Best", "Correct"].forEach((h, i) => {
      const x = tblX + colW.slice(0, i).reduce((a, b) => a + b, 0);
      doc.text(h, x, ty, { width: colW[i] });
    });
    ty += 16;
    doc.moveTo(tblX, ty).lineTo(tblX + tblW, ty).strokeColor("#E5E7EB").stroke();
    ty += 6;

    doc.font("Helvetica").fillColor(dark);
    (subjects || []).slice(0, 12).forEach(s => {
      if (ty > doc.page.height - 100) { doc.addPage(); ty = 40; }
      const row = [
        s.subject,
        String(s.total_exams),
        `${s.avg_score}%`,
        `${s.best_score}%`,
        `${s.total_correct}/${s.total_questions}`,
      ];
      row.forEach((val, i) => {
        const x = tblX + colW.slice(0, i).reduce((a, b) => a + b, 0);
        doc.fontSize(9).text(val, x, ty, { width: colW[i] });
      });
      ty += 18;
    });

    // Recent exams
    doc.y = ty + 20;
    if (doc.y > doc.page.height - 150) { doc.addPage(); doc.y = 40; }
    doc.fillColor(dark).fontSize(12).font("Helvetica-Bold").text("Recent Exams", 40, doc.y);
    doc.moveDown(0.3);
    (recent_exams || []).slice(0, 8).forEach(e => {
      doc.fontSize(9).font("Helvetica").fillColor(gray).text(
        `${new Date(e.created_at).toLocaleDateString()}  ·  ${e.subject} (${e.exam_type})  ·  ${e.score}/${e.total_questions} (${e.percentage}%)`,
        40, doc.y
      );
      doc.moveDown(0.4);
    });

    // Footer
    doc.fontSize(7.5).fillColor(gray).text(
      "Generated automatically by Scholars Syndicate. This report reflects practice exam performance only.",
      40, doc.page.height - 40, { width: doc.page.width - 80, align: "center" }
    );

    doc.end();
  } catch (err) {
    console.error("Progress report PDF error:", err.message);
    serverError(res, err);
  }
};
