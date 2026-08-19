/**
 * liveChallengeRoutes.js — Scholars Syndicate
 * FIX: liveChallengeController.js existed with a working handler but no
 *      route file ever exposed it. Social.js calls GET /live-challenges/history
 *      and was getting a 404 on every load.
 */
const router = require("express").Router();
const { requireStudent } = require("../middleware/auth");
const ctrl = require("../controllers/liveChallengeController");

router.get("/history", requireStudent, ctrl.getLiveChallengeHistory);

module.exports = router;
