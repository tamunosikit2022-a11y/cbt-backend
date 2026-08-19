/**
 * studyPlannerRoutes.js — Scholars Syndicate
 * FIX: Added POST /generate (Groq AI plan) and GET /my-plan (saved plan).
 *      Previously only had a stub with no real functionality.
 */

const router = require("express").Router();
const { requireStudent } = require("../middleware/auth");
const ctrl = require("../controllers/studyPlannerController");

router.use(requireStudent);

// POST /api/study-planner/generate  — AI-powered plan generation
router.post("/generate", ctrl.generatePlan);

// GET  /api/study-planner/my-plan   — retrieve last saved plan
router.get("/my-plan",   ctrl.getMyPlan);

module.exports = router;
