const express = require("express");
const router  = express.Router();
const admin   = require("../controllers/adminController");
const qgen    = require("../controllers/adminQuestionGenController");
const { requireAdmin } = require("../middleware/auth");
const { rooms } = require("../arena/arenaEngine");

router.use(requireAdmin);

// Dashboard
router.get("/dashboard",                    admin.getDashboardStats);
router.get("/analytics",                    admin.getUserAnalytics);

// Students
router.get("/students",                     admin.listStudents);
router.get("/students/:student_id",         admin.getStudentProfile);
router.post("/students/:student_id/ban",    admin.banStudent);
router.post("/students/:student_id/unban",  admin.unbanStudent);
router.get("/duplicate-accounts",           admin.getDuplicateAccounts);
router.post("/duplicate-accounts/merge-ban",admin.resolveDuplicateGroup);

// Keys
router.post("/keys",                        admin.createKeys);
router.get("/keys",                         admin.listKeys);
router.delete("/keys/:key_code",            admin.deactivateKey);
router.get("/keys/:key_code/usage",         admin.keyUsageDetail);
router.post("/broadcast",                   admin.broadcast);

// Arena monitoring
router.get("/arena-live", (req, res) => {
  const live = [];
  for (const [code, room] of rooms) {
    live.push({
      code,
      mode:        room.mode,
      battleType:  room.battleType,
      subject:     room.subject || "Mixed",
      status:      room.status,
      playerCount: room.players.size,
      maxPlayers:  room.maxPlayers,
      hostName:    room.host?.name || "Unknown",
      players:     [...room.players.values()].map(p => ({
        name: p.name, ready: p.ready, score: p.score || 0,
      })),
      createdAt: room.createdAt,
    });
  }
  live.sort((a, b) => (a.status === "playing" ? -1 : 1));
  res.json(live);
});

router.get("/arena-stats", admin.getArenaStats);

// ── Voucher management ────────────────────────────────────
const vc = require("../controllers/voucherController");
router.post("/vouchers/generate",          vc.generateVoucher);
router.get("/vouchers/list",               vc.listVouchers);
router.delete("/vouchers/:code/deactivate", vc.deactivateVoucher);

// ── PDF Folder Bank ───────────────────────────────────────
const { adminRouter: pdfAdminRouter } = require("./pdfRoutes");
router.use("/pdfs", pdfAdminRouter);


// ── Questions Manager ─────────────────────────────────────
router.get("/questions",                         admin.listQuestions);
router.post("/questions",                        admin.addQuestion);
router.delete("/questions/:id",                  admin.deleteQuestion);
// ── AI Question Generation from PDF ──────────────────────
router.post("/questions/generate-from-pdf",      qgen.uploadMiddleware, qgen.generateFromPdf);
router.post("/questions/generate-from-url",      qgen.generateFromUrl);
router.get("/questions/gen-jobs",                qgen.listJobs);
router.get("/questions/gen-jobs/:id",            qgen.getJob);

// ── Spin history ──────────────────────────────────────────
router.get("/spin-history",      admin.getSpinHistory);

// ── Currency manager ──────────────────────────────────────
router.post("/manage-currency",  admin.manageCurrency);

// ── NEW: Parent portal invite links ───────────────────────
// Admin generates a unique one-time link per student, shares it
// directly (WhatsApp/SMS) — parent never needs a code, and nothing
// is added to the student dashboard.
const parentInvite = require("../controllers/adminParentInviteController");
router.post("/students/:student_id/parent-invite",   parentInvite.createInvite);
router.get("/students/:student_id/parent-invites",   parentInvite.listInvites);
router.delete("/parent-invites/:id",                 parentInvite.revokeInvite);

// FIX: adminPremiumController existed with a working set of handlers but no
// route ever exposed them — the "Free Day" tab in AdminDashboard.js
// (PremiumEventPanel) called /admin/premium-events and
// /admin/premium-events/active and got 404 on every load.
const premiumEvents = require("../controllers/adminPremiumController");
router.get("/premium-events",           premiumEvents.listEvents);
router.get("/premium-events/active",    premiumEvents.getActiveEvent);
router.post("/premium-events",          premiumEvents.createEvent);
router.post("/premium-events/:id/end",  premiumEvents.endEventEarly);

// ── NEW: Community Chat moderation ────────────────────────
// Backs the "Community Chat" tab in AdminDashboard.js — admins can hide
// a message the automatic profanity filter missed, or mute a repeat
// offender for a set number of hours (or indefinitely).
const communityChat = require("../controllers/communityChatController");
router.post("/community-chat/:id/hide",        communityChat.adminHideMessage);
router.get("/community-chat/mutes",             communityChat.adminListMutes);
router.post("/community-chat/mute",             communityChat.adminMuteStudent);
router.delete("/community-chat/mute/:student_id", communityChat.adminUnmuteStudent);

module.exports = router;