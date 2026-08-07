import type { PoolClient } from "pg";
import { pool } from "@/lib/db";

/*
  Binding and unbinding a Codeforces handle.

  The mirror, the mastery table and the ability fit are all statements about
  ONE handle's judge history. When the account stops being backed by that
  handle — unbind, or rebind to a different one — they have to go with it:
  keeping them would merge two people's histories under one user_id with no
  way to tell the rows apart afterwards, and a stale sync cursor would make
  the new handle's older pages silently unreachable (see _persist_cursor in
  worker/sync.py).

  What survives is everything the user asserted themselves rather than the
  judge: attempts, mistake tags, ICPC sessions, and source='manual'
  submissions (Kattis solves recorded by the app's own timer).

  The worker guards the other half of this race: a walk already in flight for
  the old handle re-checks the binding before each page it writes.
*/

async function purgeMirror(client: PoolClient, userId: number): Promise<void> {
  await client.query(
    "delete from submissions where user_id = $1 and source = 'cf_api'",
    [userId],
  );
  // Derived from submissions; recomputed from whatever remains on the next
  // sync after a rebind. Left deleted rather than stale-but-plausible.
  await client.query("delete from topic_mastery where user_id = $1", [userId]);
  // Deleted, not zeroed: a fresh bind must start a full walk from page one.
  await client.query(
    "delete from sync_state where user_id = $1 and source = 'cf_api'",
    [userId],
  );
  await client.query(
    `update users set ability_estimate = null, ability_se = null,
                      selection_offset = null
     where id = $1`,
    [userId],
  );
}

async function tx(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await fn(client);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export type CfHandleInfo = {
  handle: string;
  rating: number | null;
  maxRating: number | null;
  rank: string | null;
};

/*
  Attach a (validated) handle. Rebinding to a different handle purges the old
  one's mirror first; re-linking the same handle — CF handles are
  case-insensitive — just refreshes the rating fields.
*/
export async function bindCf(
  userId: number,
  info: CfHandleInfo,
  previousHandle: string | null,
): Promise<void> {
  await tx(async (client) => {
    if (
      previousHandle &&
      previousHandle.toLowerCase() !== info.handle.toLowerCase()
    ) {
      await purgeMirror(client, userId);
    }
    await client.query(
      `update users set cf_handle = $1, cf_rating = $2, cf_max_rating = $3,
                        cf_rank = $4
       where id = $5`,
      [info.handle, info.rating, info.maxRating, info.rank, userId],
    );
  });
}

export async function unbindCf(userId: number): Promise<void> {
  await tx(async (client) => {
    await purgeMirror(client, userId);
    await client.query(
      `update users set cf_handle = null, cf_rating = null,
                        cf_max_rating = null, cf_rank = null
       where id = $1`,
      [userId],
    );
  });
}
