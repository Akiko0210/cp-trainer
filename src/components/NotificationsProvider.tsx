"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fmtDur } from "./arena-ui";
import { useGuildLive } from "./GuildLive";
import { shortName } from "./guild-ui";
import { useArenaAlerts } from "./live-feed";
import NotificationPopups from "./NotificationPopups";
import { armChime, notifyAway, requestNotifyPermission } from "@/lib/alerts";
import type { InboxRow } from "@/lib/notification-queries";

/*
  The inbox, held once for the whole app.

  A challenge used to be visible on the Duels tab and nowhere else. This
  provider is what changes that: it is seeded with the viewer's unread rows
  from the server (so a challenge waiting when you sign in is on screen with
  the first paint), refetches when the live stream says a row was addressed
  to you — or when a duel you have a row for moved, which is how you learn a
  challenge was withdrawn — and decides what pops.

  It rides the one stream GuildLive already holds: no second connection, no
  polling, and the hidden-tab park is untouched. A tab that comes back after
  parking refetches on reconnect (the `version` bump) and pops whatever is
  new and still live. What it cannot do is reach a tab that is parked, or a
  browser that is closed; that is what the persistent rows are for.

  Two timestamps, two meanings. `seen_at`: a tab showed it — popped, or
  listed in the bell — and it will not pop again elsewhere. `read_at`: dealt
  with. The badge counts unread, and a live challenge stays unread until it
  is answered, withdrawn or expired, so the badge cannot go quiet while a
  decision is waiting.
*/

export type Inbox = {
  meId: number;
  rows: InboxRow[];
  unread: number;
  popups: InboxRow[];
  refresh: () => Promise<void>;
  markSeen: (ids: number[]) => void;
  markRead: (ids: number[]) => void;
  act: (row: InboxRow, action: "accept" | "decline") => Promise<string | null>;
  alerts: ReturnType<typeof useArenaAlerts>;
};

const Ctx = createContext<Inbox | null>(null);

export function useInbox(): Inbox | null {
  return useContext(Ctx);
}

/** A challenge you can still answer. */
export function isLiveChallenge(r: InboxRow, nowMs: number): boolean {
  return (
    r.kind === "duel_challenge" &&
    r.duel_status === "pending" &&
    r.expires_at !== null &&
    Date.parse(r.expires_at) > nowMs
  );
}

/** One line and a detail, for the popup, the bell and the OS notification. */
export function describe(r: InboxRow, meId: number): { title: string; body: string } {
  const actor = shortName({ display_name: r.actor_name });
  const iAmChallenger = r.challenger_id === meId;
  const rival = shortName({
    display_name: iAmChallenger ? r.opponent_name : r.challenger_name,
  });
  const p = r.payload;
  const modeLine =
    p.mode === "bullet"
      ? `Bullet · ${fmtDur(p.duration_s ?? 0)} · from ${p.bullet_start_rating}, +${p.bullet_step} a round`
      : "Classic · same problem for both, first AC wins";

  switch (r.kind) {
    case "duel_challenge":
      switch (r.duel_status) {
        case "pending":
          return { title: `${actor} challenges you`, body: modeLine };
        case "cancelled":
          return { title: `${actor} withdrew the challenge`, body: modeLine };
        case "expired":
          return {
            title: `${actor}'s challenge expired`,
            body: "Five minutes went by unanswered. Challenge them back?",
          };
        case "declined":
          return { title: `You declined ${actor}`, body: modeLine };
        default:
          return { title: `You accepted ${actor}'s challenge`, body: modeLine };
      }
    case "duel_accepted":
      return {
        title: `${actor} accepted — the race is on`,
        body: p.mode === "bullet" ? "Bullet. Head to Duels." : "Classic. Head to Duels.",
      };
    case "duel_declined":
      return { title: `${actor} declined your challenge`, body: "Maybe later." };
    case "duel_expired":
      return {
        title: `${rival} didn't answer in time`,
        body: "Your challenge expired after five minutes.",
      };
    case "duel_finished": {
      const draw = p.winner_id === null || p.winner_id === undefined;
      const won = p.winner_id === meId;
      const score =
        p.mode === "bullet"
          ? iAmChallenger
            ? `${p.challenger_points ?? 0}–${p.opponent_points ?? 0}`
            : `${p.opponent_points ?? 0}–${p.challenger_points ?? 0}`
          : null;
      const how =
        p.finish_reason === "forfeit"
          ? won
            ? `${rival} conceded`
            : "you conceded"
          : p.finish_reason === "timeout"
            ? p.mode === "bullet"
              ? "at the bell"
              : "time ran out"
            : "first AC";
      const title = draw ? `Draw with ${rival}` : won ? `You beat ${rival}` : `${rival} beat you`;
      return { title, body: score ? `${score} · ${how}` : how };
    }
  }
}

