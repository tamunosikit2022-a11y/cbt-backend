const router = require("express").Router();
const { requireStudent } = require("../middleware/auth");
const ctrl = require("../controllers/squadChatController");

router.use(requireStudent);
router.get("/",     ctrl.getMessages);
router.post("/",    ctrl.sendMessage);
router.delete("/:id", ctrl.deleteMessage);

module.exports = router;
