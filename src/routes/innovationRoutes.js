/**
 * INNOVATION ROUTES — All new feature endpoints
 * Mount in server.js with:
 *   const innovationRoutes = require('./routes/innovationRoutes');
 *   app.use('/api', innovationRoutes);
 */

const router = require('express').Router();
const { requireStudent, requireAdmin } = require('../middleware/auth');
const { aiQuizLimiter } = require('../middleware/rateLimit');

const innovation       = require('../controllers/innovationController');
const badges           = require('../controllers/badgesController');
const micro            = require('../controllers/microController');
const aiQuiz           = require('../controllers/aiQuizController');
const seasonCosmetics  = require('../controllers/seasonCosmeticsController');
const tournament       = require('../controllers/tournamentController');
const teamMissions     = require('../controllers/teamMissionsController');
const weakness         = require('../controllers/weaknessDetectorController');
const social           = require('../controllers/socialController');
const schoolWars       = require('../arena/schoolWarsEngine');
const studyRooms       = require('../rooms/studyRoomEngine');
const blitzSurvival    = require('../arena/arenaBlitzSurvival');

// ── INNOVATIONS — Daily Challenge ──────────────────────────
router.get ('/innovations/challenge/today',   requireStudent, innovation.getTodayChallenge);
router.post('/innovations/challenge/submit',  requireStudent, innovation.submitChallenge);
router.get ('/innovations/challenge/history', requireStudent, innovation.getChallengeHistory);

// ── INNOVATIONS — Predicted Score ──────────────────────────
router.get ('/innovations/predicted-score',   requireStudent, innovation.getPredictedScore);

// ── INNOVATIONS — Exam Drafts ──────────────────────────────
router.get ('/innovations/draft/list',        requireStudent, innovation.getDrafts);
router.post('/innovations/draft/save',        requireStudent, innovation.saveDraft);
router.get ('/innovations/draft/:id',         requireStudent, innovation.loadDraft);
router.delete('/innovations/draft/:id',       requireStudent, innovation.deleteDraft);

// ── INNOVATIONS — Badges (alias so /innovations/badges works) ─
router.get ('/innovations/badges',            requireStudent, innovation.getMyBadges);

// BADGES & TITLES
router.get   ('/badges',                       requireStudent, badges.getBadgeCatalogue);
router.get   ('/badges/my',                    requireStudent, badges.getMyBadges);
router.post  ('/badges/check',                 requireStudent, badges.triggerBadgeCheck);
router.get   ('/titles',                       requireStudent, badges.getTitleCatalogue);
router.post  ('/titles/equip',                 requireStudent, badges.equipTitle);

// MICRO-INTERACTIONS
router.post  ('/fx/test',                      requireStudent, micro.testFX);

// AI QUIZ GENERATOR
router.post  ('/ai-quiz/from-pdf',             requireStudent, aiQuizLimiter, aiQuiz.generateFromPDF);
router.post  ('/ai-quiz/from-text',            requireStudent, aiQuizLimiter, aiQuiz.generateFromText);
router.post  ('/ai-quiz/from-video',           requireStudent, aiQuizLimiter, aiQuiz.generateFromVideo);
router.post  ('/ai-quiz/save',                 requireStudent, aiQuiz.saveQuiz);
router.get   ('/ai-quiz/my-quizzes',           requireStudent, aiQuiz.getMyQuizzes);
router.get   ('/ai-quiz/my-quizzes/:id',       requireStudent, aiQuiz.getQuizById);

// SEASON COSMETICS
router.get   ('/season-cosmetics',             requireStudent, seasonCosmetics.getSeasonCosmetics);
router.post  ('/season-cosmetics/equip',       requireStudent, seasonCosmetics.equipCosmetic);
router.post  ('/season-cosmetics/seed',        requireAdmin,   seasonCosmetics.seedSeasonCosmetics);
router.post  ('/season-cosmetics/:id/claim',   requireStudent, seasonCosmetics.claimSeasonCosmetic);
router.get   ('/season-cosmetics/loadout/:studentId', requireStudent, seasonCosmetics.getStudentLoadout);

