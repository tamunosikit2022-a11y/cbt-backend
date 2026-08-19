/**
 * normalizeSchoolName.js
 *
 * BUG FIX: students were being split into different school groups (Factions,
 * School Wars, school leaderboards) purely because they typed their school
 * name with different casing at registration — "uniport", "Uniport" and
 * "UNIPORT" were three different rows to every GROUP BY / WHERE school_name
 * query in the app, so classmates couldn't find each other.
 *
 * This does NOT try to resolve "UNILAG" vs "University of Lagos" (that's a
 * much bigger aliasing problem — different strings, not just different
 * case) — it only guarantees that the exact same name, typed in any casing
 * or with stray whitespace, always collapses to one canonical value.
 *
 * Canonical form: trimmed, internal whitespace collapsed to a single space,
 * upper-cased. Uppercase was chosen (rather than Title Case) because most
 * Nigerian students already type their school as an acronym (UNIPORT, LASU,
 * FUNAAB) and mixed-case Title Casing of acronyms looks wrong ("Uniport"
 * reads oddly for a name everyone treats as an initialism).
 */
function normalizeSchoolName(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  return cleaned.toUpperCase();
}

module.exports = { normalizeSchoolName };
