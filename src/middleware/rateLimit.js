/**
 * Rate Limiting Middleware — Scholars Syndicate
 * Protects all sensitive endpoints from brute-force, scraping, and abuse.
 * Uses express-rate-limit (no Redis required for single-instance).
 */
const rateLimit = require("express-rate-limit");

const isProd = process.env.NODE_ENV === "production";

// Helper: sensible message
const msg = (action, wait) => ({
  error: `Too many ${action} attempts. Please wait ${wait} before trying again.`
});

// ── AUTH LIMITERS ────────────────────────────────────────────
// Login: 10 attempts per 15 minutes per IP
exports.loginLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              isProd ? 10 : 1000,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          msg("login", "15 minutes"),
  skipFailedRequests: false,
});

// OTP send: 3 requests per 5 minutes per IP (matches existing DB check)
exports.otpLimiter = rateLimit({
  windowMs:         5 * 60 * 1000,
  max:              isProd ? 3 : 1000,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          msg("OTP", "5 minutes"),
});

// Registration: 5 per hour per IP (prevents mass account creation)
exports.registerLimiter = rateLimit({
  windowMs:         60 * 60 * 1000,
  max:              isProd ? 5 : 1000,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          msg("registration", "1 hour"),
});

// ── API LIMITERS ────────────────────────────────────────────
// AI Tutor: 30 messages per minute per user (generous but prevents Groq drain)
exports.aiTutorLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              isProd ? 30 : 1000,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          msg("AI tutor", "1 minute"),
  keyGenerator:     (req) => req.student?.id?.toString() || req.ip,
});

// AI quiz generation (from-pdf / from-text): each call is a real AI API
// cost — up to 10,000 chars of text, or a full PDF via Gemini's document
// understanding — and unlike every other AI-costing endpoint here, this one
// previously had zero rate limiting or token cost at all, so a student
// could script unlimited calls for free with no protection for the business.
exports.aiQuizLimiter = rateLimit({
  windowMs:         60 * 60 * 1000, // 1 hour — these are heavier calls than a tutor chat message
  max:              isProd ? 8 : 1000,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          msg("AI quiz generation", "1 hour"),
  keyGenerator:     (req) => req.student?.id?.toString() || req.ip,
});

// Arduino compile: 10 per minute per user (each call spawns arduino-cli —
// this is the one Live IDE endpoint that actually costs real CPU, so it
// gets its own tight limiter separate from generalLimiter).
exports.compileLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              isProd ? 10 : 1000,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          msg("compile", "1 minute"),
  keyGenerator:     (req) => req.student?.id?.toString() || req.ip,
});

// Exam submit: 20 per minute per user (prevents flooding exam_sessions table)
exports.examSubmitLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              isProd ? 20 : 1000,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          msg("exam submissions", "1 minute"),
  keyGenerator:     (req) => req.student?.id?.toString() || req.ip,
});

// Token purchase: 10 per hour per user (prevents transaction flooding)
exports.tokenPurchaseLimiter = rateLimit({
  windowMs:         60 * 60 * 1000,
  max:              isProd ? 10 : 1000,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          msg("token purchases", "1 hour"),
  keyGenerator:     (req) => req.student?.id?.toString() || req.ip,
});

// General API: 300 requests per minute per IP (catches bots without affecting real users)
exports.generalLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              isProd ? 300 : 10000,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: "Too many requests. Slow down." },
});
