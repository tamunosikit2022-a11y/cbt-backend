const express = require("express");
const router  = express.Router();
const { requireStudent } = require("../middleware/auth");
const ctrl = require("../controllers/behaviorController");

router.use(requireStudent);
router.get("/profile", ctrl.getProfile);

module.exports = router;
