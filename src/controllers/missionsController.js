const db = require("../config/db");

// ── Level calculation ──────────────────────────────────────
const LEVELS = [
  { level:1,  xp:0,      title:"Beginner",      icon:"🌱" },
  { level:5,  xp:500,    title:"Scholar",        icon:"📚" },
  { level:10, xp:1500,   title:"Rising Star",    icon:"⭐" },
  { level:15, xp:3000,   title:"Challenger",     icon:"⚔️" },
  { level:20, xp:5000,   title:"Arena Knight",   icon:"🛡️" },
  { level:25, xp:8000,   title:"Elite Scholar",  icon:"🎓" },
  { level:30, xp:12000,  title:"Master",         icon:"👑" },
  { level:40, xp:20000,  title:"Grand Master",   icon:"💎" },
  { level:50, xp:30000,  title:"Exam Titan",     icon:"🏆" },
  { level:75, xp:60000,  title:"Champion",       icon:"🌟" },
  { level:100,xp:100000, title:"Legend",         icon:"🔱" },
];

function getLevelInfo(totalXp) {
  const xp = totalXp || 0;
  // Find current level
  let current = LEVELS[0];
  let next    = LEVELS[1];
  for (let i = 0; i < LEVELS.length; i++) {
    if (xp >= LEVELS[i].xp) {
      current = LEVELS[i];
      next    = LEVELS[i + 1] || null;
    }
  }
  // Calculate level number between milestones
  const levelNum = current.level + (next
    ? Math.floor(((xp - current.xp) / (next.xp - current.xp)) * (next.level - current.level))
    : 0);
  const pct = next
    ? Math.min(((xp - current.xp) / (next.xp - current.xp)) * 100, 100)
    : 100;
  return {
    level:      levelNum,
    title:      current.title,
    icon:       current.icon,
    xp,
    nextXp:     next?.xp || null,
    nextTitle:  next?.title || "MAX",
    pct:        Math.round(pct),
    xpToNext:   next ? next.xp - xp : 0,
  };
}

// ── GET today's missions for student ──────────────────────
exports.getDailyMissions = async (req, res) => {
  try {
    const student_id = req.student.id;
    const today      = new Date().toISOString().split("T")[0];

    // Get all active daily missions
    const missions = await db.query(
      `SELECT * FROM missions WHERE type = 'daily' AND is_active = true ORDER BY category, xp_reward`
    );

    // Get student's progress for today
    const progress = await db.query(
      `SELECT * FROM student_missions WHERE student_id=$1 AND date=$2`,
      [student_id, today]
    );

    const progressMap = {};
    progress.rows.forEach(p => { progressMap[p.mission_code] = p; });

    // Auto-create daily_login mission progress (just by hitting this endpoint)
    const loginMission = missions.rows.find(m => m.code === "daily_login");
    if (loginMission && !progressMap["daily_login"]) {
      await db.query(
        `INSERT INTO student_missions (student_id, mission_code, date, progress, completed)
         VALUES ($1, 'daily_login', $2, 1, true)
         ON CONFLICT (student_id, mission_code, date) DO NOTHING`,
        [student_id, today]
      );
      progressMap["daily_login"] = { progress: 1, completed: true, claimed: false };
    }

    const result = missions.rows.map(m => ({
      ...m,
      progress:  progressMap[m.code]?.progress  || 0,
      completed: progressMap[m.code]?.completed  || false,
      claimed:   progressMap[m.code]?.claimed    || false,
    }));

    // Get weekly missions too
    const weekly = await db.query(
      `SELECT m.*, sm.progress, sm.completed, sm.claimed
       FROM missions m
       LEFT JOIN student_missions sm ON sm.mission_code = m.code
         AND sm.student_id = $1
         AND sm.date >= date_trunc('week', CURRENT_DATE)::date
       WHERE m.type = 'weekly' AND m.is_active = true
       ORDER BY m.xp_reward`,
      [student_id]
    );

    // Get student level info
    const stu = await db.query(
      `SELECT COALESCE(points,0) as points, COALESCE(coins,0) as coins FROM students WHERE id=$1`,
      [student_id]
    );
    const levelInfo = getLevelInfo(stu.rows[0]?.points || 0);

    res.json({
      daily:   result,
      weekly:  weekly.rows,
      level:   levelInfo,
      coins:   stu.rows[0]?.coins || 0,
    });
  } catch (err) {
    console.error("getDailyMissions error:", err);
    res.status(500).json({ error: "Failed to load missions" });
  }
};

