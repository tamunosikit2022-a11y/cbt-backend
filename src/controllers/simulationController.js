/**
 * simulationController.js — Scholars Syndicate Live IDE
 *
 * Save/load ONLY for the Live IDE feature (spec section 6: "a new
 * lightweight simulationRoutes.js/simulationController.js for save/load
 * only — no execution happens server-side"). Python code runs client-side
 * via Pyodide; nothing here ever executes student code.
 */
const db = require("../config/db");
const { serverError } = require("../utils/errors");

const VALID_KINDS = ["python", "arduino", "circuit"];
const MAX_CODE_LENGTH = 200000; // ~200KB — generous for a student script, cheap to store

function isValidKind(kind) {
  return VALID_KINDS.includes(kind);
}

// GET /api/simulation/projects?kind=python
exports.listProjects = async (req, res) => {
  const student_id = req.student.id;
  const kind = req.query.kind;
  try {
    const params = [student_id];
    let where = "student_id = $1";
    if (kind) {
      if (!isValidKind(kind)) return res.status(400).json({ error: "Invalid kind" });
      params.push(kind);
      where += ` AND kind = $${params.length}`;
    }
    const r = await db.query(
      `SELECT id, kind, title, board_type, created_at, updated_at
       FROM live_ide_projects
       WHERE ${where}
       ORDER BY updated_at DESC
       LIMIT 100`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    serverError(res, err, "Could not load your projects.");
  }
};

// GET /api/simulation/projects/:id
exports.getProject = async (req, res) => {
  const student_id = req.student.id;
  const { id } = req.params;
  try {
    const r = await db.query(
      `SELECT id, kind, title, code, board_type, created_at, updated_at
       FROM live_ide_projects
       WHERE id = $1 AND student_id = $2`,
      [id, student_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Project not found" });
    res.json(r.rows[0]);
  } catch (err) {
    serverError(res, err, "Could not load that project.");
  }
};

// POST /api/simulation/projects  { kind, title, code, board_type? }
exports.createProject = async (req, res) => {
  const student_id = req.student.id;
  const { kind = "python", title, code = "", board_type } = req.body;

  if (!isValidKind(kind)) return res.status(400).json({ error: "Invalid kind" });
  if (typeof code !== "string" || code.length > MAX_CODE_LENGTH) {
    return res.status(400).json({ error: "Code too large" });
  }
  const safeTitle = (title || "Untitled script").toString().slice(0, 120);

  try {
    const r = await db.query(
      `INSERT INTO live_ide_projects (student_id, kind, title, code, board_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, kind, title, code, board_type, created_at, updated_at`,
      [student_id, kind, safeTitle, code, board_type || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    serverError(res, err, "Could not save your project.");
  }
};

// PUT /api/simulation/projects/:id  { title?, code? }
exports.updateProject = async (req, res) => {
  const student_id = req.student.id;
  const { id } = req.params;
  const { title, code, board_type } = req.body;

  if (code !== undefined && (typeof code !== "string" || code.length > MAX_CODE_LENGTH)) {
    return res.status(400).json({ error: "Code too large" });
  }

  try {
    const r = await db.query(
      `UPDATE live_ide_projects
       SET title      = COALESCE($3, title),
           code       = COALESCE($4, code),
           board_type = COALESCE($5, board_type),
           updated_at = NOW()
       WHERE id = $1 AND student_id = $2
       RETURNING id, kind, title, code, board_type, created_at, updated_at`,
      [id, student_id, title ? title.toString().slice(0, 120) : null, code ?? null, board_type || null]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Project not found" });
    res.json(r.rows[0]);
  } catch (err) {
    serverError(res, err, "Could not update your project.");
  }
};

// DELETE /api/simulation/projects/:id
exports.deleteProject = async (req, res) => {
  const student_id = req.student.id;
  const { id } = req.params;
  try {
    const r = await db.query(
      `DELETE FROM live_ide_projects WHERE id = $1 AND student_id = $2 RETURNING id`,
      [id, student_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Project not found" });
    res.json({ success: true });
  } catch (err) {
    serverError(res, err, "Could not delete your project.");
  }
};
