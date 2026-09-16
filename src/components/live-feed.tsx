"use client";

import { useEffect, useMemo, useRef } from "react";
import LocalTime from "./LocalTime";
import { fmtDur } from "./arena-ui";
import { useNotificationOptIn } from "./contest-ui";
import { shortName } from "./guild-ui";
import { armChime, notifyAway } from "@/lib/alerts";
import type { Duel } from "@/lib/arena-queries";
import type { Battle } from "@/lib/battle-queries";

/*
  The live report: what just happened in the race you're in.

  A race is only fun if you find out, now, that the other side solved it, that
  a new problem is up, that you just climbed. The panels already refetch on
  every stream event; the feed is DERIVED from the refetched state by diffing
  timestamped facts (rounds, matches, eliminations, the bell), so two things
  landing in one refetch produce two lines, nothing needs a new table, and a
  reload shows the same history everyone else saw.

  Three ways a line reaches you, in escalating order of interruption: the
  ticker on the page (everything), a toast (things about you, and the few
  that matter to everyone — a new problem, a match ready, the end), and — only
  while you are away (the tab hidden, or the window unfocused because
  Codeforces is in the one beside it) — a browser notification with a short
  chime and a flashed title. That last tier is on by default for anyone in a
  race, once the browser has granted permission (asked for when you accept or
  send a challenge); the toggle turns it off. Detection is the worker's poll,
  so "now" means "within a few seconds"; the copy never promises instant.
*/

export type FeedItem = {
  key: string;
  /** ISO timestamp of the fact, not of when the client noticed it. */
  at: string;
  text: string;
  /** About the viewer: highlighted in the ticker, always toasted. */
  mine: boolean;
  /** Worth a toast even when it isn't about you. */
  loud: boolean;
};

export const ARENA_NOTIFY_KEY = "cp:arena-notify";

const newestFirst = (a: FeedItem, b: FeedItem) =>
  Date.parse(b.at) - Date.parse(a.at) || b.key.localeCompare(a.key);

// ---------------------------------------------------------------------------
// Bullet
// ---------------------------------------------------------------------------

export function bulletFeed(duel: Duel, meId: number): FeedItem[] {
  const items: FeedItem[] = [];
  const iAmChallenger = duel.challenger_id === meId;
  const nameOf = (id: number | null) =>
    shortName({
      display_name: id === duel.challenger_id ? duel.challenger_name : duel.opponent_name,
    });
  const rival = nameOf(iAmChallenger ? duel.opponent_id : duel.challenger_id);
  const mine = iAmChallenger ? duel.challenger_points : duel.opponent_points;
  const theirs = iAmChallenger ? duel.opponent_points : duel.challenger_points;

  if (duel.started_at) {
    items.push({
      key: "start",
      at: duel.started_at,
      text: `Bullet is on — ${fmtDur(duel.duration_s)} on the clock, ladder from ${duel.bullet_start_rating}, +${duel.bullet_step} a round`,
      mine: false,
      loud: false,
    });
  }
  for (const r of duel.rounds ?? []) {
    items.push({
      key: `r${r.round_no}-open`,
      at: r.opened_at,
      text: `Round ${r.round_no} is up · ${r.points} pts · ${r.problem_title}`,
      mine: false,
      loud: true,
    });
    if (r.winner_id !== null && r.won_at) {
      items.push({
        key: `r${r.round_no}-won`,
        at: r.won_at,
        text:
          r.winner_id === meId
            ? `You took round ${r.round_no} (+${r.points})`
            : `${nameOf(r.winner_id)} took round ${r.round_no} — ${r.points} to them`,
        mine: true,
        loud: true,
      });
    }
  }
  if (duel.status === "finished" && duel.finished_at) {
    let text: string;
    if (duel.finish_reason === "forfeit") {
      text = duel.winner_id === meId ? `${rival} conceded — you win` : `You conceded — ${rival} wins`;
    } else if (duel.winner_id === null) {
      text = `Time! A draw, ${mine}–${theirs}`;
    } else if (duel.winner_id === meId) {
      text = `Time! You win ${mine}–${theirs}`;
    } else {
      text = `Time! ${rival} wins ${theirs}–${mine}`;
    }
    items.push({ key: "end", at: duel.finished_at, text, mine: true, loud: true });
  }
  return items.sort(newestFirst);
}

// ---------------------------------------------------------------------------
// Battles
// ---------------------------------------------------------------------------