// ── CLAIM mission reward ──────────────────────────────────
exports.claimMission = async (req, res) => {
  try {
    const student_id  = req.student.id;
    const { mission_code } = req.body;
    const today = new Date().toISOString().split("T")[0];

    // Get mission type first
    const missionType = await db.query(`SELECT type FROM missions WHERE code=$1`, [mission_code]);
    const isWeekly = missionType.rows[0]?.type === "weekly";

    // Daily: match today. Weekly: match any record in current week
    const sm = await db.query(
      `SELECT sm.*, m.xp_reward, m.coins_reward, m.title, m.type
       FROM student_missions sm
       JOIN missions m ON m.code = sm.mission_code
       WHERE sm.student_id=$1 AND sm.mission_code=$2
         AND (
           (m.type = 'daily'  AND sm.date = $3) OR
           (m.type = 'weekly' AND sm.date >= date_trunc('week', CURRENT_DATE)::date)
         )
       ORDER BY sm.date DESC LIMIT 1`,
      [student_id, mission_code, today]
    );

    if (!sm.rows[0])          return res.status(404).json({ error: "Mission not found" });
    if (!sm.rows[0].completed) return res.status(400).json({ error: "Mission not completed yet" });
    if (sm.rows[0].claimed)    return res.status(400).json({ error: "Already claimed" });

    const { xp_reward, coins_reward, title } = sm.rows[0];

    // Mark as claimed — use correct date for weekly vs daily
    const claimDate = sm.rows[0].type === "weekly"
      ? sm.rows[0].date  // use the actual date stored in the row
      : today;
    await db.query(
      `UPDATE student_missions SET claimed=true WHERE student_id=$1 AND mission_code=$2 AND date=$3`,
      [student_id, mission_code, claimDate]
    );

    // Award XP + coins
    await db.query(
      `UPDATE students SET
         points = COALESCE(points,0) + $1,
         coins  = COALESCE(coins,0)  + $2
       WHERE id=$3`,
      [xp_reward, coins_reward, student_id]
    );

    // Get new level info
    const stu = await db.query(
      `SELECT COALESCE(points,0) as points, COALESCE(coins,0) as coins FROM students WHERE id=$1`,
      [student_id]
    );
    const levelInfo = getLevelInfo(stu.rows[0]?.points || 0);

    res.json({
      success:    true,
      xp_earned:  xp_reward,
      coins_earned: coins_reward,
      mission:    title,
      level:      levelInfo,
      coins:      stu.rows[0]?.coins || 0,
    });
  } catch (err) {
    console.error("claimMission error:", err);
    res.status(500).json({ error: "Failed to claim mission" });
  }
};

// ── UPDATE mission progress (called internally) ───────────
exports.updateMissionProgress = async (student_id, event) => {
  try {
    const today = new Date().toISOString().split("T")[0];

    // Map events to mission codes
    const eventMap = {
      exam_complete:       ["daily_exam", "weekly_exams"],
      challenge_done:      ["daily_challenge"],
      arena_played:        ["daily_arena", "weekly_arena"],
      arena_won:           ["daily_arena", "daily_arena_win", "weekly_arena"],
      score_70:            ["daily_score_70"],
      score_100:           ["weekly_perfect"],
      video_watched:       ["daily_video"],
      streak_kept:         ["daily_streak", "weekly_streak"],
      questions_answered:  ["daily_questions"],
      // ── Upgrade: new event types for new modes
      blitz_played:        ["daily_blitz", "weekly_blitz"],
      blitz_won:           ["daily_blitz_win"],
      survival_played:     ["daily_survival"],
      study_room_joined:   ["daily_study_room"],
      school_war_played:   ["weekly_school_war"],
      flashcard_done:      ["daily_flashcard"],
    };

    const codes = eventMap[event] || [];
    if (!codes.length) return;

    for (const code of codes) {
      const mission = await db.query(
        `SELECT * FROM missions WHERE code=$1 AND is_active=true`, [code]
      );
      if (!mission.rows[0]) continue;
      const m = mission.rows[0];

      // Weekly missions use start-of-week as date key for grouping
      const missionDate = m.type === "weekly"
        ? new Date(new Date().setDate(new Date().getDate() - new Date().getDay())).toISOString().split("T")[0]
        : today;

      await db.query(
        `INSERT INTO student_missions (student_id, mission_code, date, progress, completed)
         VALUES ($1, $2, $3, 1, CASE WHEN 1 >= $4 THEN true ELSE false END)
         ON CONFLICT (student_id, mission_code, date) DO UPDATE
           SET progress  = LEAST(student_missions.progress + 1, $4),
               completed = CASE WHEN student_missions.progress + 1 >= $4 THEN true ELSE student_missions.completed END,
               completed_at = CASE WHEN student_missions.progress + 1 >= $4 AND NOT student_missions.completed
                              THEN NOW() ELSE student_missions.completed_at END`,
        [student_id, code, missionDate, m.target]
      );
    }
  } catch (err) {
    console.error("updateMissionProgress error:", err);
  }
};

// ── GET level info for student ────────────────────────────
exports.getLevelInfo = async (req, res) => {
  try {
    const stu = await db.query(
      `SELECT COALESCE(points,0) as points, COALESCE(coins,0) as coins,
              COALESCE(level,1) as level
       FROM students WHERE id=$1`,
      [req.student.id]
    );
    res.json({
      ...getLevelInfo(stu.rows[0]?.points || 0),
      coins: stu.rows[0]?.coins || 0,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get level" });
  }
};

module.exports.getLevelInfo_fn = getLevelInfo;
