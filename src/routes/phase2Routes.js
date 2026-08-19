const express = require("express");
const router  = express.Router();
const p2      = require("../controllers/phase2Controller");
const { requireStudent } = require("../middleware/auth");

router.use(requireStudent);

// Spaced Repetition
router.get("/spaced/queue",      p2.getSpacedRepQueue);
router.get("/spaced/stats",      p2.getSpacedRepStats);
router.post("/spaced/update",    p2.updateSpacedRep);
router.post("/spaced/add",       p2.addToSpacedRep);

// Personality Profile
router.get("/personality",       p2.getPersonalityProfile);

// Beat Yourself
router.get("/beat-yourself",     p2.getBeatYourselfStats);
router.post("/beat-yourself",    p2.recordBeatYourself);

// Mistake Patterns
router.get("/patterns",          p2.getMistakePatterns);

module.exports = router;
