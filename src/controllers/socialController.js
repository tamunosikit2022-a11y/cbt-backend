/**
 * SOCIAL CONTROLLER — Friends + Squad System
 * ─────────────────────────────────────────────────────────
 * Friend requests, friend list, squads for Arena.
 *
 * Tables needed (see migrations/innovation_tables.sql):
 *   friend_requests  (id, from_id, to_id, status, created_at)
 *   friends          (id, student_a, student_b, created_at) — normalised pair
 *   squads           (id, name, captain_id, room_code, created_at)
 *   squad_members    (squad_id, student_id, joined_at)
 */

const db = require('../config/db');
const { serverError } = require('../utils/errors');

// ── SEARCH STUDENTS ───────────────────────────────────────
exports.searchStudents = async (req, res) => {
  try {
    const raw = (req.query.q || '').trim();
    if (raw.length < 2) return res.json({ students: [] });

    // "@username" prefix = exact/fast username lookup.
    // Otherwise search both full name and username.
    const isUsernameSearch = raw.startsWith('@');
    const q = isUsernameSearch ? raw.slice(1) : raw;
    if (q.length < 2) return res.json({ students: [] });

    const { rows } = await db.query(
      isUsernameSearch
        ? `SELECT id, full_name, username, avatar_url, school_name,
                  COALESCE(points,0) as xp
           FROM students
           WHERE is_banned=false
             AND id != $1
             AND username ILIKE $2
           ORDER BY (LOWER(username) = LOWER($3)) DESC, points DESC
           LIMIT 20`
        : `SELECT id, full_name, username, avatar_url, school_name,
                  COALESCE(points,0) as xp
           FROM students
           WHERE is_banned=false
             AND id != $1
             AND (full_name ILIKE $2 OR username ILIKE $2)
           ORDER BY (LOWER(username) = LOWER($3)) DESC, points DESC
           LIMIT 20`,
      [req.student.id, `%${q}%`, q]
    );
    res.json({ students: rows });
  } catch (err) {
    serverError(res, err);
  }
};

// ── FRIEND REQUESTS ───────────────────────────────────────

