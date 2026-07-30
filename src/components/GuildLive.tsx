"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { StandingsEvent } from "@/lib/realtime";

/*
  One live connection for the whole app.

  The guild is meant to be visible everywhere — the nav chip, the dashboard
  band, the champions grid, the full leaderboard — and each of those needs to
  know when something moved. Opening an EventSource per component would mean
  four streams per tab, four LISTEN fan-outs, and four independent ideas of
  whether we're connected. So the provider sits in the root layout, holds one
  stream, and hands down a version counter.

  Consumers re-fetch their own data when `version` changes. The server never
  pushes a whole board: it pushes "member X moved", which keeps payloads tiny
  and leaves every ranking decision in SQL, where it can't drift.
*/

type LiveState = {
  live: boolean;
  /** Bumped (coalesced) whenever something in the guild moved. */
  version: number;
  /** True for a moment after each event — for "something moved" flashes. */
  pulse: boolean;
  last: StandingsEvent | null;
};

const Ctx = createContext<LiveState>({
  live: false,
  version: 0,
  pulse: false,
  last: null,
});

export function useGuildLive(): LiveState {
  return useContext(Ctx);
}

export default function GuildLive({
  enabled,
  children,
}: {
  /** False when the viewer has no guild — nothing to listen to. */
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [live, setLive] = useState(false);
  const [version, setVersion] = useState(0);
  const [pulse, setPulse] = useState(false);
  const [last, setLast] = useState<StandingsEvent | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource("/api/guild/stream");
    let bump: ReturnType<typeof setTimeout> | null = null;
    let fade: ReturnType<typeof setTimeout> | null = null;

    source.addEventListener("ready", () => setLive(true));
    source.addEventListener("standings", (e) => {
      try {
        setLast(JSON.parse((e as MessageEvent).data) as StandingsEvent);
      } catch {
        // A malformed payload shouldn't stop the version bump below.
      }
      setPulse(true);
      if (fade) clearTimeout(fade);
      fade = setTimeout(() => setPulse(false), 1100);
      // Coalesced: one Codeforces sync fires a burst of notifications, and
      // re-fetching per event would hammer the database for no visual gain.
      if (bump) clearTimeout(bump);
      bump = setTimeout(() => setVersion((v) => v + 1), 400);
    });
    // EventSource reconnects on its own; we only reflect the state.
    source.onerror = () => setLive(false);

    return () => {
      if (bump) clearTimeout(bump);
      if (fade) clearTimeout(fade);
      source.close();
    };
  }, [enabled]);

  const value = useMemo(
    () => ({ live, version, pulse, last }),
    [live, version, pulse, last],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
