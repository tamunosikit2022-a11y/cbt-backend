const express = require("express");
const router  = express.Router();
const social   = require("../controllers/socialController");
const { requireStudent } = require("../middleware/auth");

router.use(requireStudent);

// ── SEARCH ─────────────────────────────────────────────────
router.get("/search", social.searchStudents);

// ── FRIENDS ────────────────────────────────────────────────
router.get("/friends",            social.getFriends);
router.get("/friends/pending",    social.getPendingRequests);
router.post("/friends/request",   social.sendFriendRequest);
router.post("/friends/respond",   social.respondToRequest);
router.delete("/friends/:friendId", social.removeFriend);

// ── SQUADS ─────────────────────────────────────────────────
router.get("/squads/mine",            social.getMySquad);
router.get("/squads/invites",         social.getPendingSquadInvites);
router.post("/squads",                social.createSquad);
router.delete("/squads/leave",        social.leaveSquad);
router.post("/squads/:squadId/invite", social.inviteToSquad);
router.post("/squads/accept-invite",  social.acceptSquadInvite);

module.exports = router;
