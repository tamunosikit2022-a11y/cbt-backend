const express      = require("express");
const cors         = require("cors");
const http         = require("http");
const { Server }   = require("socket.io");
const compression  = require("compression");
const helmet       = require("helmet");
const cookieParser = require("cookie-parser");
const jwt          = require("jsonwebtoken");
const cron         = require("node-cron");
require("dotenv").config();

if (!process.env.DATABASE_URL) throw new Error("❌ DATABASE_URL not set.");
if (!process.env.JWT_SECRET)   throw new Error("❌ JWT_SECRET not set.");
if (!process.env.GROQ_API_KEY)    console.warn("⚠️ GROQ_API_KEY not set.");

// ── PROCESS-LEVEL SAFETY NET ──────────────────────────────
// FIX (app instability / random full outages): as of Node 15+, an
// unhandled promise rejection ANYWHERE in the process — a missed .catch()
// in a socket.io handler, a stray `await` in a cron job, an edge case in
// arena/classroom logic — kills the entire Node process by default. With
// a codebase this size (sockets, arena, classroom, AI jobs all running
// concurrently), that means one bad edge case for one user disconnects
// EVERY connected user and forces a Render restart. That matches "the
// app is not very stable" far better than any single feature bug.
// This doesn't fix the underlying bug wherever it is — it stops that bug
// from taking the whole server down, and logs it loudly so it can
// actually be found instead of vanishing into a silent crash/restart.
process.on("unhandledRejection", (reason) => {
  console.error("🔴 UNHANDLED REJECTION (process kept alive):", reason?.stack || reason);
});
process.on("uncaughtException", (err) => {
  // A true uncaught *synchronous* exception can leave things in a bad
  // state, so we log with full detail and let the process exit — Render
  // restarts it automatically. The goal is making the real cause visible
  // in the logs instead of an opaque restart with no explanation.
  console.error("🔴 UNCAUGHT EXCEPTION (process restarting):", err?.stack || err);
  process.exit(1);
});

const app    = express();
const server = http.createServer(app);

// Render (and most PaaS hosts) sit their app behind a reverse proxy, so the
// real client IP arrives via X-Forwarded-For rather than the raw socket
// address. Without this, Express doesn't trust that header — which is the
// right default for security (anyone could otherwise spoof their IP by
// setting the header themselves) — but it also means express-rate-limit
// can't tell users apart by IP and logs a ValidationError on every request.
// `1` here means "trust exactly one hop" (Render's own proxy), which is
// accurate for this deployment and doesn't open the spoofing hole a bare
// `true` (trust every hop) would.
app.set("trust proxy", 1);

// ── ALLOWED ORIGINS ───────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
].filter(Boolean);

const originCheck = (origin, callback) => {
  if (!origin)                             return callback(null, true);
  if (origin.endsWith(".vercel.app"))      return callback(null, true);
  if (origin.endsWith(".onrender.com"))    return callback(null, true);
  if (allowedOrigins.includes(origin))     return callback(null, true);
  if (process.env.NODE_ENV !== "production") return callback(null, true);
  callback(new Error(`CORS blocked: ${origin}`));
};

// ── SOCKET.IO ─────────────────────────────────────────────
const io = new Server(server, {
  cors:           { origin: originCheck, methods: ["GET","POST"], credentials: true },
  transports:     ["websocket","polling"],
  pingTimeout:    30000,   // faster disconnect detection
  pingInterval:   20000,
  upgradeTimeout: 10000,
  allowEIO3:      true,
  maxHttpBufferSize: 1e6,  // 1MB max message size
  connectTimeout: 10000,
});