export function battleFeed(b: Battle, meId: number): FeedItem[] {
  const items: FeedItem[] = [];
  const byId = new Map(b.players.map((p) => [p.user_id, p]));
  const name = (id: number) => shortName(byId.get(id) ?? null);

  if (b.started_at) {
    items.push({
      key: "start",
      at: b.started_at,
      text: "The arena is open — everyone's queued at tier 1",
      mine: false,
      loud: true,
    });
  }
  for (const m of b.matches) {
    const inIt = m.a_id === meId || m.b_id === meId;
    const opp = m.a_id === meId ? m.b_id : m.a_id;
    items.push({
      key: `m${m.id}-start`,
      at: m.started_at,
      text: inIt
        ? `Your match is ready — vs ${name(opp)} at tier ${m.tier}`
        : `${name(m.a_id)} vs ${name(m.b_id)} · tier ${m.tier}`,
      mine: inIt,
      loud: inIt,
    });
    if (m.status === "finished" && m.finished_at) {
      let text: string;
      if (m.finish_reason === "timeout" || m.winner_id === null) {
        text = inIt
          ? `Time — you and ${name(opp)} tie at tier ${m.tier}, both stay`
          : `Time — ${name(m.a_id)} and ${name(m.b_id)} tie at tier ${m.tier}`;
      } else {
        const w = m.winner_id;
        const l = w === m.a_id ? m.b_id : m.a_id;
        const conceded = m.finish_reason === "forfeit";
        if (w === meId) {
          text = conceded
            ? `${name(l)} conceded — you climb to tier ${m.tier + 1}`
            : `AC! You beat ${name(l)} — up to tier ${m.tier + 1}`;
        } else if (l === meId) {
          text = conceded
            ? `You conceded to ${name(w)} — you stay at tier ${m.tier}`
            : `${name(w)} solved it first — you stay at tier ${m.tier}`;
        } else {
          text = conceded
            ? `${name(l)} conceded to ${name(w)} — up to tier ${m.tier + 1}`
            : `${name(w)} beat ${name(l)} at tier ${m.tier} — up to tier ${m.tier + 1}`;
        }
      }
      items.push({ key: `m${m.id}-end`, at: m.finished_at, text, mine: inIt, loud: inIt });
    }
  }
  for (const p of b.players) {
    if (p.state !== "eliminated" || !p.eliminated_at) continue;
    const mine = p.user_id === meId;
    items.push({
      key: `out-${p.user_id}`,
      at: p.eliminated_at,
      text: mine
        ? `You're out — alone at tier ${p.tier}, nobody left to climb to you. Spectating from here.`
        : `${shortName(p)} is out — alone at tier ${p.tier}`,
      mine,
      loud: mine,
    });
  }
  const endedByClock =
    b.status === "closing" ||
    (b.status === "finished" && !!b.finished_at && Date.parse(b.finished_at) >= Date.parse(b.ends_at));
  if (endedByClock) {
    items.push({
      key: "bell",
      at: b.ends_at,
      text: "The bell — no new matches; the ones running finish on their own clocks",
      mine: false,
      loud: true,
    });
  }
  if (b.status === "finished" && b.finished_at) {
    const mine = b.champion_id === meId;
    items.push({
      key: "end",
      at: b.finished_at,
      text: mine
        ? "You win the arena!"
        : b.champion_name
          ? `${shortName({ display_name: b.champion_name })} wins the arena`
          : "The arena is over",
      mine,
      loud: true,
    });
  }
  return items.sort(newestFirst);
}

// ---------------------------------------------------------------------------
// Alerts: toast now; notification + chime + title flash when you're away
// (the escalation itself lives in lib/alerts.ts, shared with the inbox)
// ---------------------------------------------------------------------------

/**
 * Diff the feed against what this tab has already shown and surface the new
 * lines. Mount it only once the data has loaded: the first list seen is the
 * baseline, never a storm of toasts for history.
 */
export function useFeedAlerts(
  items: FeedItem[],
  opts: { push: (text: string) => void; notify: boolean; title: string },
): void {
  const seen = useRef<Set<string> | null>(null);
  const { push, notify, title } = opts;
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(items.map((i) => i.key));
      return;
    }
    const fresh = items
      .filter((i) => !seen.current!.has(i.key))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const i of fresh) {
      seen.current.add(i.key);
      if (!(i.mine || i.loud)) continue;
      push(i.text);
      notifyAway(title, i.text, i.key, { notify });
    }
  }, [items, push, notify, title]);
}

/** The arena's opt-in, shared by bullet, battles and the inbox: one key, one
    answer. On by default once permission exists — a race you agreed to is
    the consent; the toggle is how you take it back. */
export function useArenaAlerts() {
  const optIn = useNotificationOptIn(ARENA_NOTIFY_KEY, { defaultOn: true });
  const toggle = () => {
    armChime();
    void optIn.toggle();
  };
  return useMemo(() => ({ ...optIn, toggle }), [optIn.supported, optIn.enabled, optIn.denied]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function AlertsToggle({
  supported,
  enabled,
  denied,
  toggle,
}: {
  supported: boolean;
  enabled: boolean;
  denied: boolean;
  toggle: () => void;
}) {
  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={denied}
      title={
        denied
          ? "Notifications are blocked for this site in your browser settings."
          : enabled
            ? "Alerts on: a notification and a chime when something happens while you're in another window or tab."
            : "Get a notification and a chime when the other side solves, a new problem is up, or the game ends — while you're in another window or tab."
      }
      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
        enabled
          ? "border-transparent bg-accent text-accent-ink"
          : "border-line text-muted hover:text-ink"
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {denied ? "Alerts blocked" : enabled ? "Alerts on" : "Alert me"}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The ticker
// ---------------------------------------------------------------------------

export function LiveFeed({
  items,
  live,
  max = 30,
}: {
  items: FeedItem[];
  live: boolean;
  max?: number;
}) {
  return (
    <div className="rounded-(--radius-card) border border-line bg-page/70 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
          Live
        </span>
        <span
          className="flex items-center gap-1.5 text-[11px] text-muted"
          title={live ? "Connected — this updates as it happens" : "Reconnecting…"}
        >
          <span
            className={`size-1.5 rounded-full ${live ? "live-dot" : ""}`}
            style={{ backgroundColor: live ? "var(--accent)" : "var(--muted)" }}
          />
          {live ? "checked every few seconds" : "offline"}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted">Nothing yet — it all shows up here.</p>
      ) : (
        <ol className="max-h-64 space-y-1 overflow-y-auto">
          {items.slice(0, max).map((i) => (
            <li
              key={i.key}
              className={`feed-in flex gap-2 text-sm ${i.mine ? "font-medium" : "text-muted"}`}
            >
              <span className="num shrink-0 pt-0.5 text-[11px] text-muted/80">
                <LocalTime iso={i.at} mode="time" />
              </span>
              <span className="min-w-0">{i.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
