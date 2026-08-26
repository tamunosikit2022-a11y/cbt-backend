const express = require('express');
const router  = express.Router();
const token   = require('../controllers/tokenController');
const { requireStudent, requireAdmin } = require('../middleware/auth');

// Paystack webhook — no auth (signed by Paystack)
router.post('/webhook', express.raw({ type:'application/json' }), token.webhook);

// Student routes
router.use(requireStudent);
router.get('/balance',                  token.getBalance);
router.get('/history',                  token.getHistory);
router.post('/whatsapp',                token.initWhatsAppPayment);
router.post('/initialize',              token.initializePayment);
router.get('/verify/:reference',        token.verifyPayment);

// Admin route — credit tokens after WhatsApp payment confirmed
router.post('/admin/credit/:reference', requireAdmin, token.adminCreditTokens);

// FIX: reward-ad flow split into start/complete so the server can verify
// real time elapsed instead of trusting the client entirely — see
// tokenController.js for the full explanation.
router.post('/reward-ad/start',    requireStudent, token.startRewardAdSession);
router.post('/reward-ad',          requireStudent, token.rewardAdCredit);

module.exports = router;
