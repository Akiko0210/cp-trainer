"use client";

import { useState, useSyncExternalStore } from "react";

/*
  Two small browser-facing hooks shared by the contest reminders, the arena
  rooms and the header's inbox. They live apart from contest-ui.tsx so the
  header — on every page — doesn't carry the contest board with it.
*/

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

/**
 * The opt-in to browser notifications, keyed per feature so turning on
 * contest reminders doesn't also turn on arena alerts. Permission and the
 * flag are read straight from the browser during render (guarded to
 * post-hydration by `now`); state exists only so the toggle can move them
 * without a reload.
 */
export function useNotificationOptIn(
  storageKey: string,
  opts: { defaultOn?: boolean } = {},
) {
  const now = useNowMs();
  const [override, setOverride] = useState<{
    enabled: boolean;
    denied: boolean;
  } | null>(null);

  const supported = now !== null && "Notification" in window;
  const denied = override?.denied ?? (supported && Notification.permission === "denied");
  // `defaultOn`: with permission granted and nothing stored, count as on.
  // Permission is the consent; the flag only records an explicit "off".
  const enabled =
    override?.enabled ??
    (supported &&
      Notification.permission === "granted" &&
      (localStorage.getItem(storageKey) ?? (opts.defaultOn ? "1" : "0")) === "1");

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

