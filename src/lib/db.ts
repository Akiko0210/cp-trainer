import { Pool, types } from "pg";

/*
  Parse int8 (bigint) as a JavaScript number.

  node-postgres returns bigint as a STRING by default, to avoid losing
  precision above 2^53. Every bigint in this schema is a serial id or a count,
  none of which will come near that, and the string default causes a genuinely
  nasty class of bug: an id read through the driver ("4") does not equal the
  same id arriving as JSON from a pg_notify payload (4), so comparisons fail
  silently rather than loudly. That bit the real-time leaderboard — events were
  filtered out against a Set of strings.

  If a table ever needs true 64-bit values, give that column its own parser
  rather than reverting this.
*/
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://cp:cp@localhost:5488/cp_trainer";

/*
  TLS, decided explicitly rather than left to the driver.

  Managed Postgres (Neon, Supabase, a platform addon) hands you a URL ending in
  `?sslmode=require`, and the certificate is signed by a real CA — so verify it.
  `sslmode=no-verify` is the escape hatch for a self-signed cert on a VM you own,
  and it is spelled out in the URL so nobody disables verification by accident.
*/
function sslOption(): { rejectUnauthorized: boolean } | undefined {
  const mode = /[?&]sslmode=([^&]+)/.exec(DATABASE_URL)?.[1];
  if (!mode || mode === "disable") return undefined;
  return { rejectUnauthorized: mode !== "no-verify" };
}

// One pool per server process (survives Next dev hot-reload via globalThis).
const globalForPg = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForPg.pgPool ??
  new Pool({
    connectionString: DATABASE_URL,
    // Free Postgres tiers cap connections tightly and this app runs two
    // processes; a pool that can grow past the cap turns a busy moment into
    // "too many clients already" for everybody.
    max: Number(process.env.PG_POOL_MAX ?? 8),
    // A suspended free-tier database wakes on connect. Wait for it, but not
    // forever — a request that hangs is worse than one that fails.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ssl: sslOption(),
  });
globalForPg.pgPool = pool;

export async function q<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}
