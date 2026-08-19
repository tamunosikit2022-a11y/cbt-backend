const express = require("express");
const router  = express.Router();
const fac     = require("../controllers/factionController");
const { requireStudent } = require("../middleware/auth");

router.use(requireStudent);

router.get("/schools",  fac.getSchoolLeaderboard);
router.get("/mine",     fac.getMySchool);
router.get("/states",   fac.getStateLeaderboard);

module.exports = router;
