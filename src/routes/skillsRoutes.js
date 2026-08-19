const express = require("express");
const router  = express.Router();
const sk      = require("../controllers/skillsController");
const { requireStudent } = require("../middleware/auth");

router.use(requireStudent);

router.get("/",       sk.getSkills);
router.post("/buy",   sk.buySkill);
router.post("/use",   sk.useSkill);

module.exports = router;