// SPIN WHEEL EVENTS
router.get   ('/spin-events/active',           requireStudent, seasonCosmetics.getActiveSpinEvent);
router.post  ('/spin-events/spin',             requireStudent, seasonCosmetics.doEventSpin);
router.post  ('/spin-events',                  requireAdmin,   seasonCosmetics.createSpinEvent);

// TOURNAMENT
router.get   ('/tournaments',                  requireStudent, tournament.listTournaments);
router.get   ('/tournaments/:id',              requireStudent, tournament.getTournament);
router.post  ('/tournaments',                  requireAdmin,   tournament.createTournament);
router.post  ('/tournaments/:id/register',     requireStudent, tournament.registerForTournament);
router.post  ('/tournaments/:id/start',        requireAdmin,   tournament.startTournament);
router.post  ('/tournaments/:id/submit-result',requireStudent, tournament.submitMatchResult);

// TEAM MISSIONS
router.get   ('/team-missions',                requireStudent, teamMissions.getTeamMissions);
router.get   ('/team-missions/history',        requireStudent, teamMissions.getTeamMissionHistory);
router.post  ('/team-missions/reset-daily',    requireAdmin,   teamMissions.resetDailyMissions);
router.post  ('/team-missions/reset-weekly',   requireAdmin,   teamMissions.resetWeeklyMissions);

// AI WEAKNESS DETECTOR
router.get   ('/weakness-detector',            requireStudent, weakness.getWeaknessReport);
router.get   ('/weakness-detector/progress',   requireStudent, weakness.getWeaknessProgress);
router.get   ('/weakness-detector/weekly-digest', requireStudent, weakness.getWeeklyDigest);
router.post  ('/weakness-detector/practice',   requireStudent, weakness.startPracticeSession);

// SOCIAL — FRIENDS + SQUADS
router.get   ('/social/search',                requireStudent, social.searchStudents);
router.post  ('/social/friends/request',       requireStudent, social.sendFriendRequest);
router.post  ('/social/friends/respond',       requireStudent, social.respondToRequest);
router.get   ('/social/friends',               requireStudent, social.getFriends);
router.get   ('/social/friends/pending',       requireStudent, social.getPendingRequests);
router.delete('/social/friends/:friendId',     requireStudent, social.removeFriend);
router.post  ('/social/squads',                requireStudent, social.createSquad);
router.post  ('/social/squads/:squadId/invite',requireStudent, social.inviteToSquad);
router.post  ('/social/squads/accept-invite',  requireStudent, social.acceptSquadInvite);
router.get   ('/social/squads/mine',           requireStudent, social.getMySquad);
router.get   ('/social/squads/invites',        requireStudent, social.getPendingSquadInvites);
router.delete('/social/squads/leave',          requireStudent, social.leaveSquad);

// SCHOOL WARS
router.get   ('/school-wars/leaderboard',      requireStudent, schoolWars.getWarLeaderboard);
router.get   ('/school-wars/active',           requireStudent, schoolWars.getActiveWars);
router.get   ('/school-wars/history',          requireStudent, schoolWars.getWarHistory);
router.post  ('/school-wars/challenge',        requireStudent, schoolWars.issueChallenge);
router.post  ('/school-wars/:warId/accept',    requireStudent, schoolWars.acceptChallenge);
router.post  ('/school-wars/:warId/join',      requireStudent, schoolWars.joinWar);

// STUDY ROOMS
router.get   ('/study-rooms',                  requireStudent, studyRooms.listRooms);
router.post  ('/study-rooms',                  requireStudent, studyRooms.createRoom);
router.get   ('/study-rooms/:id',              requireStudent, studyRooms.getRoom);

// BLITZ + SURVIVAL HISTORY
router.get   ('/blitz/history',                requireStudent, blitzSurvival.getBlitzHistory);
router.get   ('/survival/history',             requireStudent, blitzSurvival.getSurvivalHistory);

module.exports = router;
