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

    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let bump: ReturnType<typeof setTimeout> | null = null;
    let fade: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let connects = 0;
    let failures = 0;
    let stopped = false;

    const refresh = () => setVersion((v) => v + 1);

    /*
      Polling is the floor, not the plan. A host that caps a response's
      duration, or a proxy that buffers text/event-stream, turns the SSE route
      into a connect/fail loop; without this the board would simply stop
      updating and look fine doing it. Slower than push, but never wrong for
      longer than the interval.
    */
    const fallBackToPolling = () => {
      if (poll || stopped) return;
      source?.close();
      source = null;
      setLive(false);
      poll = setInterval(() => {
        if (document.visibilityState === "visible") refresh();
      }, 20_000);
    };

    /*
      The stream's address comes from the server, per connection. With a
      worker configured it is the worker's own origin plus a signed token
      (see api/guild/stream-token) — a process nothing cuts at 60 seconds;
      without one it is the same-origin SSE route. Because the URL carries a
      token that can expire, reconnection is handled here rather than left to
      EventSource's built-in retry, which would re-dial a dead URL forever.
    */
    const connect = async () => {
      let url: string;
      try {
        const res = await fetch("/api/guild/stream-token");
        if (!res.ok) throw new Error(String(res.status));
        ({ url } = (await res.json()) as { url: string });
      } catch {
        if (stopped) return;
        failures += 1;
        if (failures >= 3 && connects === 0) fallBackToPolling();
        else scheduleReconnect();
        return;
      }
      if (stopped) return;

      source = new EventSource(url);

      source.addEventListener("ready", () => {
        setLive(true);
        failures = 0;
        connects += 1;
        // Not on the first connect — that's the page load, and the server
        // already rendered current data. Every *re*connect refetches, because
        // whatever moved while the stream was down was never delivered and
        // there's no replay.
        if (connects > 1) refresh();
      });

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
        bump = setTimeout(refresh, 400);
      });

      source.onerror = () => {
        setLive(false);
        // Close rather than let EventSource retry: its retry would reuse
        // this URL, and the URL is the part that may have gone stale.
        source?.close();
        source = null;
        failures += 1;
        // Three failures with nothing in between means the stream isn't
        // going to work here; a drop after a working connection is ordinary.
        if (failures >= 3 && connects === 0) fallBackToPolling();
        else scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (stopped || poll || retry) return;
      // 2s, 4s, 8s, capped — a worker mid-deploy comes back in seconds, and
      // anything longer is what the polling floor is for.
      const delay = Math.min(2_000 * 2 ** Math.max(failures - 1, 0), 15_000);
      retry = setTimeout(() => {
        retry = null;
        void connect();
      }, delay);
    };

    void connect();

    // Coming back to a tab that slept through the interesting part.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      if (bump) clearTimeout(bump);
      if (fade) clearTimeout(fade);
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisible);
      source?.close();
    };
  }, [enabled]);

  const value = useMemo(
    () => ({ live, version, pulse, last }),
    [live, version, pulse, last],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
