import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stores = [
  ["DB_CORE_URL", "migrations/core/001_training_verification.sql"],
  ["DB_TRAINING_DOCS_URL", "migrations/training-docs/001_training_documents.sql"],
  ["DB_EMPLOYEE_DOCS_URL", "migrations/employee-docs/001_employee_documents.sql"]
];

for (const [variable, relativeFile] of stores) {
  const connectionString = process.env[variable];
  if (!connectionString) throw new Error(`${variable} is required.`);
  const sql = await readFile(path.join(root, relativeFile), "utf8");
  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
  console.log(`${variable} migration complete.`);
}
