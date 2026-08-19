/**
 * cutoffController.js — Scholars Syndicate
 * JAMB Cut-Off Mark Tracker.
 *
 * Design note: this table is intentionally sparse at launch — seeded only
 * with figures that were verifiable from multiple sources at time of
 * writing (JAMB's national minimums + a handful of institution general
 * minimums reported at the 2026 policy meeting). Course/department-level
 * cutoffs are NOT guessed here; add them via the admin endpoints below as
 * you confirm them from official sources. Getting this wrong could cost a
 * student a real application, so "we don't have that one yet" is always
 * the safer answer than an invented number.
 */
const db = require('../config/db');
const { serverError } = require('../utils/errors');

// ── PUBLIC: list / search cutoffs (students) ──────────────────────────
exports.listCutoffs = async (req, res) => {
  const { search, category, session } = req.query;
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(institution_name ILIKE $${params.length} OR course_name ILIKE $${params.length})`);
  }
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (session) {
    params.push(session);
    conditions.push(`academic_session = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT id, institution_name, category, course_name, cutoff_mark, score_type,
              academic_session, source_url, source_note, verified_at
       FROM cutoff_marks
       ${where}
       ORDER BY institution_name ASC, course_name NULLS FIRST
       LIMIT 200`,
      params
    );
    res.json({ cutoffs: result.rows });
  } catch (err) {
    serverError(res, err);
  }
};

// ── PUBLIC: distinct institutions (for search autocomplete) ──────────
exports.listInstitutions = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT DISTINCT institution_name, category FROM cutoff_marks ORDER BY institution_name ASC`
    );
    res.json({ institutions: result.rows });
  } catch (err) {
    serverError(res, err);
  }
};

// ── ADMIN: create a cutoff entry ──────────────────────────────────────
exports.createCutoff = async (req, res) => {
  const {
    institution_name, category, course_name, cutoff_mark, score_type,
    academic_session, source_url, source_note, verified_at,
  } = req.body;

  if (!institution_name || !category || cutoff_mark == null || !academic_session || !verified_at) {
    return res.status(400).json({
      error: 'institution_name, category, cutoff_mark, academic_session, and verified_at are required.',
    });
  }
  const validTypes = ['utme_raw400', 'aggregate400', 'aggregate100'];
  const type = score_type && validTypes.includes(score_type) ? score_type : 'utme_raw400';
  const max = type === 'aggregate100' ? 100 : 400;
  if (cutoff_mark < 0 || cutoff_mark > max) {
    return res.status(400).json({ error: `cutoff_mark must be between 0 and ${max} for score_type "${type}".` });
  }

  try {
    const result = await db.query(
      `INSERT INTO cutoff_marks
         (institution_name, category, course_name, cutoff_mark, score_type, academic_session,
          source_url, source_note, verified_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (institution_name, category, course_name, academic_session)
       DO UPDATE SET
         cutoff_mark = EXCLUDED.cutoff_mark,
         score_type  = EXCLUDED.score_type,
         source_url  = EXCLUDED.source_url,
         source_note = EXCLUDED.source_note,
         verified_at = EXCLUDED.verified_at,
         updated_at  = NOW()
       RETURNING *`,
      [institution_name, category, course_name || null, cutoff_mark, type, academic_session,
       source_url || null, source_note || null, verified_at, req.admin.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    serverError(res, err);
  }
};

// ── ADMIN: update a cutoff entry ──────────────────────────────────────
exports.updateCutoff = async (req, res) => {
  const { id } = req.params;
  const { cutoff_mark, score_type, source_url, source_note, verified_at } = req.body;

  const validTypes = ['utme_raw400', 'aggregate400', 'aggregate100'];
  const type = score_type && validTypes.includes(score_type) ? score_type : null;
  if (cutoff_mark != null) {
    const max = (type || 'utme_raw400') === 'aggregate100' ? 100 : 400;
    if (cutoff_mark < 0 || cutoff_mark > max) {
      return res.status(400).json({ error: `cutoff_mark must be between 0 and ${max}.` });
    }
  }

  try {
    const result = await db.query(
      `UPDATE cutoff_marks SET
         cutoff_mark = COALESCE($1, cutoff_mark),
         score_type  = COALESCE($2, score_type),
         source_url  = COALESCE($3, source_url),
         source_note = COALESCE($4, source_note),
         verified_at = COALESCE($5, verified_at),
         updated_at  = NOW()
       WHERE id = $6
       RETURNING *`,
      [cutoff_mark ?? null, type, source_url ?? null, source_note ?? null, verified_at ?? null, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Cutoff entry not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    serverError(res, err);
  }
};

// ── ADMIN: delete a cutoff entry ──────────────────────────────────────
exports.deleteCutoff = async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query('DELETE FROM cutoff_marks WHERE id = $1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Cutoff entry not found.' });
    res.json({ deleted: true });
  } catch (err) {
    serverError(res, err);
  }
};
