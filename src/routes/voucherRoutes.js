const express = require("express");
const router  = express.Router();
const vc      = require("../controllers/voucherController");
const { requireStudent } = require("../middleware/auth");
const { requireAdmin }   = require("../middleware/auth");

// ── Student routes ────────────────────────────────────────
router.post("/redeem", requireStudent, vc.redeemVoucher);

// ── Admin routes ──────────────────────────────────────────
router.post("/generate",         requireAdmin, vc.generateVoucher);
router.get("/list",              requireAdmin, vc.listVouchers);
router.delete("/:code/deactivate", requireAdmin, vc.deactivateVoucher);

module.exports = router;
