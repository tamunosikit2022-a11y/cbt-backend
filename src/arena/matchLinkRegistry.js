/**
 * src/arena/matchLinkRegistry.js
 * ─────────────────────────────────────────────────────────
 * FIX: tournamentController.submitMatchResult and
 * schoolWarsEngine.war:record_result were (even after being locked down
 * to require the caller be a real participant/captain) still fundamentally
 * a SELF-REPORT — two colluding players could agree on a fake result and
 * there was no independent signal confirming who actually won the real
 * Arena match that was supposed to decide it.
 *
 * arenaEngine.js's endGame() already computes the true winner from
 * room.scores, which is now fully trustworthy (every point in it traces
 * back to a submit_answer call bound to a JWT-verified student, after
 * this session's socket-auth fixes). This registry lets tournament/
 * school-wars code register "this Arena room code belongs to this
 * tournament match / this war round" at the moment they hand out the
 * room code, so endGame() can look up the link when the match finishes
 * and drive the result itself — no client request involved at all for
 * the primary path.
 *
 * The old client-facing socket endpoints (submitMatchResult,
 * war:record_result) are kept as a manual fallback for edge cases (e.g.
 * a room that never reaches endGame for some reason) — they still carry
 * their own participant/captain checks from the previous fix, just with
 * the same weaker "self-report" guarantee as before. The registry path
 * is the trustworthy one and takes priority: if a link exists,
 * arenaEngine calls the result in directly and the manual endpoint has
 * nothing left to do (the match is already marked done).
 */
const links = new Map(); // roomCode -> { type, ...payload }

function registerLink(roomCode, payload) {
  links.set(roomCode, payload);
  // Links are one-shot and time-bounded — a room that's never played
  // (host never starts, players never join) shouldn't leak memory forever.
  setTimeout(() => links.delete(roomCode), 4 * 60 * 60 * 1000);
}

function consumeLink(roomCode) {
  const link = links.get(roomCode);
  if (link) links.delete(roomCode);
  return link || null;
}

module.exports = { registerLink, consumeLink };
