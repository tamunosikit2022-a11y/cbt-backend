const router = require('express').Router();
const { requireStudent } = require('../middleware/auth');
const ctrl = require('../controllers/seasonController');

router.use(requireStudent);
router.get('/current', ctrl.getCurrentSeason);
router.get('/history', ctrl.getSeasonHistory);

module.exports = router;
