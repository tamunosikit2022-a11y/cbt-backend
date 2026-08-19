const router = require('express').Router();
const { requireStudent } = require('../middleware/auth');
const ctrl = require('../controllers/flashcardController');

router.use(requireStudent);
router.get('/due',        ctrl.getDueCards);
router.post('/review',    ctrl.submitReview);
router.get('/stats',      ctrl.getStats);
router.post('/add',       ctrl.addCard);

module.exports = router;
