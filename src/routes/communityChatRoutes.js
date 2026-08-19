const router = require('express').Router();
const { requireStudent } = require('../middleware/auth');
const ctrl = require('../controllers/communityChatController');

router.get('/',        requireStudent, ctrl.getMessages);
router.post('/',       requireStudent, ctrl.sendMessage);
router.delete('/:id',  requireStudent, ctrl.deleteMessage);

module.exports = router;
