const express = require("express");
const router  = express.Router();
const sp      = require("../controllers/spiritsController");
const { requireStudent } = require("../middleware/auth");

router.use(requireStudent);

router.get("/",       sp.getSpirits);
router.post("/unlock", sp.unlockSpirit);
router.post("/equip",  sp.equipSpirit);
router.post("/feed",   sp.feedSpirit);

module.exports = router;