const MAX_POPUPS = 3;

export default function NotificationsProvider({
  meId,
  initial,
  enabled,
  children,
}: {
  meId: number;
  /** The viewer's unread rows, from the layout: on screen with first paint. */
  initial: InboxRow[];
  /** False with no guild: nothing to receive, nothing rendered. */
  enabled: boolean;
  children: React.ReactNode;
}) {
  const { version, last, seq } = useGuildLive();
  const alerts = useArenaAlerts();
  const alertsRef = useRef(alerts.enabled);
  useEffect(() => {
    alertsRef.current = alerts.enabled;
  }, [alerts.enabled]);

  const [rows, setRows] = useState<InboxRow[]>(initial);
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // The shown-on-login path: a challenge still live that no tab has shown
  // pops with the first render. Everything else on the page load waits in
  // the bell.
  const [popupIds, setPopupIds] = useState<number[]>(() => {
    const nowMs = Date.now();
    return initial
      .filter((r) => !r.seen_at && !r.read_at && isLiveChallenge(r, nowMs))
      .map((r) => r.id);
  });
  // Rows this tab has already popped, and the highest id it had at the last
  // look: anything above it is new, anything at or below is history.
  const popped = useRef<Set<number>>(new Set(popupIds));
  const baseline = useRef(initial.reduce((m, r) => Math.max(m, r.id), 0));

  // The two timestamps move in one request per tick, not one per row.
  const pendingMarks = useRef({ seen: new Set<number>(), read: new Set<number>() });
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    flushTimer.current = null;
    const { seen, read } = pendingMarks.current;
    if (seen.size === 0 && read.size === 0) return;
    const body = JSON.stringify({ seen: [...seen], read: [...read] });
    seen.clear();
    read.clear();
    void fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => {});
  }, []);
  const schedule = useCallback(() => {
    if (!flushTimer.current) flushTimer.current = setTimeout(flush, 0);
  }, [flush]);

  const markSeen = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      const at = new Date().toISOString();
      setRows((rs) =>
        rs.map((r) => (ids.includes(r.id) && !r.seen_at ? { ...r, seen_at: at } : r)),
      );
      for (const id of ids) pendingMarks.current.seen.add(id);
      schedule();
    },
    [schedule],
  );

  const markRead = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      const at = new Date().toISOString();
      setRows((rs) =>
        rs.map((r) =>
          ids.includes(r.id) && !r.read_at
            ? { ...r, seen_at: r.seen_at ?? at, read_at: at }
            : r,
        ),
      );
      setPopupIds((ps) => ps.filter((id) => !ids.includes(id)));
      for (const id of ids) pendingMarks.current.read.add(id);
      schedule();
    },
    [schedule],
  );

  /*
    What pops, decided as each fetch lands: any row newer than the last look
    that is still unread — and, for a challenge, still live. A challenge that
    died between being written and being fetched (withdrawn in the same
    second) is marked handled without a card. A popped challenge whose duel
    has since moved on is filtered out of the stack below rather than
    written back: its row is news now ("X withdrew"), and news is what the
    bell is for.
  */
  const ingest = useCallback(
    (next: InboxRow[]) => {
      setRows(next);
      const nowMs = Date.now();
      const fresh: InboxRow[] = [];
      let maxId = baseline.current;
      for (const r of next) {
        maxId = Math.max(maxId, r.id);
        if (r.id <= baseline.current || popped.current.has(r.id) || r.read_at) continue;
        popped.current.add(r.id);
        if (r.kind === "duel_challenge" && !isLiveChallenge(r, nowMs)) continue;
        fresh.push(r);
      }
      baseline.current = maxId;
      if (fresh.length === 0) return;
      fresh.sort((a, b) => a.id - b.id);
      setPopupIds((ps) => [...fresh.map((r) => r.id).reverse(), ...ps].slice(0, MAX_POPUPS));
      markSeen(fresh.map((r) => r.id));
      for (const r of fresh) {
        const d = describe(r, meId);
        notifyAway(d.title, d.body, `inbox-${r.id}`, { notify: alertsRef.current });
      }
    },
    [markSeen, meId],
  );

  const inflight = useRef(false);
  const again = useRef(false);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    // A burst of events collapses to at most one fetch in flight and one
    // more queued behind it.
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    try {
      do {
        again.current = false;
        const res = await fetch("/api/notifications");
        if (res.ok) {
          const data = (await res.json()) as { rows: InboxRow[] };
          ingest(data.rows);
        }
      } while (again.current);
    } catch {
      // Transient: the next event or version bump retries.
    } finally {
      inflight.current = false;
    }
  }, [enabled, ingest]);

  // The rows popped at page load were never told to the server or the
  // viewer: do both now, once.
  useEffect(() => {
    if (!enabled || popupIds.length === 0) return;
    for (const id of popupIds) pendingMarks.current.seen.add(id);
    schedule();
    for (const id of popupIds) {
      const r = rowsRef.current.find((x) => x.id === id);
      if (!r) continue;
      const d = describe(r, meId);
      notifyAway(d.title, d.body, `inbox-${r.id}`, { notify: alertsRef.current });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Every version bump — including the one a reconnect or an unparked tab
  // makes — is a chance something addressed to us was missed.
  const firstVersion = useRef(true);
  useEffect(() => {
    if (firstVersion.current) {
      firstVersion.current = false;
      return;
    }
    void refresh();
  }, [version, refresh]);

  // Addressed to us, or about a duel we hold a row for: refetch now, ahead
  // of the coalesced version bump.
  useEffect(() => {
    if (seq === 0 || !last) return;
    const mine =
      (last.type === "inbox" && Number(last.recipient_id) === meId) ||
      (last.type === "duel" &&
        rowsRef.current.some((r) => r.duel_id === Number(last.duel_id)));
    if (mine) void refresh();
  }, [seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // A reload leaves the chime unarmed until a gesture; take the first one.
  useEffect(() => {
    if (!enabled || !alerts.enabled) return;
    const arm = () => armChime();
    window.addEventListener("pointerdown", arm, { once: true });
    return () => window.removeEventListener("pointerdown", arm);
  }, [enabled, alerts.enabled]);

  const act = useCallback(
    async (row: InboxRow, action: "accept" | "decline"): Promise<string | null> => {
      // Inside the click, before any await: this is the gesture that turns
      // the loud alerts on for the race that is about to start.
      armChime();
      requestNotifyPermission();
      if (row.duel_id === null) return "Nothing to act on.";
      try {
        const res = await fetch(`/api/guild/duels/${row.duel_id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) {
          void refresh();
          return data?.error ?? "That didn't work.";
        }
        markRead([row.id]);
        void refresh();
        return null;
      } catch {
        return "That didn't work.";
      }
    },
    [markRead, refresh],
  );

  const popups = useMemo(
    () =>
      popupIds
        .map((id) => rows.find((r) => r.id === id))
        .filter(
          (r): r is InboxRow =>
            !!r &&
            !r.read_at &&
            (r.kind !== "duel_challenge" || r.duel_status === "pending"),
        ),
    [popupIds, rows],
  );
  const unread = useMemo(() => rows.filter((r) => !r.read_at).length, [rows]);

  const value = useMemo<Inbox>(
    () => ({ meId, rows, unread, popups, refresh, markSeen, markRead, act, alerts }),
    [meId, rows, unread, popups, refresh, markSeen, markRead, act, alerts],
  );

  if (!enabled) return <>{children}</>;
  return (
    <Ctx.Provider value={value}>
      {children}
      <NotificationPopups />
    </Ctx.Provider>
  );
}
