const express = require('express');
const router  = express.Router();
const { requireStudent } = require('../middleware/auth');
const ctrl    = require('../controllers/aiTutorController');

// All routes require authentication
router.use(requireStudent);

// Session management
router.get('/sessions',                        ctrl.getSessions);
router.post('/sessions',                       ctrl.createSession);
router.delete('/sessions/:sessionId',          ctrl.deleteSession);

// Messages within a session
router.get('/sessions/:sessionId/messages',    ctrl.getMessages);
router.post('/sessions/:sessionId/messages',   ctrl.sendMessage);

// Usage stats (for UI quota display)
router.get('/usage',                           ctrl.getUsage);

module.exports = router;
