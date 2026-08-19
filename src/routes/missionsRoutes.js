const express  = require("express");
const router   = express.Router();
const missions = require("../controllers/missionsController");
const { requireStudent } = require("../middleware/auth");

router.use(requireStudent);

router.get("/daily",       missions.getDailyMissions);
router.post("/claim",      missions.claimMission);
router.get("/level",       missions.getLevelInfo);

module.exports = router;
