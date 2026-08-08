"use client";

import { useSyncExternalStore } from "react";

/*
  A timestamp belongs in the *viewer's* zone, and only the browser knows what
  that is. `toLocaleString()` called from a server component formats in the
  server's zone — UTC on Vercel — so a member in California was told their sync
  ran at 5:33 PM when it had run at 10:33 AM. It is worse than a cosmetic
  offset: the whole point of the field is answering "was that recent?", and a
  seven-hour lie makes a sync that just happened look like one from this
  evening.

  So: render on the server in UTC and *say* UTC, then swap to the viewer's zone
  once hydrated. The first paint and the no-JS case stay correct rather than
  merely plausible, which is the same reason the sync card would rather say
  "stale" than guess.

  `useSyncExternalStore` rather than an effect because the server snapshot is
  the part that matters here: React renders it during hydration, so the server
  pass and the first client pass agree by construction, and the zone-aware
  value arrives immediately after. Hence the pinned en-US and explicit UTC in
  the fallback — only the hydrated format passes `undefined` for the locale,
  which is what picks up the viewer's own.
*/

/*
  Three shapes, because the same instant needs different amounts of context:
  `full` for a one-off fact (last sync), `daytime` for a list where each row
  stands alone (the contest card), `time` where a heading already said which
  day it is (the grouped contest board).
*/
type Mode = "full" | "daytime" | "time";

const OPTIONS: Record<Mode, Intl.DateTimeFormatOptions> = {
  full: { dateStyle: "short", timeStyle: "medium" },
  daytime: { weekday: "short", hour: "numeric", minute: "2-digit" },
  time: { hour: "numeric", minute: "2-digit" },
};

const UTC_FALLBACK: Record<Mode, Intl.DateTimeFormat> = {
  full: new Intl.DateTimeFormat("en-US", { ...OPTIONS.full, timeZone: "UTC" }),
  daytime: new Intl.DateTimeFormat("en-US", { ...OPTIONS.daytime, timeZone: "UTC" }),
  time: new Intl.DateTimeFormat("en-US", { ...OPTIONS.time, timeZone: "UTC" }),
};

// The zone cannot change under a mounted page, so there is nothing to notify.
const subscribe = () => () => {};

export default function LocalTime({ iso, mode = "full" }: { iso: string; mode?: Mode }) {
  const label = useSyncExternalStore(
    subscribe,
    () => new Date(iso).toLocaleString(undefined, OPTIONS[mode]),
    () => `${UTC_FALLBACK[mode].format(new Date(iso))} UTC`,
  );

  return <time dateTime={iso}>{label}</time>;
}