// FIX: there was no socket-level authentication anywhere in this
// codebase — every socket handler across every feature trusted whatever
// id (challengerId, playerId, student_id, etc.) the client happened to
// put in its payload, with zero verification that the connected socket
// actually belonged to that student. Concretely, in liveChallengeController.js
// this meant any connected client could impersonate any other student:
// force-accept a challenge on someone else's behalf, submit quiz answers
// as another player, or send challenges that appear to come from someone
// else — coins/wins/losses all follow the (unverified) id.
//
// The frontend already sends `auth: { token }` on this base-namespace
// connection (see App.js's main socket connect) — it was just never read
// server-side. This verifies it and exposes the real student id as
// socket.data.studentId for any handler on this namespace to trust
// instead of a client-supplied field.
//
// Deliberately non-blocking: does NOT reject the connection if no/invalid
// token is present, only if verification succeeds does it set
// socket.data.studentId. This is necessary because io.use() here applies
// to the SAME server instance /arena and /classroom sub-namespaces are
// created from, and those two don't send a token at all yet — a hard
// rejection here would break them outright. socket.data.studentId being
// unset is what individual handlers (e.g. liveChallengeController below)
// check to refuse an identity-sensitive action, rather than the
// connection itself being refused. /arena and /classroom still need their
// own equivalent fix (send a token from their frontend socket files too,
// then verify it) — not done here since that requires reviewing each of
// those frontend connection files and their full handler set first,
// which is a separate piece of work.
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.data.studentId = decoded.id;
    }
  } catch (err) {
    // Invalid/expired token — leave socket.data.studentId unset rather
    // than rejecting the connection (see comment above); handlers that
    // require verified identity will refuse the action themselves.
  }
  next();
});

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression({ threshold: 1024, level: 6 })); // only compress >1KB
app.use(cors({ origin: originCheck, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ── RATE LIMITING — applied globally then per-route ───────
const { generalLimiter, loginLimiter, otpLimiter, registerLimiter } = require("./middleware/rateLimit");
app.use("/api", generalLimiter);

// ── SMART CACHE-CONTROL ───────────────────────────────────
app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  const p = req.path;
  if      (p.includes("/exam/subjects"))        res.set("Cache-Control","public, max-age=900");
  else if (p.includes("/exam/institutions"))    res.set("Cache-Control","public, max-age=900");
  else if (p.includes("/exam/leaderboard"))     res.set("Cache-Control","public, max-age=60");
  else if (p.includes("/innovations/challenge"))res.set("Cache-Control","private, max-age=120");
  else if (p.includes("/auth/notifications"))   res.set("Cache-Control","private, max-age=30");
  else if (p.includes("/innovations/badges"))   res.set("Cache-Control","public, max-age=600");
  else if (p.includes("/tokens/bundles"))       res.set("Cache-Control","public, max-age=3600");
  else if (p.includes("/school-finder"))        res.set("Cache-Control","public, max-age=3600");
  else if (p.includes("/missions"))             res.set("Cache-Control","private, max-age=60");
  else if (p.includes("/vault"))                res.set("Cache-Control","private, max-age=120");
  next();
});

// ── HEALTH CHECK ──────────────────────────────────────────
app.get("/health",     (_req, res) => res.status(200).send("ok"));
app.get("/api/health", (_req, res) => res.json({ status:"ok", uptime: process.uptime() }));

// ── AUTH ROUTES (with specific limiters) ──────────────────
const authRouter = require("./routes/authRoutes");
app.use("/api/auth/login",       loginLimiter);
app.use("/api/auth/register",    registerLimiter);
app.use("/api/auth/forgot",      otpLimiter);
app.use("/api/auth/verify-otp",  otpLimiter);
app.use("/api/auth", authRouter);

// ── AI TUTOR ROUTES (with per-user limiter) ───────────────
const { aiTutorLimiter } = require("./middleware/rateLimit");
app.use("/api/ai-tutor", aiTutorLimiter, require("./routes/aiTutorRoutes"));

// ── EXAM ROUTES (submit gets its own limiter) ─────────────
const { examSubmitLimiter } = require("./middleware/rateLimit");
const examRouter = require("./routes/examRoutes");
// Apply submit limiter only to POST /submit
app.use("/api/exam", (req, res, next) => {
  if (req.method === "POST" && req.path === "/submit") {
    return examSubmitLimiter(req, res, next);
  }
  next();
}, examRouter);

// ── ALL OTHER ROUTES ──────────────────────────────────────
app.use("/api/admin",       require("./routes/adminRoutes"));
app.use("/api/arena",       require("./routes/arenaRoutes"));
// innovationRoutes mounted below at /api — do not mount at /api/innovations
app.use("/api/missions",    require("./routes/missionsRoutes"));
app.use("/api/spin",        require("./routes/spinRoutes"));
app.use("/api/phase2",      require("./routes/phase2Routes"));
app.use("/api/classroom",   require("./routes/classroomRoutes"));
app.use("/api/referral",    require("./routes/referral"));
app.use("/api/tokens",      require("./routes/tokenRoutes"));
app.use("/api/push",        require("./routes/pushRoutes"));
app.use("/api/gems",        require("./routes/gemRoutes"));
app.use("/api/spirits",     require("./routes/spiritsRoutes"));
app.use("/api/skills",      require("./routes/skillsRoutes"));
app.use("/api/vault",       require("./routes/vaultRoutes"));
app.use("/api/factions",    require("./routes/factionRoutes"));
app.use("/api/vouchers",    require("./routes/voucherRoutes"));
app.use("/api/cutoffs",     require("./routes/cutoffRoutes"));
app.use("/api/parent",      require("./routes/parentRoutes"));
// FIX: careerRoutes existed (with a working careerController) but was never
// mounted — CareerQuiz.js posted to /career/suggest and got 404 every time.
app.use("/api/career",      require("./routes/careerRoutes"));
// FIX: squadChatRoutes existed (with a working squadChatController) but was
// never mounted — the Squad Chat widget called /squads/chat and got 404.
app.use("/api/squads/chat", require("./routes/squadChatRoutes"));
// NEW: Community Chat — one global room every student can post in
// (moderated by src/utils/profanityFilter.js). See migrations/community_chat.sql.
app.use("/api/community-chat", require("./routes/communityChatRoutes"));
// FIX: studyNotesController existed with a ready route file that was never
// mounted — wiring it in so the AI study-notes feature is reachable.
app.use("/api/study-notes", require("./routes/studyNotesRoutes"));
// NEW: Live IDE (Scholar Session) — save/load ONLY for Python scripts and,
// later, circuit layouts. All code execution is client-side (Pyodide /
// in-browser microcontroller emulator), so this stays cheap on Render's
// free tier. See migrations/live_ide_projects.sql.
app.use("/api/simulation", require("./routes/simulationRoutes"));
// FIX: liveChallengeController existed with zero route file mounting it —
// Social.js calls GET /live-challenges/history and got 404 every time.
app.use("/api/live-challenges", require("./routes/liveChallengeRoutes"));
// FIX: treasureChestController existed with zero route file mounting it —
// TreasureChests.js calls /chests/available, /chests/claim-daily,
// /chests/:id/open and got 404 on all three.
app.use("/api/chests", require("./routes/treasureChestRoutes"));
// FIX: socialController existed with no route file ever mounting it —
// the entire Friends/Squad feature (Social.js frontend page) was calling
// endpoints that didn't exist on the backend at all.
app.use("/api/social",      require("./routes/socialRoutes"));
// NEW: behaviour profiles + smart study planner
app.use("/api/behavior",      require("./routes/behaviorRoutes"));
app.use("/api/study-planner", require("./routes/studyPlannerRoutes"));

// ── v3 UPGRADES ───────────────────────────────────────────
app.use("/api/flashcards",    require("./routes/flashcardRoutes"));
app.use("/api/ai-questions",  require("./routes/aiQuestionRoutes"));
app.use("/api/paystack",      require("./routes/paystackRoutes"));
app.use("/api/school-finder", require("./routes/schoolFinderRoutes"));
app.use("/api/seasons",       require("./routes/seasonRoutes"));

// PDF Vault routes (admin upload + student download)
const { adminRouter: pdfAdminRouter, studentRouter: pdfStudentRouter } = require("./routes/pdfRoutes");
const { requireAdmin: _pdfRequireAdmin, requireStudent: _pdfRequireStudent } = require("./middleware/auth");
app.use("/api/admin/pdfs", _pdfRequireAdmin, pdfAdminRouter);
app.use("/api/pdfs",       _pdfRequireStudent, pdfStudentRouter);

// ── Innovation routes (mounted at /api so sub-paths like /badges, /titles work) ──
app.use("/api", require("./routes/innovationRoutes"));

// ── Premium Events ──────────────────────────────────────────
const premCtrl = require("./controllers/adminPremiumController");
const { requireStudent: rS, requireAdmin: rA } = require("./middleware/auth");
app.get ("/api/premium-status",               rS, premCtrl.getPremiumStatus);
app.get ("/api/admin/premium-events",         rA, premCtrl.listEvents);
app.post("/api/admin/premium-events",         rA, premCtrl.createEvent);
app.get ("/api/admin/premium-events/active",  rA, premCtrl.getActiveEvent);
app.post("/api/admin/premium-events/:id/end", rA, premCtrl.endEventEarly);

// ── Treasure Chests ─────────────────────────────────────────
const chestCtrl = require("./controllers/treasureChestController");
app.get ("/api/chests/available",   rS, chestCtrl.getAvailableChests);
app.post("/api/chests/claim-daily", rS, chestCtrl.claimDailyChest);
app.post("/api/chests/:id/open",    rS, chestCtrl.openChest);

// ── Live Challenges history ─────────────────────────────────
const liveCtrl = require("./controllers/liveChallengeController");
app.get("/api/live-challenges/history", rS, liveCtrl.getLiveChallengeHistory);

// ── ARENA + CLASSROOM WEBSOCKET ───────────────────────────
const { initArena }     = require("./arena/arenaEngine");
const { initClassroom } = require("./classroom/classroomEngine");

// ── Innovation engines ─────────────────────────────────────
const { registerMicroInteractionSockets } = require("./controllers/microController");
const { registerSpiritSkills }            = require("./arena/spiritSkillsHandler");
const { initSchoolWars }                  = require("./arena/schoolWarsEngine");
const { initStudyRooms }                  = require("./rooms/studyRoomEngine");
const { initBlitz, initSurvival }         = require("./arena/arenaBlitzSurvival");
const { initTournament }                  = require("./controllers/tournamentController");
const { initLiveChallenges }              = require("./controllers/liveChallengeController");
const { initPremiumEvents }               = require("./controllers/adminPremiumController");

// Expose io globally for controllers that need it (fxRankUp etc.)
global.io = io;
app.set('io', io); // FIX: allow controllers to access io via req.app.get('io')

initArena(io);
initClassroom(io);

// Spirit active skills must be initialised AFTER initArena so rooms/players are ready
const arenaEngine = require("./arena/arenaEngine");
if (arenaEngine.rooms && arenaEngine.players) {
  registerSpiritSkills(io.of("/arena"), arenaEngine.rooms, arenaEngine.players);
}

registerMicroInteractionSockets(io);
initSchoolWars(io);
initStudyRooms(io);
initBlitz(io);
initSurvival(io);
initTournament(io);
initLiveChallenges(io);
// Auto-create premium_events table if it doesn't exist yet (safe, idempotent)
require("./config/db").query(`
  CREATE TABLE IF NOT EXISTS premium_events (
    id           BIGSERIAL    PRIMARY KEY,
    name         TEXT         NOT NULL DEFAULT 'Free Premium Day',
    note         TEXT,
    start_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    end_at       TIMESTAMPTZ  NOT NULL,
    activated_by INTEGER,
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )
`).then(() => console.log("✅ premium_events table ready"))
  .catch(e => console.warn("⚠️ Could not create premium_events table:", e.message));

// Auto-create Community Chat tables if they don't exist yet (safe, idempotent
// -- same pattern as premium_events above). See migrations/community_chat.sql
// for the canonical version of this schema.
require("./config/db").query(`
  CREATE TABLE IF NOT EXISTS community_messages (
    id            BIGSERIAL PRIMARY KEY,
    student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    content       VARCHAR(500) NOT NULL,
    is_hidden     BOOLEAN NOT NULL DEFAULT FALSE,
    hidden_by     INTEGER,
    hidden_reason TEXT,
    created_at    TIMESTAMP DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_community_messages_created ON community_messages(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_community_messages_student ON community_messages(student_id);
  CREATE TABLE IF NOT EXISTS community_chat_mutes (
    student_id  INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    muted_by    INTEGER,
    reason      TEXT,
    muted_until TIMESTAMP,
    created_at  TIMESTAMP DEFAULT NOW()
  );
`).then(() => console.log("✅ community_chat tables ready"))
  .catch(e => console.warn("⚠️ Could not create community_chat tables:", e.message));

initPremiumEvents(io).catch(() => {});

// ── STATUS ────────────────────────────────────────────────
app.get("/", (_req, res) => res.json({
  status:  "✅ Scholars Syndicate Backend",
  arena:   "✅ Online",
  aiTutor: "✅ Available",
  version: "2.0.0",
}));

// ── ERROR HANDLING ────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found." }));
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err.stack);
  res.status(500).json({ error: "Server error. Please try again." });
});

