/**
 * CONTENT FILTER — Username / text moderation
 * ─────────────────────────────────────────────────────────
 * Blocks porn/nudity-related and other inappropriate words from
 * being used in usernames (and reusable anywhere else text needs
 * the same check, e.g. bio, squad names).
 *
 * This is a lightweight local wordlist filter — no external API,
 * no cost. It normalizes common leetspeak substitutions (0->o,
 * 1->i, 3->e, etc.) and strips punctuation before checking, so
 * "n1ce_pu55y" is caught the same as "nice_pussy".
 *
 * Extend BLOCKED_WORDS any time you spot something new getting
 * through — it's just an array, no code changes needed elsewhere.
 */

const BLOCKED_WORDS = [
  // explicit / porn / nudity related
  "porn", "pornhub", "xxx", "nude", "nudes", "naked", "nsfw",
  "boobs", "tits", "titties", "pussy", "vagina", "penis", "dick",
  "cock", "anal", "cum", "milf", "onlyfans", "escort", "hookup",
  "strip", "stripper", "erotic", "fetish", "bdsm", "hentai",
  "camgirl", "camwhore", "sextape", "blowjob", "handjob",
  "masturbate", "orgasm", "horny",
  // slurs / hate / abusive
  "rape", "incest", "pedo", "childporn",
  "nigger", "nigga", "faggot", "retard",
  // general profanity
  "fuck", "fucker", "fucking", "shit", "bitch", "bastard",
  "asshole", "slut", "whore", "cunt",
];

const LEET_MAP = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "$": "s", "@": "a" };

function normalize(text) {
  const lowered = (text || "").toLowerCase();
  const deleeted = lowered.split("").map((ch) => LEET_MAP[ch] || ch).join("");
  return deleeted.replace(/[^a-z0-9]/g, "");
}

function isTextSafe(text) {
  const norm = normalize(text);
  if (!norm) return true;
  return !BLOCKED_WORDS.some((word) => norm.includes(word));
}

/**
 * Validates a username's format AND checks it against the blocklist.
 * Returns { valid: boolean, error?: string, value?: string }
 */
function validateUsernameFormat(username) {
  if (!username || typeof username !== "string") {
    return { valid: false, error: "Username is required." };
  }
  const trimmed = username.trim();

  if (trimmed.length < 3 || trimmed.length > 20) {
    return { valid: false, error: "Username must be 3–20 characters long." };
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(trimmed)) {
    return { valid: false, error: "Username must start with a letter and can only contain letters, numbers, and underscores." };
  }
  if (!isTextSafe(trimmed)) {
    return { valid: false, error: "That username isn't allowed. Please choose another." };
  }
  return { valid: true, value: trimmed };
}

module.exports = { isTextSafe, validateUsernameFormat, normalize };
