const { Pool } = require("pg");
require("dotenv").config();

const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString:            process.env.DATABASE_URL,
  ssl:                         { rejectUnauthorized: false },
  // Back4App free = 256MB RAM — keep pool small to avoid OOM crashes
  max:                         isProduction ? 5 : 3,
  min:                         1,
  idleTimeoutMillis:           60000,
  connectionTimeoutMillis:     5000,
  statement_timeout:           20000,
  keepAlive:                   true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => console.error("❌ DB error:", err.message));

// Warm up on startup
pool.query("SELECT 1")
  .then(() => console.log("✅ DB pool ready"))
  .catch((e) => console.error("❌ DB warmup failed:", e.message));

process.on("SIGINT",  () => pool.end(() => process.exit(0)));
process.on("SIGTERM", () => pool.end(() => process.exit(0)));

module.exports = pool;
