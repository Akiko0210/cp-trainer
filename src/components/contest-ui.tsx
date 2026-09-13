"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/*
  Shared pieces for every contest surface: the dashboard card and /contests.
  Both show the same rows and offer the same reminder, so the clock, the
  notification scheduling and the platform marks live here rather than being
  written twice and drifting.
*/

// ---------------------------------------------------------------------------
// Judge marks — each judge's own logo, drawn as vectors.
//
// Vectors rather than the judges' favicons, which is the obvious alternative:
// Codeforces only publishes a 16×16 .ico and AtCoder's is its full crest
// *including the wordmark*, so both are a blurred smudge at this size, and
// hotlinking them would send every viewer's IP to four judges on every page
// load. The colours are not guessed — they are sampled from those same
// favicons (see db/../globals.css for the tokens).
//
// AtCoder is the one honest compromise. Its logo is a crowned crest with two
// unicorns and a globe; nothing survives 20px. It reduces to the crest's
// silhouette and the "AC" monogram that sits inside the real one.
//
// These marks use real brand colour, which means Codeforces' red and
// LeetCode's orange — the one sanctioned exception to the verdict-colour
// rule, safe only because contest surfaces render no verdict badges. The
// reasoning is recorded next to the tokens in globals.css and in AGENTS.md.
// ---------------------------------------------------------------------------

const CODEFORCES = (
  // Three bars, bottom-aligned: gold short, blue tall, red shortest.
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
    <rect x="2" y="8.5" width="5.6" height="13" rx="1.7" fill="var(--judge-cf-yellow)" />
    <rect x="9.2" y="4" width="5.6" height="17.5" rx="1.7" fill="var(--judge-cf-blue)" />
    <rect x="16.4" y="10.5" width="5.6" height="11" rx="1.7" fill="var(--judge-cf-red)" />
  </svg>
);

const LEETCODE = (
  // The angular "C": ink chevron, orange arms top and bottom, grey crossbar.
  <svg
    viewBox="0 0 24 24"
    width="100%"
    height="100%"
    aria-hidden
    fill="none"
    strokeWidth="2.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path
      d="M14 3.2 6.2 11a2.4 2.4 0 0 0 0 3.4l7.8 6.4"
      stroke="var(--judge-ink)"
    />
    <path d="M14 3.2 18.1 7.1" stroke="var(--judge-lc-orange)" />
    <path d="M14 20.8 18.1 17" stroke="var(--judge-lc-orange)" />
    <path d="M11.6 12.7h8.6" stroke="var(--judge-lc-gray)" />
  </svg>
);

const CODECHEF = (
  // The toque: three puffs over a band.
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden fill="var(--judge-cc-brown)">
    <path d="M5.4 13.6a3.5 3.5 0 1 1 2.5-5.9 3.9 3.9 0 0 1 7.4 0 3.5 3.5 0 1 1 2.5 5.9v1.2H5.4v-1.2Z" />
    <rect x="5.4" y="16.2" width="12.6" height="3.6" rx="1.1" />
  </svg>
);

const ATCODER = (
  // Crest silhouette + the monogram from inside the real one.
  <svg
    viewBox="0 0 24 24"
    width="100%"
    height="100%"
    aria-hidden
    fill="none"
    stroke="var(--judge-ink)"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2.6 20 5.3v6.4c0 4.5-3.3 7.5-8 9.4-4.7-1.9-8-4.9-8-9.4V5.3Z" />
    <path d="M9.3 15.6 12 8.4l2.7 7.2" />
    <path d="M10.4 13.2h3.2" />
  </svg>
);

/* Judges with no drawn logo get a tinted initial. It carries a chip behind it
   on purpose: a bare glyph beside four full-colour logos reads as one that
   failed to load, where a deliberate tile reads as a judge we simply haven't
   drawn yet. Scales with `size` so it holds its weight at any of them. */
function Initial({ ch, color, size }: { ch: string; color: string; size: number }) {
  return (
    <span
      className="grid size-full place-items-center rounded-[6px] font-bold leading-none"
      style={{
        color,
        backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)`,
        fontSize: Math.round(size * 0.5),
      }}
    >
      {ch}
    </span>
  );
}

/** Judges with a drawn logo; anything else falls back to a tinted initial. */
const MARKS: Record<string, React.ReactNode> = {
  codeforces: CODEFORCES,
  atcoder: ATCODER,
  codechef: CODECHEF,
  leetcode: LEETCODE,
};

const FALLBACK_TINT: Record<string, string> = {
  usaco: "var(--cat-geometry)",
  topcoder: "var(--cat-graphs)",
  hackerrank: "var(--cat-flow)",
  yukicoder: "var(--cat-fundamentals)",
};

export function PlatformMark({
  platform,
  size = 22,
}: {
  platform: string;
  size?: number;
}) {
  const key = platform.toLowerCase();
  const logo = MARKS[key];
  const tint = FALLBACK_TINT[key] ?? "var(--cat-fundamentals)";
  return (
    <span
      title={platform}
      aria-label={platform}
      role="img"
      className="grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      {logo ?? (
        <Initial ch={platform.slice(0, 1).toUpperCase()} color={tint} size={size} />
      )}
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

/**
 * The opt-in to browser notifications, keyed per feature so turning on
 * contest reminders doesn't also turn on arena alerts. Permission and the
 * flag are read straight from the browser during render (guarded to
 * post-hydration by `now`); state exists only so the toggle can move them
 * without a reload.
 */
export function useNotificationOptIn(storageKey: string) {
  const now = useNowMs();
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
      localStorage.getItem(storageKey) === "1");

  const toggle = async () => {
    if (enabled) {
      localStorage.setItem(storageKey, "0");
      setOverride({ enabled: false, denied: false });
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") localStorage.setItem(storageKey, "1");
    setOverride({
      enabled: permission === "granted",
      denied: permission === "denied",
    });
  };

  return { supported, enabled, denied, toggle };
}

export function useContestReminders(contests: Remindable[]) {
  const { supported, enabled, denied, toggle } = useNotificationOptIn(ENABLED_KEY);

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
