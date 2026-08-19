/**
 * Centralized 500-error response helper — Scholars Syndicate
 * ─────────────────────────────────────────────────────────
 * Every catch block in this app used to do:
 *   res.status(500).json({ error: err.message })
 *
 * That sends the RAW error straight to the browser — for Postgres errors
 * that includes real table names, column names, and constraint names
 * (e.g. 'duplicate key value violates unique constraint "students_email_key"',
 * 'column "toke_balance" does not exist'). Anyone with dev tools open can
 * read that off the Network tab and use it to map out the schema.
 *
 * In production this now sends a generic message instead, and logs the
 * real error server-side where only you can see it. In development the
 * real message still comes through so debugging isn't harder.
 */
const isProd = process.env.NODE_ENV === 'production';

function serverError(res, err, fallback = 'Something went wrong. Please try again.') {
  console.error(err);
  return res.status(500).json({ error: isProd ? fallback : err.message });
}

module.exports = { serverError };
