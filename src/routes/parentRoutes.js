/**
 * parentRoutes.js
 * Mount in server.js:  app.use("/api/parent", require("./routes/parentRoutes"));
 *
 * FIX/NEW: Added public invite-link endpoints so a parent can set up
 * their portal directly from an admin-generated unique link, without
 * needing a manually-typed link_code and without anything appearing
 * on the student's dashboard.
 */

const express = require("express");
const router  = express.Router();
const jwt     = require("jsonwebtoken");
const parent  = require("../controllers/parentController");
const invite  = require("../controllers/adminParentInviteController");

// ── Auth middleware for parents ───────────────────────────
function requireParent(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Not authenticated." });
  try {
    const decoded = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET);
    if (decoded.role !== "parent") return res.status(403).json({ error: "Parent access only." });
    req.parent = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
  }
}

// ── Public (legacy link-code flow — kept for backward compatibility) ──
router.post("/register", parent.register);
router.post("/login",    parent.login);

// ── NEW: Public invite-link flow (preferred — admin-generated) ────────
router.get("/invite/:token",         invite.checkInvite);
router.post("/invite/:token/accept", invite.acceptInvite);

// ── Protected ──────────────────────────────────────────────
router.get("/dashboard", requireParent, parent.getDashboard);
router.get("/report.pdf", requireParent, parent.getProgressReportPDF);

// Test SMS notification (parentNotificationController.js)
const notify = require("../controllers/parentNotificationController");
router.post("/notify-test", require("../middleware/auth").requireStudent, notify.sendTestNotification);

module.exports = router;
