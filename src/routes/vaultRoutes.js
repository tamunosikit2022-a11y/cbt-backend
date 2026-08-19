const express = require("express");
const router  = express.Router();
const vault   = require("../controllers/vaultController");
const { requireStudent } = require("../middleware/auth");
const { studentRouter: pdfStudentRouter } = require("./pdfRoutes");

router.use(requireStudent);

router.get("/",          vault.getVault);
router.get("/library",   vault.getMyLibrary);
router.post("/unlock",   vault.unlockItem);

// ── PDF Folder Bank ───────────────────────────────────────
router.use("/pdfs", pdfStudentRouter);

module.exports = router;
