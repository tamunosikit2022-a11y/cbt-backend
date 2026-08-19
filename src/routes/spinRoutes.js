const express = require("express");
const router  = express.Router();
const spin    = require("../controllers/spinController");
const { requireStudent } = require("../middleware/auth");

router.use(requireStudent);
router.get("/status", spin.getSpinStatus);
router.post("/spin",  spin.doSpin);

module.exports = router;
