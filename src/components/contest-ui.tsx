"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/*
  Shared pieces for every contest surface: the dashboard card and /contests.
  Both show the same rows and offer the same reminder, so the clock, the
  notification scheduling and the platform marks live here rather than being
  written twice and drifting.
*/

// ---------------------------------------------------------------------------
// Platform marks
//
// A 2-letter monogram would have been less work, but a shape is read without
// being parsed, which is the whole point of putting a judge's identity in
// 18px of gutter instead of in the row's text.
//
// The tints are deliberately NOT the judges' brand colours. Codeforces red,
// LeetCode orange and HackerRank green would collide head-on with the one
// colour rule this app has — green/red/amber mean AC/WA/TLE and nothing else
// (AGENTS.md) — and a red badge beside a red verdict badge reads as a verdict.
// So each judge gets the nearest hue from the category palette instead, which
// is already tuned for both themes.
// ---------------------------------------------------------------------------

type Mark = { color: string; glyph: React.ReactNode };

const BARS = (
  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden fill="currentColor">
    <rect x="0" y="4" width="3" height="8" rx="1" />
    <rect x="4.5" y="1.5" width="3" height="10.5" rx="1" />
    <rect x="9" y="6" width="3" height="6" rx="1" />
  </svg>
);

const HAT = (
  <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden fill="currentColor">
    <path d="M2.4 5.6a2 2 0 1 1 1.3-3.4 2.2 2.2 0 0 1 4.6 0 2 2 0 1 1 1.3 3.4v.6H2.4v-.6Z" />
    <rect x="2.4" y="7.2" width="7.2" height="2.6" rx="0.8" />
  </svg>
);

const CHEVRON = (
  <svg
    viewBox="0 0 12 12"
    width="11"
    height="11"
    aria-hidden
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M6.6 1.8 3 5.9l3.6 4.3" />
    <path d="M9.2 10.2H5.4" />
  </svg>
);

function letter(ch: string) {
  return <span className="text-[10px] font-bold leading-none">{ch}</span>;
}

const MARKS: Record<string, Mark> = {
  codeforces: { color: "var(--cat-math)", glyph: BARS },
  atcoder: { color: "var(--cat-fundamentals)", glyph: letter("A") },
  codechef: { color: "var(--cat-strings)", glyph: HAT },
  leetcode: { color: "var(--cat-dp)", glyph: CHEVRON },
  usaco: { color: "var(--cat-geometry)", glyph: letter("U") },
  topcoder: { color: "var(--cat-graphs)", glyph: letter("T") },
  hackerrank: { color: "var(--cat-flow)", glyph: letter("H") },
  yukicoder: { color: "var(--cat-fundamentals)", glyph: letter("Y") },
};

