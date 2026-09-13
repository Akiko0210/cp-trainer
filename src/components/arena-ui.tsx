"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "./ui";

/* Shared client pieces for the arena (duels, guild contests, battles): one
   ticking clock, the time formats every countdown and result agrees on, the
   one way a panel POSTs an action, and the big clock a race is played against. */

/**
 * The current time, re-rendered once a second — but only while `enabled`.
 * A parked panel must not tick: an interval in every idle tab is how a
 * "fun feature" becomes a battery complaint.
 */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const tick = () => setNow(Date.now());
    // First tick via timeout-zero rather than synchronously: the panel may
    // have been mounted (clock frozen) long before a duel went live.
    const t0 = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [enabled]);
  return now;
}

/** ms -> "m:ss" (or "h:mm:ss" once it matters). Clamped at zero. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Duration in prose: 5400 -> "1h 30m", 3600 -> "1h", 1800 -> "30m". */
export function fmtDur(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Problem slot letter: 0 -> A. */
export function slotLetter(ordering: number): string {
  return String.fromCharCode(65 + ordering);
}

export function ActionButton({
  onClick,
  disabled,
  tone = "accent",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  /** "accent" acts, "quiet" declines/cancels. Nothing here is a verdict, so
      nothing here gets a verdict colour. */
  tone?: "accent" | "quiet";
  children: React.ReactNode;
}) {
  const cls =
    tone === "accent"
      ? "bg-accent text-accent-ink hover:opacity-90"
      : "border border-line bg-page text-muted hover:text-ink";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl px-3.5 py-2 text-sm font-medium disabled:opacity-40 ${cls}`}
    >
      {children}
    </button>
  );
}

/**
 * POST an action and reload. The same four lines every arena panel had
 * copied: set busy, send JSON, surface `error` from the body verbatim (every
 * route writes it for the UI), refetch whatever the caller renders from.
 */
export function useAct(load: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(
    async (url: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!res.ok) setError(data?.error ?? "That didn't work.");
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );
  return { act, busy, error };
}

export function LoadingCard() {
  return (
    <Card>
      <p className="text-sm text-muted">Loading…</p>
    </Card>
  );
}

/**
 * The clock a race is played against. Big, display face, and — under a
 * minute — pulsing in the accent. Not amber: amber is a verdict.
 */
export function BigClock({
  ms,
  urgentUnderMs = 60_000,
  title = "Time left",
  className = "",
}: {
  ms: number;
  urgentUnderMs?: number;
  title?: string;
  className?: string;
}) {
  const urgent = ms > 0 && ms <= urgentUnderMs;
  return (
    <span
      className={`num font-display inline-block text-[34px] font-semibold leading-none tracking-tight ${
        urgent ? "clock-urgent" : ""
      } ${className}`}
      title={title}
    >
      {fmtClock(ms)}
    </span>
  );
}
