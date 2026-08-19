const router = require('express').Router();
const { requireStudent } = require('../middleware/auth');
const ctrl = require('../controllers/aiQuestionController');

router.use(requireStudent);
router.get('/subjects',   ctrl.getSubjects);
router.post('/generate',  ctrl.generateQuestions);
router.post('/reveal',    ctrl.revealAnswer);
router.post('/grade',     ctrl.gradeAnswers);

module.exports = router;
