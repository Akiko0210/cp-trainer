"use client";

import { useEffect, useState } from "react";

/* Shared client pieces for the arena (duels + guild contests): one ticking
   clock and the time formats every countdown and result agrees on. */

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
