const db   = require("../config/db");
const crypto = require("crypto");
const { serverError } = require('../utils/errors');

// ── HELPERS ───────────────────────────────────────────────
function genKey() {
  const seg = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `${seg()}${seg()}-${seg()}${seg()}-${seg()}${seg()}-${seg()}${seg()}`;
}

const PLAN_DAYS = {
  hourly:   1,      // 3 hours treated as 1 day minimum in DB
  daily:    1,
  weekly:   7,
  monthly:  30,
  yearly:   365,
  lifetime: 36500,
};

// Hours for sub-day plans
const PLAN_HOURS = {
  hourly: 3,
  daily:  24,
};

// ── DASHBOARD STATS ───────────────────────────────────────
exports.getDashboardStats = async (req, res) => {
  try {
    const [
      studentStats,
      examStats,
      keyStats,
      suspicious,
      growth,
      topSubjects,
      recentActivity,
      bannedCount,
      arenaStats,
    ] = await Promise.all([

      // Student counts
      db.query(`
        SELECT
          COUNT(*)                                          AS total,
          COUNT(*) FILTER (WHERE is_premium = true)        AS premium,
          COUNT(*) FILTER (WHERE is_banned  = true)        AS banned,
          COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) AS new_today,
          ROUND(
            (COUNT(*) FILTER (WHERE is_premium = true)::numeric / NULLIF(COUNT(*),0)) * 100, 1
          ) AS premium_pct
        FROM students
      `),

      // Exam stats
      db.query(`
        SELECT
          COUNT(*)                                                             AS total,
          COUNT(*) FILTER (WHERE DATE(completed_at) = CURRENT_DATE)           AS today,
          ROUND(AVG(percentage), 1)                                            AS avg_score,
          ROUND(AVG(time_taken_seconds) / 60.0, 1)                            AS avg_duration_mins,
          COUNT(*) FILTER (WHERE percentage >= 70)                             AS excellent_count,
          COUNT(*) FILTER (WHERE DATE(completed_at) >= CURRENT_DATE - 7)      AS last_7_days
        FROM exam_sessions
      `),

      // Key stats
      db.query(`
        SELECT
          COUNT(*)                                            AS total,
          COUNT(*) FILTER (WHERE is_active = true AND used_by_student_id IS NULL) AS available,
          COUNT(*) FILTER (WHERE used_by_student_id IS NOT NULL) AS used,
          COUNT(*) FILTER (WHERE plan = 'monthly' AND used_by_student_id IS NOT NULL) AS monthly_sold,
          COUNT(*) FILTER (WHERE plan = 'weekly'  AND used_by_student_id IS NOT NULL) AS weekly_sold,
          COUNT(*) FILTER (WHERE plan = 'lifetime' AND used_by_student_id IS NOT NULL) AS lifetime_sold
        FROM activation_keys
      `),

      // Suspicious keys (used from 3+ IPs)
      db.query(`
        SELECT COUNT(*) AS count
        FROM (
          SELECT key_code, COUNT(DISTINCT ip_address) AS unique_ips
          FROM key_usage_log
          WHERE success = true
          GROUP BY key_code
          HAVING COUNT(DISTINCT ip_address) >= 3
        ) sub
      `),

      // 14-day growth
      db.query(`
        SELECT
          TO_CHAR(d, 'DD/MM') AS date,
          COUNT(s.id) AS new_students
        FROM generate_series(
          CURRENT_DATE - 13, CURRENT_DATE, '1 day'::interval
        ) d
        LEFT JOIN students s ON DATE(s.created_at) = d
        GROUP BY d ORDER BY d
      `),

      // Top subjects
      db.query(`
        SELECT
          subject,
          COUNT(*) AS total_exams,
          ROUND(AVG(percentage), 1) AS avg_score
        FROM exam_sessions
        WHERE subject IS NOT NULL AND subject != ''
        GROUP BY subject
        ORDER BY total_exams DESC
        LIMIT 8
      `),

      // Recent activity (last 20 exams)
      db.query(`
        SELECT
          es.id, es.student_id, s.full_name,
          es.subject, es.exam_type, es.mode,
          es.score, es.total_questions,
          es.percentage, es.completed_at
        FROM exam_sessions es
        JOIN students s ON s.id = es.student_id
        ORDER BY es.completed_at DESC
        LIMIT 20
      `),

      // Banned count
      db.query("SELECT COUNT(*) AS count FROM students WHERE is_banned = true"),

      // Arena quick stats
      db.query(`
        SELECT COUNT(*) AS total_matches FROM arena_matches WHERE status = 'finished'
      `).catch(() => ({ rows: [{ total_matches: 0 }] })),
    ]);

    res.json({
      students: {
        total:       parseInt(studentStats.rows[0].total),
        premium:     parseInt(studentStats.rows[0].premium),
        banned:      parseInt(studentStats.rows[0].banned),
        new_today:   parseInt(studentStats.rows[0].new_today),
        premium_pct: parseFloat(studentStats.rows[0].premium_pct || 0),
      },
      exams: {
        total:            parseInt(examStats.rows[0].total),
        today:            parseInt(examStats.rows[0].today),
        avg_score:        parseFloat(examStats.rows[0].avg_score || 0),
        avg_duration_mins:parseFloat(examStats.rows[0].avg_duration_mins || 0),
        excellent_count:  parseInt(examStats.rows[0].excellent_count),
        last_7_days:      parseInt(examStats.rows[0].last_7_days),
      },
      keys: {
        total:        parseInt(keyStats.rows[0].total),
        available:    parseInt(keyStats.rows[0].available),
        used:         parseInt(keyStats.rows[0].used),
        monthly_sold: parseInt(keyStats.rows[0].monthly_sold),
        weekly_sold:  parseInt(keyStats.rows[0].weekly_sold),
        lifetime_sold:parseInt(keyStats.rows[0].lifetime_sold),
      },
      suspicious_keys:   parseInt(suspicious.rows[0].count),
      banned_students:   parseInt(bannedCount.rows[0].count),
      arena_total_matches: parseInt(arenaStats.rows[0]?.total_matches || 0),
      growth:            growth.rows,
      top_subjects:      topSubjects.rows,
      recent_activity:   recentActivity.rows,
    });
  } catch (err) {
    console.error("getDashboardStats:", err.message);
    serverError(res, err);
  }
};

