const router = require("express").Router();
const { requireStudent } = require("../middleware/auth");
const ctrl = require("../controllers/studyNotesController");

router.use(requireStudent);
router.post("/generate", ctrl.generateNotes);
router.get("/latest",   ctrl.getLatestNotes);

module.exports = router;
