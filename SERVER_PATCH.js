/**
 * SERVER.JS PATCH — Add these blocks to your existing server.js
 * ─────────────────────────────────────────────────────────────
 * Copy each section into the corresponding location in server.js
 */

// ══════════════════════════════════════════════════════════
// 1. ADD THESE REQUIRES at the top of server.js
//    (after your existing requires)
// ══════════════════════════════════════════════════════════
const { registerMicroInteractionSockets } = require('./controllers/microController');
const { registerSpiritSkills }            = require('./arena/spiritSkillsHandler');
const { initSchoolWars }                  = require('./arena/schoolWarsEngine');
const { initStudyRooms }                  = require('./rooms/studyRoomEngine');
const { initBlitz, initSurvival }         = require('./arena/arenaBlitzSurvival');
const { initTournament }                  = require('./controllers/tournamentController');
const innovationRoutes                    = require('./routes/innovationRoutes');


// ══════════════════════════════════════════════════════════
// 2. ADD THESE ROUTES after your existing app.use('/api/...')
//    blocks
// ══════════════════════════════════════════════════════════
app.use('/api', innovationRoutes);


// ══════════════════════════════════════════════════════════
// 3. ADD THESE SOCKET INIT CALLS after io is created
//    (after: const io = new Server(server, { ... }) )
//
//    Also requires passing `io` and `rooms`/`players` maps
//    from your existing arenaEngine — adjust to match your
//    actual export names.
// ══════════════════════════════════════════════════════════

// Micro-interactions — student personal FX rooms
registerMicroInteractionSockets(io);

// Spirit skills during Arena — pass the arena namespace + maps
const arenaNamespace = io.of('/arena');
const { rooms, players } = require('./arena/arenaEngine'); // adjust to your export
registerSpiritSkills(arenaNamespace, rooms, players);

// New arena modes
initBlitz(io);       // namespace: /blitz
initSurvival(io);    // namespace: /survival

// School Wars
initSchoolWars(io);  // namespace: /school-wars

// Study / Voice Rooms
initStudyRooms(io);  // namespace: /study

// Tournament
initTournament(io);  // namespace: /tournament


// ══════════════════════════════════════════════════════════
// 4. CRON JOBS — add these to your existing cron setup
//    (e.g. using node-cron or a separate cron file)
// ══════════════════════════════════════════════════════════

// Daily team mission reset — midnight
// cron.schedule('0 0 * * *', async () => {
//   const { TEAM_MISSIONS } = require('./controllers/teamMissionsController');
//   const dailyIds = TEAM_MISSIONS.filter(m => m.resetPeriod === 'daily').map(m => m.id);
//   await db.query('DELETE FROM squad_mission_progress WHERE mission_id = ANY($1)', [dailyIds]);
//   console.log('Daily team missions reset');
// });

// Weekly team mission reset — Monday midnight
// cron.schedule('0 0 * * 1', async () => {
//   const { TEAM_MISSIONS } = require('./controllers/teamMissionsController');
//   const weeklyIds = TEAM_MISSIONS.filter(m => m.resetPeriod === 'weekly').map(m => m.id);
//   await db.query('DELETE FROM squad_mission_progress WHERE mission_id = ANY($1)', [weeklyIds]);
//   console.log('Weekly team missions reset');
// });