// ── ANALYTICS ─────────────────────────────────────────────
exports.getUserAnalytics = async (req, res) => {
  try {
    const [
      retention,
      scoreDist,
      hourly,
      examModes,
      subjectAccuracy,
      examTypeBreakdown,
    ] = await Promise.all([

      // Retention
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE exam_count >= 2)  AS returned_students,
          COUNT(*) FILTER (WHERE exam_count >= 5)  AS active_students,
          COUNT(*) FILTER (WHERE exam_count >= 20) AS power_students,
          COUNT(*)                                  AS total_students
        FROM (
          SELECT student_id, COUNT(*) AS exam_count
          FROM exam_sessions GROUP BY student_id
        ) sub
      `),

      // Score distribution
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE percentage >= 80) AS excellent,
          COUNT(*) FILTER (WHERE percentage >= 60 AND percentage < 80) AS good,
          COUNT(*) FILTER (WHERE percentage >= 40 AND percentage < 60) AS average,
          COUNT(*) FILTER (WHERE percentage < 40) AS poor
        FROM exam_sessions
      `),

      // Hourly activity
      db.query(`
        SELECT
          EXTRACT(HOUR FROM completed_at)::int AS hour,
          COUNT(*) AS exams
        FROM exam_sessions
        WHERE completed_at >= NOW() - INTERVAL '30 days'
        GROUP BY hour ORDER BY hour
      `),

      // Exam modes
      db.query(`
        SELECT mode, COUNT(*) AS count
        FROM exam_sessions
        GROUP BY mode ORDER BY count DESC
      `),

      // Subject accuracy
      db.query(`
        SELECT
          subject,
          ROUND(AVG(accuracy), 1) AS avg_accuracy,
          SUM(total_attempted) AS total_attempted
        FROM student_performance
        WHERE subject IS NOT NULL
        GROUP BY subject
        ORDER BY avg_accuracy ASC
        LIMIT 10
      `),

      // Exam type breakdown
      db.query(`
        SELECT
          exam_type,
          COUNT(*) AS total_exams,
          ROUND(AVG(percentage), 1) AS avg_score
        FROM exam_sessions
        GROUP BY exam_type
      `),
    ]);

    res.json({
      retention:          retention.rows[0],
      score_distribution: scoreDist.rows[0],
      hourly_activity:    hourly.rows,
      exam_modes:         examModes.rows,
      subject_accuracy:   subjectAccuracy.rows,
      exam_type_breakdown: examTypeBreakdown.rows,
    });
  } catch (err) {
    console.error("getUserAnalytics:", err.message);
    serverError(res, err);
  }
};

