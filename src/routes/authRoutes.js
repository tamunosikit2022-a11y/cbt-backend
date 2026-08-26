const express = require("express");
const router  = express.Router();
const auth    = require("../controllers/authController");
const { requireStudent } = require("../middleware/auth");
const { otpLimiter, otpVerifyLimiter, loginLimiter, registerLimiter, adminLoginLimiter } = require("../middleware/rateLimit");

// ── PUBLIC ROUTES ─────────────────────────────────────────
// loginLimiter/registerLimiter/adminLoginLimiter existed in rateLimit.js
// but, like the OTP limiters before them, were never actually attached to
// a route — these three endpoints had no rate limiting at all. adminLogin
// especially: it's the single most sensitive credential in the app and
// was completely unthrottled against brute force.
router.post("/register",        registerLimiter,   auth.register);
router.post("/login",           loginLimiter,       auth.login);
router.post("/admin/login",     adminLoginLimiter,  auth.adminLogin);

// Password reset — 6-digit OTP sent by email (Brevo)
// otpLimiter/otpVerifyLimiter were defined in rateLimit.js but never wired
// up here — these three endpoints were completely unprotected, meaning the
// 5-min/3-request DB check in forgotPassword was the only brake on sending
// codes, and verify-otp had no attempt limit at all (brute-forceable 6-digit
// code, 1M combinations, unlimited guesses).
router.post("/forgot-password", otpLimiter,       auth.forgotPassword);
router.post("/verify-otp",      otpVerifyLimiter, auth.verifyOtp);
router.post("/reset-password",  otpVerifyLimiter, auth.resetPassword);

// JWT refresh token rotation — silently renews 1h access token
router.post("/refresh",         auth.refreshToken);

// Notifications — public, no auth needed (announcements for all students)
router.get( "/notifications",          auth.getNotifications);
router.post("/notifications/read",     requireStudent, auth.markNotificationsRead);
router.post("/subscribe-notifications", requireStudent, auth.subscribeNotifications);

// ── PROTECTED ROUTES ──────────────────────────────────────
router.get( "/me",              requireStudent, auth.getMe);
router.get( "/profile",         requireStudent, auth.getMe);
router.put( "/profile",         requireStudent, auth.updateProfile);
// BUG FIX: JAMBCountdown.js (the "set your exam date" widget) called
// PATCH /auth/profile, but only PUT was ever registered here — the save
// silently 404'd every time. PATCH is semantically the better verb for a
// partial update anyway, so it's kept as the primary and PUT stays for
// whatever else still calls it.
router.patch("/profile",        requireStudent, auth.updateProfile);
router.put( "/avatar",          requireStudent, auth.updateAvatar);
router.put( "/username",        requireStudent, auth.updateUsername);
router.put( "/change-password", requireStudent, auth.changePassword);
router.post("/activate-key",    requireStudent, auth.activateKey);

// FIX: Email verification endpoints
router.get("/verify-email/:token", auth.verifyEmail);
router.post("/resend-verification", requireStudent, auth.resendVerification);

module.exports = router;

