require("dotenv").config();
const { Pool } = require("pg");

const tableName = process.argv[2];
if (!tableName) {
  console.error("Usage: node scripts/inspect-table.js <table_name>");
  process.exit(1);
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const { rows } = await pool.query(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_name = $1
     ORDER BY ordinal_position`,
    [tableName]
  );

  if (rows.length === 0) {
    console.log(`No table named "${tableName}" found (or it has no columns).`);
  } else {
    console.log(`Columns in "${tableName}":`);
    rows.forEach(r => console.log(`  - ${r.column_name} (${r.data_type}, nullable: ${r.is_nullable})`));
  }

  await pool.end();
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