// ── LIST STUDENTS ─────────────────────────────────────────
exports.listStudents = async (req, res) => {
  const { search = "", sort = "newest", premium, banned, page = 1 } = req.query;
  const limit  = 50;
  const offset = (parseInt(page) - 1) * limit;

  const conditions = ["1=1"];
  const params     = [];
  let   idx        = 1;

  if (search) {
    conditions.push(`(s.full_name ILIKE $${idx} OR s.email ILIKE $${idx} OR s.phone ILIKE $${idx})`);
    params.push(`%${search}%`); idx++;
  }
  if (premium !== undefined && premium !== "") {
    conditions.push(`s.is_premium = $${idx++}`);
    params.push(premium === "true");
  }
  if (banned !== undefined && banned !== "") {
    conditions.push(`s.is_banned = $${idx++}`);
    params.push(banned === "true");
  }

  const orderMap = {
    newest:      "s.created_at DESC",
    oldest:      "s.created_at ASC",
    most_active: "total_exams DESC NULLS LAST",
    best_score:  "avg_score DESC NULLS LAST",
  };
  const order = orderMap[sort] || "s.created_at DESC";

  params.push(limit, offset);

  try {
    const result = await db.query(`
      SELECT
        s.id, s.full_name, s.email, s.phone, s.avatar_url,
        s.is_premium, s.is_banned, s.premium_expires_at, s.created_at,
        s.referral_code, s.referral_count, s.referral_days,
        COUNT(es.id)                 AS total_exams,
        ROUND(AVG(es.percentage), 1) AS avg_score,
        MAX(es.completed_at)         AS last_active,
        st.current_streak
      FROM students s
      LEFT JOIN exam_sessions es ON es.student_id = s.id
      LEFT JOIN streaks st ON st.student_id = s.id
      WHERE ${conditions.join(" AND ")}
      GROUP BY s.id, st.current_streak
      ORDER BY ${order}
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    const countResult = await db.query(`
      SELECT COUNT(*) AS total
      FROM students s
      WHERE ${conditions.join(" AND ")}
    `, params.slice(0, -2));

    res.json({
      students: result.rows,
      total:    parseInt(countResult.rows[0].total),
      page:     parseInt(page),
    });
  } catch (err) {
    console.error("listStudents:", err.message);
    serverError(res, err);
  }
};

// ── GET STUDENT PROFILE ───────────────────────────────────
exports.getStudentProfile = async (req, res) => {
  const { student_id } = req.params;
  try {
    const [profile, performance, recentExams, wrongCount, arena, badges] = await Promise.all([

      db.query(`
        SELECT
          s.*,
          COUNT(es.id)                 AS total_exams,
          ROUND(AVG(es.percentage), 1) AS avg_score,
          MAX(es.percentage)           AS best_score,
          st.current_streak, st.longest_streak,
          s.referral_code, s.referral_count, s.referral_days
        FROM students s
        LEFT JOIN exam_sessions es ON es.student_id = s.id
        LEFT JOIN streaks st ON st.student_id = s.id
        WHERE s.id = $1
        GROUP BY s.id, st.current_streak, st.longest_streak
      `, [student_id]),

      db.query(`
        SELECT subject, total_attempted, total_correct, accuracy, last_updated
        FROM student_performance
        WHERE student_id = $1
        ORDER BY accuracy ASC
      `, [student_id]),

      db.query(`
        SELECT id, exam_type, institution, subject, mode,
               total_questions, score, percentage, time_taken_seconds, completed_at
        FROM exam_sessions
        WHERE student_id = $1
        ORDER BY completed_at DESC
        LIMIT 30
      `, [student_id]),

      db.query(
        "SELECT COUNT(*) AS count FROM wrong_answers WHERE student_id = $1",
        [student_id]
      ),

      db.query(
        "SELECT total_matches, wins, win_rate, xp, arena_rank FROM arena_stats WHERE student_id = $1",
        [student_id]
      ).catch(() => ({ rows: [] })),

      db.query(`
        SELECT COUNT(*) AS earned FROM student_badges WHERE student_id = $1
      `, [student_id]).catch(() => ({ rows: [{ earned: 0 }] })),
    ]);

    if (!profile.rows.length) return res.status(404).json({ error: "Student not found." });

    const { password_hash, ...safeProfile } = profile.rows[0];

    res.json({
      profile:      safeProfile,
      performance:  performance.rows,
      recent_exams: recentExams.rows,
      wrong_count:  parseInt(wrongCount.rows[0].count),
      arena:        arena.rows[0] || null,
      badges_count: parseInt(badges.rows[0]?.earned || 0),
    });
  } catch (err) {
    console.error("getStudentProfile:", err.message);
    serverError(res, err);
  }
};

// ── BAN / UNBAN ───────────────────────────────────────────
exports.banStudent = async (req, res) => {
  const { student_id } = req.params;
  const { reason }     = req.body;
  try {
    await db.query(
      "UPDATE students SET is_banned = true, ban_reason = $1 WHERE id = $2",
      [reason || "Banned by admin.", student_id]
    );
    res.json({ success: true, message: "Student banned." });
  } catch (err) {
    serverError(res, err);
  }
};

exports.unbanStudent = async (req, res) => {
  const { student_id } = req.params;
  try {
    await db.query(
      "UPDATE students SET is_banned = false, ban_reason = NULL WHERE id = $1",
      [student_id]
    );
    res.json({ success: true, message: "Student unbanned." });
  } catch (err) {
    serverError(res, err);
  }
};

// ── CREATE KEYS ───────────────────────────────────────────
exports.createKeys = async (req, res) => {
  const { plan = "monthly", quantity = 1 } = req.body;
  const qty = Math.min(parseInt(quantity) || 1, 100);

  if (!PLAN_DAYS[plan])
    return res.status(400).json({ error: "Invalid plan. Use weekly, monthly, or lifetime." });

  try {
    const keys = [];
    for (let i = 0; i < qty; i++) {
      const key_code    = genKey();
      const duration    = PLAN_DAYS[plan];
      const hours       = PLAN_HOURS[plan] || null;
      const result      = await db.query(
        `INSERT INTO activation_keys
           (key_code, plan, duration_days, duration_hours, created_by_admin_id, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING id, key_code, plan, duration_days, duration_hours, created_at`,
        [key_code, plan, duration, hours, req.admin.id]
      );
      keys.push(result.rows[0]);
    }
    res.json({ success: true, keys, count: keys.length });
  } catch (err) {
    console.error("createKeys:", err.message);
    serverError(res, err);
  }
};

// ── LIST KEYS ─────────────────────────────────────────────
exports.listKeys = async (req, res) => {
  const { page = 1, plan, used } = req.query;
  const limit  = 50;
  const offset = (parseInt(page) - 1) * limit;

  const conditions = ["1=1"];
  const params     = [];
  let   idx        = 1;

  if (plan) { conditions.push(`ak.plan = $${idx++}`); params.push(plan); }
  if (used === "true")  { conditions.push("ak.used_by_student_id IS NOT NULL"); }
  if (used === "false") { conditions.push("ak.used_by_student_id IS NULL"); }

  params.push(limit, offset);

  try {
    const result = await db.query(`
      SELECT
        ak.id, ak.key_code, ak.plan, ak.duration_days,
        ak.is_active, ak.used_at, ak.expires_at, ak.created_at,
        s.full_name AS used_by_name, s.email AS used_by_email,
        COALESCE(
          (SELECT COUNT(DISTINCT ip_address)
           FROM key_usage_log kl
           WHERE kl.key_code = ak.key_code AND kl.success = true), 0
        ) AS unique_ips
      FROM activation_keys ak
      LEFT JOIN students s ON s.id = ak.used_by_student_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY ak.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    const countResult = await db.query(`
      SELECT COUNT(*) AS total
      FROM activation_keys ak
      WHERE ${conditions.join(" AND ")}
    `, params.slice(0, -2));

    res.json({
      keys:  result.rows,
      total: parseInt(countResult.rows[0].total),
      page:  parseInt(page),
    });
  } catch (err) {
    console.error("listKeys:", err.message);
    serverError(res, err);
  }
};

// ── DEACTIVATE KEY ────────────────────────────────────────
exports.deactivateKey = async (req, res) => {
  const { key_code } = req.params;
  try {
    await db.query(
      "UPDATE activation_keys SET is_active = false WHERE key_code = $1",
      [key_code.toUpperCase()]
    );
    res.json({ success: true, message: "Key deactivated." });
  } catch (err) {
    serverError(res, err);
  }
};

// ── KEY USAGE DETAIL ──────────────────────────────────────
exports.keyUsageDetail = async (req, res) => {
  const { key_code } = req.params;
  try {
    const result = await db.query(`
      SELECT
        kl.student_id, s.full_name, s.email,
        kl.ip_address, kl.device_info,
        kl.attempted_at, kl.success
      FROM key_usage_log kl
      LEFT JOIN students s ON s.id = kl.student_id
      WHERE kl.key_code = $1
      ORDER BY kl.attempted_at DESC
      LIMIT 50
    `, [key_code.toUpperCase()]);

    res.json({
      key_code,
      attempts:   result.rows,
      unique_ips: new Set(result.rows.map(r => r.ip_address)).size,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── ARENA STATS ───────────────────────────────────────────
exports.getArenaStats = async (req, res) => {
  try {
    const [modeStats, recentMatches, topPlayers] = await Promise.all([
      db.query(`
        SELECT mode, COUNT(*) AS total_matches, AVG(
          (SELECT COUNT(*) FROM arena_results WHERE match_id = am.id)
        )::numeric(4,1) AS avg_players
        FROM arena_matches am WHERE status = 'finished'
        GROUP BY mode ORDER BY total_matches DESC
      `),
      db.query(`
        SELECT am.room_code, am.mode, am.battle_type, am.subject, am.ended_at,
               COUNT(ar.id) AS player_count,
               MAX(ar.score) AS top_score
        FROM arena_matches am
        JOIN arena_results ar ON ar.match_id = am.id
        WHERE am.status = 'finished'
        GROUP BY am.id
        ORDER BY am.ended_at DESC LIMIT 15
      `),
      db.query(`
        SELECT st.full_name, s.xp, s.wins, s.total_matches, s.win_rate, s.arena_rank
        FROM arena_stats s
        JOIN students st ON st.id = s.student_id
        WHERE st.is_banned = false AND s.total_matches > 0
        ORDER BY s.xp DESC LIMIT 10
      `),
    ]);
    res.json({
      mode_stats:     modeStats.rows,
      recent_matches: recentMatches.rows,
      top_players:    topPlayers.rows,
    });
  } catch (err) {
    serverError(res, err);
  }
};

// ── BROADCAST ─────────────────────────────────────────────
exports.broadcast = async (req, res) => {
  const { title, message, type = 'info' } = req.body;
  try {
    await db.query(
      `INSERT INTO notifications (title, message, type, created_by_admin_id) VALUES ($1, $2, $3, $4)`,
      [title, message, type, req.admin.id]
    );
    res.json({ success: true, message: "Broadcast sent." });
  } catch (err) {
    serverError(res, err);
  }
};

// ── QUESTIONS MANAGER ─────────────────────────────────────
exports.listQuestions = async (req, res) => {
  try {
    const { page=1, exam_type="JAMB", subject="", search="" } = req.query;
    const limit  = 50;
    const offset = (parseInt(page)-1) * limit;
    const conds  = ["exam_type=$1"];
    const params = [exam_type];
    let idx = 2;
    if (subject) { conds.push(`subject=$${idx++}`); params.push(subject); }
    if (search)  { conds.push(`(question ILIKE $${idx} OR topic ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    const where = conds.join(" AND ");
    const [rows, tot] = await Promise.all([
      db.query(`SELECT id,subject,topic,year,question,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty FROM questions WHERE ${where} ORDER BY id DESC LIMIT $${idx} OFFSET $${idx+1}`, [...params, limit, offset]),
      db.query(`SELECT COUNT(*) as cnt FROM questions WHERE ${where}`, params),
    ]);
    res.json({ questions: rows.rows, total: parseInt(tot.rows[0].cnt), page: parseInt(page) });
  } catch(err) { serverError(res, err); }
};

exports.addQuestion = async (req, res) => {
  try {
    const { exam_type, subject, topic, year, question, option_a, option_b, option_c, option_d, correct_answer, explanation, difficulty, institution } = req.body;
    if (!question || !option_a || !option_b || !option_c || !option_d || !correct_answer) {
      return res.status(400).json({ error: "All question fields required" });
    }
    const r = await db.query(
      `INSERT INTO questions (exam_type,subject,topic,year,question,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,institution)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [exam_type||"JAMB", subject, topic||null, year||null, question, option_a, option_b, option_c, option_d, correct_answer.toUpperCase(), explanation||null, difficulty||"medium", institution||null]
    );
    res.json({ success:true, id: r.rows[0].id });
  } catch(err) { serverError(res, err); }
};

exports.deleteQuestion = async (req, res) => {
  try {
    await db.query("DELETE FROM questions WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch(err) { serverError(res, err); }
};

// ── SPIN HISTORY ──────────────────────────────────────────
exports.getSpinHistory = async (req, res) => {
  try {
    const [history, stats] = await Promise.all([
      db.query(
        `SELECT sh.*, s.full_name FROM spin_history sh
         LEFT JOIN students s ON s.id = sh.student_id
         ORDER BY sh.spun_at DESC LIMIT 100`
      ),
      db.query(
        `SELECT COUNT(*) as total_spins,
                SUM(CASE WHEN reward_type='coins' THEN reward_value::int ELSE 0 END) as total_coins,
                SUM(CASE WHEN reward_type='gems'  THEN reward_value::int ELSE 0 END) as total_gems,
                SUM(CASE WHEN reward_type='xp'    THEN reward_value::int ELSE 0 END) as total_xp
         FROM spin_history`
      ),
    ]);
    res.json({ history: history.rows, stats: stats.rows[0] });
  } catch(err) { serverError(res, err); }
};

// ── CURRENCY MANAGER ──────────────────────────────────────
exports.manageCurrency = async (req, res) => {
  try {
    const { studentId, action, amount } = req.body;
    const amt = parseInt(amount);
    if (!studentId || isNaN(amt) || amt < 0) return res.status(400).json({ error: "Invalid input" });

    // Find student by ID or email
    const find = await db.query(
      `SELECT id FROM students WHERE id=$1 OR email=$2`,
      [parseInt(studentId)||0, studentId]
    );
    if (!find.rows.length) return res.status(404).json({ error: "Student not found" });
    const sid = find.rows[0].id;

    let sql = "";
    // FIX: "Tokens" in the admin panel and everywhere else in the app (Tokens.js,
    // AI Tutor, vault downloads, predicted score, PremiumGate) means `token_balance`.
    // This previously wrote to the legacy `gems` column instead, which is a totally
    // separate currency (GemStore) the student never sees as "tokens" — so admin
    // token credits silently never showed up for the student. Fixed to match.
    if      (action === "add")        sql = `UPDATE students SET token_balance=COALESCE(token_balance,0)+$1 WHERE id=$2`;
    else if (action === "remove")     sql = `UPDATE students SET token_balance=GREATEST(0,COALESCE(token_balance,0)-$1) WHERE id=$2`;
    else if (action === "set")        sql = `UPDATE students SET token_balance=$1 WHERE id=$2`;
    else if (action === "add_coins")  sql = `UPDATE students SET coins=COALESCE(coins,0)+$1 WHERE id=$2`;
    else if (action === "add_xp")     sql = `UPDATE students SET points=COALESCE(points,0)+$1 WHERE id=$2`;
    else if (action === "add_gems")   sql = `UPDATE students SET gems=COALESCE(gems,0)+$1 WHERE id=$2`;
    else return res.status(400).json({ error: "Invalid action" });

    await db.query(sql, [amt, sid]);

    const updated = await db.query(
      `SELECT coins, gems, points, token_balance FROM students WHERE id=$1`, [sid]
    );
    res.json({ success:true, student: updated.rows[0] });
  } catch(err) { serverError(res, err); }
};

// ── DUPLICATE ACCOUNT DETECTION ────────────────────────────
// GET /api/admin/duplicate-accounts
// Groups students that share the same phone, email, or (full_name +
// school_name) combo — the three signals most likely to indicate one real
// person with multiple accounts (common with token-farming / referral abuse).
// Read-only: flags groups for an admin to review, doesn't touch any data.
exports.getDuplicateAccounts = async (req, res) => {
  try {
    const [byPhone, byEmail, byNameSchool] = await Promise.all([
      db.query(
        `SELECT phone AS match_key, 'phone' AS match_type,
                array_agg(id ORDER BY created_at) AS student_ids,
                array_agg(full_name ORDER BY created_at) AS names,
                array_agg(created_at ORDER BY created_at) AS created_dates,
                COUNT(*) AS count
         FROM students
         WHERE phone IS NOT NULL AND phone != ''
         GROUP BY phone
         HAVING COUNT(*) > 1`
      ),
      db.query(
        `SELECT email AS match_key, 'email' AS match_type,
                array_agg(id ORDER BY created_at) AS student_ids,
                array_agg(full_name ORDER BY created_at) AS names,
                array_agg(created_at ORDER BY created_at) AS created_dates,
                COUNT(*) AS count
         FROM students
         WHERE email IS NOT NULL AND email != ''
         GROUP BY LOWER(email)
         HAVING COUNT(*) > 1`
      ),
      db.query(
        `SELECT LOWER(full_name) || ' @ ' || COALESCE(school_name,'') AS match_key,
                'name_school' AS match_type,
                array_agg(id ORDER BY created_at) AS student_ids,
                array_agg(full_name ORDER BY created_at) AS names,
                array_agg(created_at ORDER BY created_at) AS created_dates,
                COUNT(*) AS count
         FROM students
         WHERE full_name IS NOT NULL AND school_name IS NOT NULL
         GROUP BY LOWER(full_name), school_name
         HAVING COUNT(*) > 1`
      ),
    ]);

    const groups = [...byPhone.rows, ...byEmail.rows, ...byNameSchool.rows];

    // Enrich each group with token_balance / activity so the admin can see
    // at a glance which account in the cluster looks like the "real" one
    // (oldest + most active) vs. throwaway alts.
    const enriched = await Promise.all(
      groups.map(async (g) => {
        const ids = g.student_ids;
        const detail = await db.query(
          `SELECT id, full_name, email, phone, token_balance, is_banned,
                  created_at, last_seen,
                  (SELECT COUNT(*) FROM exam_sessions WHERE student_id = students.id) AS exams_taken
           FROM students WHERE id = ANY($1) ORDER BY created_at ASC`,
          [ids]
        );
        return { match_type: g.match_type, match_key: g.match_key, count: parseInt(g.count), accounts: detail.rows };
      })
    );

    res.json({ groups: enriched, total_groups: enriched.length });
  } catch (err) {
    serverError(res, err);
  }
};

// POST /api/admin/duplicate-accounts/merge-ban
// Bans all listed duplicate account IDs except `keep_id`. Doesn't delete
// anything (keeps audit trail) — just sets is_banned + a ban_reason so the
// duplicates can't log in or farm rewards, while the chosen primary account
// stays active. Admin picks which one to keep after reviewing the group.
exports.resolveDuplicateGroup = async (req, res) => {
  try {
    const { keep_id, duplicate_ids } = req.body;
    if (!keep_id || !Array.isArray(duplicate_ids) || duplicate_ids.length === 0) {
      return res.status(400).json({ error: "keep_id and duplicate_ids[] are required." });
    }
    const toBan = duplicate_ids.filter(id => String(id) !== String(keep_id));
    if (toBan.length === 0) return res.json({ success: true, banned: [] });

    await db.query(
      `UPDATE students SET is_banned = true,
              ban_reason = 'Duplicate account — merged into #' || $2
       WHERE id = ANY($1)`,
      [toBan, keep_id]
    );

    res.json({ success: true, banned: toBan, kept: keep_id });
  } catch (err) {
    serverError(res, err);
  }
};