#!/usr/bin/env node
/*
  Apply the schema to whatever DATABASE_URL points at.

  Deploys can't shell out to psql — the container doesn't have it and the
  platform's build image usually doesn't either — so this does the same job
  with the pg driver the app already depends on.

  schema.sql is the canonical, idempotent definition and runs every time.
  db/migrations/* then run once each, in filename order, recorded in
  schema_migrations so a re-deploy doesn't replay them. Every statement of a
  given file shares one transaction: a migration that fails half way leaves
  nothing behind to reason about.

  Usage:  DATABASE_URL=… node scripts/migrate.mjs
*/
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

// Same TLS rule as the app (src/lib/db.ts): verify unless the URL says not to.
const mode = /[?&]sslmode=([^&]+)/.exec(url)?.[1];
const ssl =
  !mode || mode === "disable" ? undefined : { rejectUnauthorized: mode !== "no-verify" };

const client = new pg.Client({ connectionString: url, ssl });

const redacted = url.replace(/:\/\/[^@]*@/, "://***@");
console.log(`→ ${redacted}`);

await client.connect();

try {
  console.log("· schema.sql");
  await client.query("begin");
  await client.query(readFileSync(join(root, "db/schema.sql"), "utf8"));
  await client.query("commit");
} catch (e) {
  await client.query("rollback");
  console.error("schema.sql failed:", e.message);
  process.exit(1);
}

await client.query(`
  create table if not exists schema_migrations (
    filename   text primary key,
    applied_at timestamptz not null default now()
  )`);

const dir = join(root, "db/migrations");
const files = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  : [];

for (const file of files) {
  const { rowCount } = await client.query(
    "select 1 from schema_migrations where filename = $1",
    [file],
  );
  if (rowCount > 0) {
    console.log(`· ${file} (already applied)`);
    continue;
  }
  console.log(`· ${file}`);
  try {
    await client.query("begin");
    await client.query(readFileSync(join(dir, file), "utf8"));
    await client.query("insert into schema_migrations (filename) values ($1)", [file]);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    console.error(`${file} failed:`, e.message);
    process.exit(1);
  }
}

const { rows } = await client.query(
  `select count(*)::int as tables from information_schema.tables
    where table_schema = 'public'`,
);
console.log(`✓ up to date — ${rows[0].tables} tables`);
await client.end();
