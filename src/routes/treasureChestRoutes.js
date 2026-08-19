/**
 * treasureChestRoutes.js — Scholars Syndicate
 * FIX: treasureChestController.js existed with working handlers but no
 *      route file ever exposed them. TreasureChests.js calls:
 *        GET  /chests/available
 *        POST /chests/claim-daily
 *        POST /chests/:id/open
 *      and got 404 on all three.
 */
const router = require("express").Router();
const { requireStudent } = require("../middleware/auth");
const ctrl = require("../controllers/treasureChestController");

router.use(requireStudent);
router.get("/available",     ctrl.getAvailableChests);
router.post("/claim-daily",  ctrl.claimDailyChest);
router.post("/:id/open",     ctrl.openChest);

module.exports = router;
