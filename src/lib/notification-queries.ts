import type { DuelMode } from "./arena-rules";
import type { DuelStatus } from "./arena-queries";
import { q } from "./db";

/*
  The inbox. Rows are written by the duels trigger (007_inbox.sql), never
  here: this module only reads them and moves the two timestamps.

  `seen_at` means a tab showed it — a popup, or the bell's list being opened.
  It gates the popup and the loud alert, so a challenge popped in one tab
  does not pop again on the next reload. `read_at` means it is dealt with:
  acted on, dismissed, or listed and closed. The badge counts unread. A live
  challenge stays unread until it is accepted, declined, withdrawn or expired,
  so the badge cannot clear while there is still a decision waiting.
*/

export type NotificationKind =
  | "duel_challenge"
  | "duel_accepted"
  | "duel_declined"
  | "duel_expired"
  | "duel_finished";

export type InboxRow = {
  id: number;
  kind: NotificationKind;
  duel_id: number | null;
  actor_id: number | null;
  actor_name: string | null;
  payload: {
    mode?: DuelMode;
    duration_s?: number;
    bullet_start_rating?: number | null;
    bullet_step?: number | null;
    winner_id?: number | null;
    finish_reason?: "solve" | "forfeit" | "timeout" | null;
    challenger_points?: number;
    opponent_points?: number;
  };
  created_at: string;
  seen_at: string | null;
  read_at: string | null;
  /** Joined from duels, so a challenge row always shows its live state and
      a result can name both sides. */
  duel_status: DuelStatus | null;
  expires_at: string | null;
  challenger_id: number | null;
  opponent_id: number | null;
  challenger_name: string | null;
  opponent_name: string | null;
};

const INBOX_SELECT = `
  select n.id, n.kind, n.duel_id, n.actor_id,
         coalesce(a.display_name, a.github_login) as actor_name,
         n.payload, n.created_at, n.seen_at, n.read_at,
         d.status as duel_status, d.expires_at, d.challenger_id, d.opponent_id,
         coalesce(uc.display_name, uc.github_login) as challenger_name,
         coalesce(uo.display_name, uo.github_login) as opponent_name
  from notifications n
  left join users a on a.id = n.actor_id
  left join duels d on d.id = n.duel_id
  left join users uc on uc.id = d.challenger_id
  left join users uo on uo.id = d.opponent_id`;

export async function listInbox(
  userId: number,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<InboxRow[]> {
  const limit = opts.limit ?? 30;
  // Two shapes rather than one with an unused placeholder: every $N must
  // appear in the text or Postgres refuses the statement.
  return opts.unreadOnly
    ? q<InboxRow>(
        `${INBOX_SELECT}
         where n.user_id = $1 and n.read_at is null
         order by n.id desc limit $2`,
        [userId, limit],
      )
    : q<InboxRow>(
        `${INBOX_SELECT}
         where n.user_id = $1
         order by n.id desc limit $2`,
        [userId, limit],
      );
}

/** One statement per call; ids that aren't the caller's silently no-op. */
export async function markSeen(userId: number, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await q(
    `update notifications set seen_at = coalesce(seen_at, now())
     where user_id = $1 and id = any($2::bigint[]) and seen_at is null`,
    [userId, ids],
  );
}

export async function markRead(userId: number, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await q(
    `update notifications
        set seen_at = coalesce(seen_at, now()), read_at = coalesce(read_at, now())
      where user_id = $1 and id = any($2::bigint[]) and read_at is null`,
    [userId, ids],
  );
}

/** Acting on a duel from anywhere (the Duels tab, not just the bell) must
    clear its challenge from the badge. */
export async function markDuelRead(userId: number, duelId: number): Promise<void> {
  await q(
    `update notifications
        set seen_at = coalesce(seen_at, now()), read_at = coalesce(read_at, now())
      where user_id = $1 and duel_id = $2 and read_at is null`,
    [userId, duelId],
  );
}
