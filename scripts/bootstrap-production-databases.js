import pg from "pg";

const required = ["POSTGRES_ADMIN_URL", "NEW_POSTGRES_PASSWORD", "NEW_CORE_PASSWORD", "NEW_TRAINING_DOCS_PASSWORD", "NEW_EMPLOYEE_DOCS_PASSWORD"];
for (const name of required) if (!process.env[name]) throw new Error(`${name} is required for secure bootstrap.`);

const roles = [
  ["sr_core", process.env.NEW_CORE_PASSWORD],
  ["sr_training_docs", process.env.NEW_TRAINING_DOCS_PASSWORD],
  ["sr_employee_docs", process.env.NEW_EMPLOYEE_DOCS_PASSWORD]
];
const databases = [
  ["sevenroots_core", "sr_core"],
  ["sevenroots_training_docs", "sr_training_docs"],
  ["sevenroots_employee_docs", "sr_employee_docs"]
];
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

const client = new pg.Client({ connectionString: process.env.POSTGRES_ADMIN_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  for (const [role, password] of roles) {
    await client.query(`DO $bootstrap$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(role)}) THEN EXECUTE 'CREATE ROLE ${role} LOGIN'; END IF; END $bootstrap$;`);
    await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${literal(password)}`);
  }
  for (const [database, owner] of databases) {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE ${database} OWNER ${owner}`);
    else await client.query(`ALTER DATABASE ${database} OWNER TO ${owner}`);
  }
  const roleCount = await client.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname = ANY($1)", [roles.map(([role]) => role)]);
  const databaseCount = await client.query("SELECT count(*)::int AS count FROM pg_database WHERE datname = ANY($1)", [databases.map(([database]) => database)]);
  if (roleCount.rows[0].count !== 3 || databaseCount.rows[0].count !== 3) throw new Error("Database bootstrap verification failed.");
  await client.query(`ALTER ROLE postgres PASSWORD ${literal(process.env.NEW_POSTGRES_PASSWORD)}`);
  console.log("Secure database bootstrap and credential rotation passed.");
} finally {
  await client.end();
}
