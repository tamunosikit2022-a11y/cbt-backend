const router  = require('express').Router();
const express = require('express');
const { requireStudent } = require('../middleware/auth');
const ctrl = require('../controllers/paystackController');

// Webhook needs raw body — mount BEFORE json middleware kicks in
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  if (req.body && !Buffer.isBuffer(req.body)) return next();
  req.body = JSON.parse(req.body.toString());
  next();
}, ctrl.webhook);

router.use(requireStudent);
router.get('/key',           ctrl.getPublicKey);
router.post('/initialize',   ctrl.initializePayment);
router.get('/verify',        ctrl.verifyPayment);

module.exports = router;
