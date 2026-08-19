const express = require("express");
const router  = express.Router();
const gem     = require("../controllers/gemController");
const { requireStudent, requireAdmin } = require("../middleware/auth");

// Students can browse packages freely
router.get("/packages", requireStudent, gem.getPackages);

// FIX BUG 29: purchaseGems must be admin-only — it credits gems without payment verification.
// Students buy gems via WhatsApp → admin generates voucher → student redeems at /api/vouchers/redeem
router.post("/purchase", requireAdmin, gem.purchaseGems);

module.exports = router;
