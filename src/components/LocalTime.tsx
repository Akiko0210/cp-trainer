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

const UTC_FALLBACK = new Intl.DateTimeFormat("en-US", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "UTC",
});

// The zone cannot change under a mounted page, so there is nothing to notify.
const subscribe = () => () => {};

export default function LocalTime({ iso }: { iso: string }) {
  const label = useSyncExternalStore(
    subscribe,
    () => new Date(iso).toLocaleString(),
    () => `${UTC_FALLBACK.format(new Date(iso))} UTC`,
  );

  return <time dateTime={iso}>{label}</time>;
}