// POST /api/social/friends/request
exports.sendFriendRequest = async (req, res) => {
  try {
    const from   = req.student.id;
    const { toId } = req.body;
    if (!toId || toId === from) return res.status(400).json({ error: 'Invalid target.' });

    // Already friends?
    const areFriends = await db.query(
      `SELECT id FROM friends
       WHERE (student_a=$1 AND student_b=$2) OR (student_a=$2 AND student_b=$1)`,
      [from, toId]
    );
    if (areFriends.rows.length) return res.status(400).json({ error: 'Already friends.' });

    // Pending request already?
    const existing = await db.query(
      `SELECT id FROM friend_requests
       WHERE from_id=$1 AND to_id=$2 AND status='pending'`,
      [from, toId]
    );
    if (existing.rows.length) return res.status(400).json({ error: 'Request already sent.' });

    const result = await db.query(
      `INSERT INTO friend_requests (from_id, to_id, status)
       VALUES ($1,$2,'pending') RETURNING id`,
      [from, toId]
    );

    res.json({ success: true, requestId: result.rows[0].id });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/social/friends/respond
exports.respondToRequest = async (req, res) => {
  try {
    const me          = req.student.id;
    const { requestId, accept } = req.body;

    const req_ = await db.query(
      `SELECT * FROM friend_requests WHERE id=$1 AND to_id=$2 AND status='pending'`,
      [requestId, me]
    );
    if (!req_.rows.length) return res.status(404).json({ error: 'Request not found.' });

    const fr = req_.rows[0];

    if (accept) {
      await db.query(
        `UPDATE friend_requests SET status='accepted' WHERE id=$1`, [requestId]
      );
      // Insert normalised friendship (smaller id first)
      const [a, b] = [fr.from_id, me].sort();
      await db.query(
        `INSERT INTO friends (student_a, student_b)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [a, b]
      );
      res.json({ success: true, status: 'accepted' });
    } else {
      await db.query(
        `UPDATE friend_requests SET status='rejected' WHERE id=$1`, [requestId]
      );
      res.json({ success: true, status: 'rejected' });
    }
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/social/friends
exports.getFriends = async (req, res) => {
  try {
    const me = req.student.id;
    const { rows } = await db.query(
      `SELECT s.id, s.full_name, s.avatar_url, s.school_name,
              COALESCE(s.points,0) as xp,
              f.created_at as friends_since
       FROM friends f
       JOIN students s ON s.id = CASE WHEN f.student_a=$1 THEN f.student_b ELSE f.student_a END
       WHERE $1 IN (f.student_a, f.student_b)
         AND s.is_banned=false
       ORDER BY s.full_name`,
      [me]
    );
    res.json({ friends: rows });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/social/friends/pending
exports.getPendingRequests = async (req, res) => {
  try {
    const me = req.student.id;
    const { rows } = await db.query(
      `SELECT fr.id, fr.created_at,
              s.id as from_id, s.full_name, s.avatar_url, s.school_name
       FROM friend_requests fr
       JOIN students s ON s.id = fr.from_id
       WHERE fr.to_id=$1 AND fr.status='pending'
       ORDER BY fr.created_at DESC`,
      [me]
    );
    res.json({ requests: rows });
  } catch (err) {
    serverError(res, err);
  }
};

// DELETE /api/social/friends/:friendId
exports.removeFriend = async (req, res) => {
  try {
    const me       = req.student.id;
    const friendId = parseInt(req.params.friendId);
    const [a, b]   = [me, friendId].sort();
    await db.query(
      `DELETE FROM friends WHERE student_a=$1 AND student_b=$2`, [a, b]
    );
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
};

// ── SQUADS ────────────────────────────────────────────────

// POST /api/social/squads
exports.createSquad = async (req, res) => {
  try {
    const { name } = req.body;
    const me       = req.student.id;

    // Leave any existing squad first
    await db.query(
      `DELETE FROM squad_members WHERE student_id=$1`, [me]
    ).catch(() => {});

    const result = await db.query(
      `INSERT INTO squads (name, captain_id) VALUES ($1,$2) RETURNING id`,
      [name || `${req.student.full_name}'s Squad`, me]
    );
    const squadId = result.rows[0].id;

    await db.query(
      `INSERT INTO squad_members (squad_id, student_id) VALUES ($1,$2)`,
      [squadId, me]
    );

    res.json({ success: true, squadId });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/social/squads/:squadId/invite
exports.inviteToSquad = async (req, res) => {
  try {
    const me      = req.student.id;
    const squadId = parseInt(req.params.squadId);
    const { targetId } = req.body;

    // Verify captain
    const sq = await db.query(
      `SELECT * FROM squads WHERE id=$1 AND captain_id=$2`, [squadId, me]
    );
    if (!sq.rows.length) return res.status(403).json({ error: 'Not your squad.' });

    const memberCount = await db.query(
      `SELECT COUNT(*) as cnt FROM squad_members WHERE squad_id=$1`, [squadId]
    );
    if (parseInt(memberCount.rows[0].cnt) >= 5)
      return res.status(400).json({ error: 'Squad is full (max 5).' });

    // Are they friends?
    const [a, b] = [me, targetId].sort();
    const areFriends = await db.query(
      `SELECT id FROM friends WHERE student_a=$1 AND student_b=$2`, [a, b]
    );
    if (!areFriends.rows.length)
      return res.status(400).json({ error: 'Can only invite friends.' });

    // Issue squad invite via friend_requests table (reuse with type='squad')
    await db.query(
      `INSERT INTO squad_invites (squad_id, from_id, to_id, status)
       VALUES ($1,$2,$3,'pending')
       ON CONFLICT (squad_id, to_id) DO UPDATE SET status='pending', created_at=NOW()`,
      [squadId, me, targetId]
    );

    res.json({ success: true, message: 'Invite sent.' });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/social/squads/accept-invite
exports.acceptSquadInvite = async (req, res) => {
  try {
    const me       = req.student.id;
    const { inviteId } = req.body;

    const inv = await db.query(
      `SELECT * FROM squad_invites WHERE id=$1 AND to_id=$2 AND status='pending'`,
      [inviteId, me]
    );
    if (!inv.rows.length) return res.status(404).json({ error: 'Invite not found.' });

    const { squad_id } = inv.rows[0];

    // Leave current squad
    await db.query(`DELETE FROM squad_members WHERE student_id=$1`, [me]).catch(() => {});

    await db.query(
      `INSERT INTO squad_members (squad_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [squad_id, me]
    );
    await db.query(
      `UPDATE squad_invites SET status='accepted' WHERE id=$1`, [inviteId]
    );

    res.json({ success: true, squadId: squad_id });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/social/squads/mine
exports.getMySquad = async (req, res) => {
  try {
    const me = req.student.id;
    const sqRes = await db.query(
      `SELECT sq.id, sq.name, sq.captain_id, sq.room_code, sq.created_at,
              json_agg(json_build_object(
                'id', s.id, 'name', s.full_name, 'avatar', s.avatar_url,
                'xp', COALESCE(s.points,0), 'school', s.school_name
              )) as members
       FROM squad_members sm
       JOIN squads sq ON sq.id = sm.squad_id
       JOIN students s ON s.id = sm.student_id
       WHERE sq.id = (SELECT squad_id FROM squad_members WHERE student_id=$1 LIMIT 1)
       GROUP BY sq.id`,
      [me]
    ).catch(() => ({ rows: [] }));

    if (!sqRes.rows.length) return res.json({ squad: null });

    // Pending invites for this squad (if captain)
    const invites = await db.query(
      `SELECT si.id, s.full_name, s.avatar_url
       FROM squad_invites si
       JOIN students s ON s.id = si.to_id
       WHERE si.squad_id=$1 AND si.status='pending'`,
      [sqRes.rows[0].id]
    ).catch(() => ({ rows: [] }));

    res.json({ squad: sqRes.rows[0], pendingInvites: invites.rows });
  } catch (err) {
    serverError(res, err);
  }
};

// DELETE /api/social/squads/leave
exports.leaveSquad = async (req, res) => {
  try {
    const me = req.student.id;
    await db.query(`DELETE FROM squad_members WHERE student_id=$1`, [me]);
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
};

// GET /api/social/squads/invites
exports.getPendingSquadInvites = async (req, res) => {
  try {
    const me = req.student.id;
    const { rows } = await db.query(
      `SELECT si.id, si.created_at, sq.name as squad_name, sq.id as squad_id,
              s.full_name as from_name, s.avatar_url as from_avatar
       FROM squad_invites si
       JOIN squads sq ON sq.id = si.squad_id
       JOIN students s ON s.id = si.from_id
       WHERE si.to_id=$1 AND si.status='pending'`,
      [me]
    ).catch(() => ({ rows: [] }));
    res.json({ invites: rows });
  } catch (err) {
    serverError(res, err);
  }
};
