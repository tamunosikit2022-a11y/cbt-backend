/**
 * USERNAME GENERATOR
 * ─────────────────────────────────────────────────────────
 * Auto-assigns a unique username at registration, derived from
 * the student's full name + a random number. Students can change
 * it anytime via PUT /auth/username (see authController.updateUsername).
 */

const db = require("../config/db");
const { isTextSafe } = require("./contentFilter");

function slugify(name) {
  const cleaned = (name || "student")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  return cleaned || "student";
}

async function generateUniqueUsername(fullName) {
  const base = slugify(fullName);

  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = Math.floor(100 + Math.random() * 900); // 3-digit
    const candidate = `${base}${suffix}`;

    if (!isTextSafe(candidate)) continue; // shouldn't happen (name-based), but be safe

    const { rows } = await db.query(
      "SELECT id FROM students WHERE LOWER(username) = LOWER($1)",
      [candidate]
    );
    if (!rows.length) return candidate;
  }

  // Extremely unlikely fallback: fully random, timestamp-based
  return `student${Date.now().toString().slice(-8)}`;
}

module.exports = { generateUniqueUsername, slugify };
