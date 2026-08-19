/**
 * profanityFilter.js — Scholars Syndicate
 * ─────────────────────────────────────────────────────────
 * Shared bad-word filter for anywhere students can post free text that
 * other students will see (Community Chat, Squad Chat, etc).
 *
 * Approach:
 *  - Block a small list of slurs/hate terms outright (message rejected).
 *  - Censor common swear words by replacing them with asterisks so chat
 *    stays usable (a message isn't nuked over one swear word), while
 *    still keeping the room clean for younger students.
 *  - Each letter in a word is matched against itself PLUS its common
 *    leetspeak stand-ins (a/@/4, e/3, i/1/!, o/0, s/$/5), and repeated
 *    letters are allowed ("fuuuck"), so simple evasion doesn't slip
 *    through — matching happens directly against the original text, no
 *    normalize-then-map-indices-back step (that class of bug is why an
 *    earlier version of this filter never actually caught leetspeak).
 *  - Matches require a real word boundary on both sides (with a small
 *    allow-list of common suffixes like -ing/-er/-s) specifically to
 *    avoid the classic false-positive where a short word like "hell" or
 *    "ass" is actually just a substring of an innocent word ("hello",
 *    "assignment", "class", "grass").
 *
 * This is a pragmatic filter, not a perfect one — it's meant to keep a
 * student chat room civil, not to be a security boundary.
 */

const LEET = {
  a: 'a@4', e: 'e3', i: 'i1!', o: 'o0', s: 's$5', t: 't7',
};

// Words that get censored (masked) rather than blocking the whole message.
const CENSOR_WORDS = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'piss',
  'crap', 'damn', 'hell', 'douche', 'twat', 'wank', 'bollocks',
  'prick', 'slut', 'whore', 'cunt', 'motherfucker', 'fucker',
];

// Words/phrases severe enough (slurs, hate speech) that the whole
// message is rejected instead of just censored.
const BLOCK_WORDS = [
  'nigger', 'nigga', 'faggot', 'retard', 'chink', 'spic', 'tranny',
  'kike', 'coon',
];

// Suffixes allowed right after the base word before requiring a boundary
// (so "fucking", "shitty", "bitches" match, but "hello" still doesn't
// match "hell").
const SUFFIX = '(?:s|es|ing|er|ers|y|ed)?';

function letterClass(ch) {
  const variants = LEET[ch] || ch;
  const escaped = variants.split('').map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return `[${escaped}]`;
}

function wordPattern(word) {
  // Each letter -> its char class, each letter can repeat 1+ times
  // (handles "fuuuck", "shiiiit").
  const letters = word.split('').map(ch => `${letterClass(ch)}+`).join('');
  return `\\b${letters}${SUFFIX}\\b`;
}

function buildRegex(words) {
  const pattern = words.map(wordPattern).join('|');
  return new RegExp(pattern, 'gi');
}

/**
 * Checks a message for hard-blocked slurs/hate speech.
 * Returns true if the message should be rejected outright.
 * NOTE: builds a fresh regex per call — regexes with the /g flag are
 * stateful (lastIndex), so reusing one module-level instance across
 * repeated calls to .test()/.match() would intermittently miss matches.
 */
function containsBlockedContent(text) {
  if (!text) return false;
  return buildRegex(BLOCK_WORDS).test(text);
}

/**
 * Censors swear words in a message, replacing all but the first letter
 * of each match with asterisks. Leaves the rest of the message untouched.
 */
function censor(text) {
  if (!text) return text;
  return text.replace(buildRegex(CENSOR_WORDS), (match) => {
    if (match.length <= 1) return match;
    return match[0] + '*'.repeat(match.length - 1);
  });
}

/**
 * Main entry point. Call before saving any chat message.
 * Returns { ok: boolean, cleaned: string, reason?: string }
 */
function moderateMessage(text) {
  if (!text || !text.trim()) {
    return { ok: false, cleaned: '', reason: 'Message cannot be empty.' };
  }
  if (containsBlockedContent(text)) {
    return {
      ok: false,
      cleaned: '',
      reason: 'Your message contains language that is not allowed here. Please rephrase and try again.',
    };
  }
  return { ok: true, cleaned: censor(text) };
}

module.exports = { moderateMessage, censor, containsBlockedContent };
