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

// One pool per server process (survives Next dev hot-reload via globalThis).
const globalForPg = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForPg.pgPool ??
  new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgresql://cp:cp@localhost:5488/cp_trainer",
    max: 10,
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