// ── START SERVER ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// FIX (intermittent "Connection reset by peer" on Render): per Render's own
// troubleshooting docs, Node services behind their proxy benefit from a
// higher keep-alive/headers timeout than Node's defaults (5s/60s), which
// can otherwise race with the platform's own proxy timing and drop
// in-flight requests — including large PDF uploads — for no code reason.
server.keepAliveTimeout = 120000;
server.headersTimeout   = 121000; // must be > keepAliveTimeout

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`🌐 Allowed origins: ${allowedOrigins.join(", ") || "all"}`);
  console.log(`📊 Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);

  // ── FIX: Replace unreliable setInterval cron with node-cron ──
  // node-cron survives server restarts reliably; setInterval was lost on Render restart
  const { runDailyRetentionJobs } = require("./controllers/pushController");

  // Run every hour at :00 — much more reliable than setInterval
  cron.schedule("0 * * * *", () => {
    console.log("⏰ Running hourly retention jobs...");
    runDailyRetentionJobs().catch(err => console.error("Retention job error:", err.message));
  });

  // Run once 10s after startup (catches missed jobs during deploy restarts)
  setTimeout(() => {
    runDailyRetentionJobs().catch(() => {});
  }, 10000);

  console.log("⏰ node-cron retention jobs scheduled (hourly)");

  // ── DAILY QUESTION PUSH — 07:00 WAT every day ──
  // BUGFIX: this function already existed in pushController.js but was never
  // actually scheduled anywhere, so it had never run in production.
  cron.schedule("0 7 * * *", async () => {
    console.log("📚 Sending daily question push...");
    try {
      const { sendDailyQuestionPush } = require("./controllers/pushController");
      await sendDailyQuestionPush();
    } catch (err) { console.error("Daily question push cron failed:", err.message); }
  });

  // ── SEASON END REWARDS — 1st of every month at 00:05 ──
  cron.schedule("5 0 1 * *", async () => {
    console.log("🏆 Distributing season rewards...");
    try {
      const { distributeSeasonRewards } = require("./controllers/seasonController");
      await distributeSeasonRewards();
    } catch (err) { console.error("Season rewards cron failed:", err.message); }
  });

  // NOTE: a weekly parent-SMS cron used to be scheduled here, but the
  // function it called (sendWeeklyParentReports) was removed from
  // parentController.js when the old Termii integration was cleaned up.
  // The cron was left in place and ran every Monday logging "success"
  // while silently doing nothing — misleading, so it's removed. Parent
  // notifications now happen per-exam instead, via notifyParent() in
  // parentNotificationController.js (wired into examController.js below).
  // If a real weekly digest is wanted again, build it as a new function
  // and schedule it explicitly — don't restore this block as-is.

  // ── NIGHTLY BEHAVIOUR PROFILE BATCH — refresh active students' profiles ──
  cron.schedule("0 2 * * *", async () => {
    console.log("🧠 Running nightly behaviour profile batch...");
    try {
      const { buildProfile } = require("./controllers/behaviorController");
      const db = require("./config/db");
      const { rows } = await db.query(
        `SELECT DISTINCT student_id FROM exam_sessions
         WHERE completed_at >= NOW() - INTERVAL '7 days' LIMIT 500`
      );
      for (const { student_id } of rows) {
        await buildProfile(student_id).catch(() => {});
      }
      console.log(`🧠 Rebuilt profiles for ${rows.length} active students`);
    } catch (err) { console.error("Nightly profile batch failed:", err.message); }
  });

  // ── NIGHTLY AI TUTOR NOTE EXTRACTION — 02:20, offset from the behaviour
  // profile batch above so the two don't compete for DB/AI-provider
  // throughput at the exact same minute. Distills recently-active chat
  // sessions into short standing facts (see extractSessionNotes in
  // aiTutorController.js) so ScholarAI has memory across sessions, not
  // just within the current one.
  cron.schedule("20 2 * * *", async () => {
    console.log("💬 Running nightly AI tutor note extraction...");
    try {
      const { runNightlyNoteExtraction } = require("./controllers/aiTutorController");
      const result = await runNightlyNoteExtraction();
      console.log(`💬 Note extraction: ${result.ok}/${result.processed} sessions processed (${result.failed} failed)`);
    } catch (err) { console.error("Nightly note extraction failed:", err.message); }
  });
});

// ── KEEP-ALIVE — only needed on Render free tier ──────────
// Upgrade to Render Starter ($7/mo) to eliminate this entirely.
if (process.env.NODE_ENV === "production" && process.env.RENDER_EXTERNAL_URL) {
  const https    = require("https");
  const SELF_URL = process.env.RENDER_EXTERNAL_URL;
  setInterval(() => {
    https.get(`${SELF_URL}/api/health`, (res) => {
      if (res.statusCode !== 200) console.warn(`⚠️ Keep-alive got ${res.statusCode}`);
    }).on("error", (e) => {
      console.warn("Keep-alive ping failed:", e.message);
    });
  }, 14 * 60 * 1000);
  console.log("⏰ Keep-alive enabled →", SELF_URL);
}
