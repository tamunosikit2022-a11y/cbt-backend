/**
 * careerRoutes.js — Scholars Syndicate
 * FIX: This route file was entirely missing.
 *      CareerQuiz.js posted to /career/suggest and got 404 every time.
 *
 * Add to server.js:
 *   app.use("/api/career", require("./routes/careerRoutes"));
 */

const router = require("express").Router();
const { requireStudent } = require("../middleware/auth");
const ctrl = require("../controllers/careerController");

// All career routes require a logged-in student
router.use(requireStudent);

// POST /api/career/suggest   — process quiz answers, return AI career match
router.post("/suggest", ctrl.suggest);

// GET  /api/career/result    — fetch the student's last saved result
router.get("/result", ctrl.getResult);

module.exports = router;
