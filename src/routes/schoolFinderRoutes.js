const router = require('express').Router();
const { requireStudent } = require('../middleware/auth');
const ctrl = require('../controllers/schoolFinderController');

// Public endpoints — no auth needed
router.get('/schools',      ctrl.searchSchools);
router.get('/schools/:id',  ctrl.getSchool);
router.get('/courses',      ctrl.getCourses);
router.get('/states',       ctrl.getStates);
router.post('/eligibility', ctrl.checkEligibility);

module.exports = router;
