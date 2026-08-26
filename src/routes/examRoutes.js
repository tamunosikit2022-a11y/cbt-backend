const express = require("express");
const router  = express.Router();
const exam    = require("../controllers/examController");
const { requireStudent } = require("../middleware/auth");

router.use(requireStudent);

router.get("/subjects",        exam.getSubjects);
router.get("/institutions",    exam.getInstitutions);
router.get("/questions",       exam.getQuestions);
router.post("/submit",         exam.submitExam);
router.get("/history",         exam.getHistory);
router.get("/leaderboard",     exam.getLeaderboard);
router.get("/university-leaderboard", exam.getUniversityLeaderboard);
router.get("/performance",     exam.getPerformance);
router.get("/wrong-answers",   exam.getWrongAnswers);
router.post("/examiner-breakdown", exam.getExaminerBreakdown);
// NEW: weakness heatmap + state leaderboard
router.get("/heatmap",         exam.getWeaknessHeatmap);
router.get("/state-leaderboard", exam.getStateLeaderboard);
// FIX: reload full session results with explanations (for History / revisit)
router.get("/session/:id",     exam.getSessionResults);
router.post("/questions/:id/report", exam.reportQuestion);

router.get('/university-course-counts', exam.getUniversityCounts);
module.exports = router;
