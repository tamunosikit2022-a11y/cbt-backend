const express = require('express');
const router  = express.Router();
const push    = require('../controllers/pushController');
const { requireStudent } = require('../middleware/auth');

router.get('/vapid-key',    push.getVapidKey);
router.use(requireStudent);
router.post('/subscribe',   push.saveSubscription);
router.delete('/subscribe', push.deleteSubscription);

module.exports = router;