export function PlatformMark({
  platform,
  size = 20,
}: {
  platform: string;
  size?: number;
}) {
  const mark = MARKS[platform.toLowerCase()] ?? {
    color: "var(--cat-fundamentals)",
    glyph: letter(platform.slice(0, 1).toUpperCase()),
  };
  return (
    <span
      title={platform}
      aria-label={platform}
      role="img"
      className="grid shrink-0 place-items-center rounded-[6px]"
      style={{
        width: size,
        height: size,
        color: mark.color,
        backgroundColor: `color-mix(in oklab, ${mark.color} 15%, transparent)`,
      }}
    >
      {mark.glyph}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function countdown(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${String(m % 60).padStart(2, "0")}m`;
  if (m > 0) return `in ${m}m`;
  return "starting";
}

export function durationLabel(s: number): string {
  const h = Math.floor(s / 3600);
  // Marathon formats (the two-week ICPC online challenges) read in days;
  // "336h" is a sum, not a duration anyone can picture.
  if (h >= 48) return `${Math.round(h / 24)}d`;
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// The clock
//
// A countdown depends on the viewer's clock, so the server snapshot is null —
// callers render absolute times until hydration and countdowns right after.
// The interval only runs while something subscribes, and a backgrounded tab
// (where intervals are throttled) is caught up by the visibility listener.
// ---------------------------------------------------------------------------

const TICK_MS = 30 * 1000;

let nowMs: number | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  nowMs = Date.now();
  listeners.forEach((notify) => notify());
}

function onVisible() {
  if (document.visibilityState === "visible") tick();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    nowMs = Date.now();
    timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

/** Milliseconds since epoch, refreshed every 30s. `null` until hydrated. */
export function useNowMs(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => nowMs,
    () => null,
  );
}

// ---------------------------------------------------------------------------
// Reminders
//
// A Web Notification fired NOTIFY_LEAD_MS before the start, scheduled with
// plain setTimeout — so it only fires while a trainer tab is open. That
// constraint is accepted rather than papered over: real push needs a service
// worker, a push service and server-side device rows, all to duplicate what
// each judge's own calendar subscription already does better. This covers the
// case the app is actually in — you are grinding in one tab and would
// otherwise miss the round starting.
// ---------------------------------------------------------------------------

const NOTIFY_LEAD_MS = 15 * 60 * 1000;
// setTimeout's delay is a signed 32-bit int; a longer delay fires immediately.
// A contest that far out gets scheduled on a later visit instead.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const ENABLED_KEY = "cp:contest-notify";
const FIRED_PREFIX = "cp:contest-notified:";
const firedKey = (id: number) => `${FIRED_PREFIX}${id}`;

export type Remindable = {
  id: number;
  name: string;
  url: string;
  platform: string;
  starts_at_ms: number;
};

export function useContestReminders(contests: Remindable[]) {
  const now = useNowMs();
  // Permission and the opt-in flag are read straight from the browser during
  // render (guarded to post-hydration by `now`); state exists only so the
  // toggle can move them without a reload.
  const [override, setOverride] = useState<{
    enabled: boolean;
    denied: boolean;
  } | null>(null);

  const supported = now !== null && "Notification" in window;
  const denied = override?.denied ?? (supported && Notification.permission === "denied");
  const enabled =
    override?.enabled ??
    (supported &&
      Notification.permission === "granted" &&
      localStorage.getItem(ENABLED_KEY) === "1");

  useEffect(() => {
    if (!enabled) return;

    // Prune fired-markers for contests no longer listed, so the store doesn't
    // grow one key per contest forever.
    const listed = new Set(contests.map((c) => firedKey(c.id)));
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(FIRED_PREFIX) && !listed.has(key)) {
        localStorage.removeItem(key);
      }
    }

    const timers = contests.flatMap((c) => {
      if (localStorage.getItem(firedKey(c.id))) return [];
      if (c.starts_at_ms <= Date.now()) return [];
      // Inside the lead window already (page opened 10 minutes before the
      // round): fire now rather than never.
      const delay = Math.max(0, c.starts_at_ms - NOTIFY_LEAD_MS - Date.now());
      if (delay > MAX_TIMEOUT_MS) return [];
      return [
        setTimeout(() => {
          localStorage.setItem(firedKey(c.id), "1");
          const minutes = Math.max(
            1,
            Math.round((c.starts_at_ms - Date.now()) / 60_000),
          );
          const n = new Notification(c.name, {
            body: `Starts in ${minutes} min on ${c.platform}.`,
            tag: firedKey(c.id), // one banner even if two tabs race the marker
          });
          n.onclick = () => {
            window.focus();
            window.open(c.url, "_blank", "noopener");
          };
        }, delay),
      ];
    });
    return () => timers.forEach(clearTimeout);
  }, [enabled, contests]);

  const toggle = async () => {
    if (enabled) {
      localStorage.setItem(ENABLED_KEY, "0");
      setOverride({ enabled: false, denied: false });
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") localStorage.setItem(ENABLED_KEY, "1");
    setOverride({
      enabled: permission === "granted",
      denied: permission === "denied",
    });
  };

  return { supported, enabled, denied, toggle };
}

export function ReminderToggle({
  supported,
  enabled,
  denied,
  toggle,
  className = "",
}: {
  supported: boolean;
  enabled: boolean;
  denied: boolean;
  toggle: () => void;
  className?: string;
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
            ? "Reminders on: a notification 15 minutes before each round, while a tab is open."
            : "Get a notification 15 minutes before each round, while a tab is open."
      }
      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${
        enabled
          ? "border-transparent bg-accent text-accent-ink"
          : "border-line text-muted hover:text-ink"
      } disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {denied ? "Blocked" : enabled ? "Reminders on" : "Remind me"}
    </button>
  );
}
