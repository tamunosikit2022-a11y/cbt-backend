-- ── FRIEND REQUEST UNIQUENESS ─────────────────────────────
-- socialController.sendFriendRequest checked for an existing pending
-- request before inserting, but that check-then-insert wasn't atomic — a
-- genuine double-tap/retry could still slip two identical pending rows
-- through the gap between the SELECT and the INSERT. A partial unique
-- index (only applies while status='pending') lets Postgres reject the
-- concurrent duplicate outright, while still allowing normal history
-- (multiple past accepted/rejected rows for the same pair over time,
-- e.g. unfriend-then-re-request) to accumulate freely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_pending_unique
  ON friend_requests(from_id, to_id) WHERE status = 'pending';
