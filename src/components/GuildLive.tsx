"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  /** The most recent event, for consumers that care which thing moved. */
  last: StandingsEvent | null;
  /** Bumped once per event, never coalesced: an effect keyed on `last`
      alone can miss one of two events landing in the same tick. */
  seq: number;
};

const Ctx = createContext<LiveState>({
  live: false,
  version: 0,
  pulse: false,
  last: null,
  seq: 0,
});

export function useGuildLive(): LiveState {
  return useContext(Ctx);
}

/*
  A hold keeps the stream open while the tab is hidden.

  The hidden-tab park below is a billing decision, and it is right for a
  leaderboard nobody is looking at. It is wrong for someone in a live race: a
  bullet player alt-tabs to their editor for the whole match, and a battle
  player waits in the queue with the room behind another window — the moment
  the alert matters is exactly the moment the stream would have been parked.
  So a panel that is *in* something holds the connection open for as long as
  that is true, and only then. Never for spectators: one held tab per player
  in a match is bounded by the match; one per viewer of a ladder is not.
*/
const HoldCtx = createContext<(delta: 1 | -1) => void>(() => {});

export function useLiveHold(active: boolean): void {
  const adjust = useContext(HoldCtx);
  useEffect(() => {
    if (!active) return;
    adjust(1);
    return () => adjust(-1);
  }, [active, adjust]);
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
  const [seq, setSeq] = useState(0);
  // Live holds (useLiveHold) and the stream effect's reaction to one
  // changing — set inside the effect, so it closes over that effect's state.
  const holds = useRef(0);
  const onHoldChange = useRef<(() => void) | null>(null);
  const adjustHold = useCallback((delta: 1 | -1) => {
    holds.current = Math.max(0, holds.current + delta);
    onHoldChange.current?.();
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let bump: ReturnType<typeof setTimeout> | null = null;
    let fade: ReturnType<typeof setTimeout> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let hide: ReturnType<typeof setTimeout> | null = null;
    let parked = false;
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
      if (stopped || parked || poll) return;
      let url: string;
      try {
        const res = await fetch("/api/guild/stream-token");
        if (!res.ok) throw new Error(String(res.status));
        ({ url } = (await res.json()) as { url: string });
      } catch {
        if (stopped || parked) return;
        failures += 1;
        if (failures >= 3 && connects === 0) fallBackToPolling();
        else scheduleReconnect();
        return;
      }
      if (stopped || parked) return;

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
          setSeq((n) => n + 1);
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

    /*
      A hidden tab parks its stream; coming back reconnects and refetches.

      This is a billing decision, not a UX one. The database scales to zero
      and bills on "is anything connected" — and a stream held open here keeps
      the worker's LISTEN registered, which keeps the database awake. One
      pinned background tab was enough to bill around the clock (measured:
      ~61% of the month awake, mostly overnight). A hidden tab can't show the
      board moving anyway, and the reconnect path already refetches whatever
      was missed, so nothing is lost but the idle connection.

      The 60s grace rides over a tab switch or a quick look elsewhere; it only
      really fires when the tab has genuinely been left. It sits above the
      worker's own 30s idle window (broadcast.py IDLE_CLOSE_S) so a brief
      hide doesn't tear the shared LISTEN down and rebuild it.
    */
    const HIDE_PARK_MS = 60_000;
    const startParkTimer = () => {
      if (poll || hide || stopped || parked) return; // polling holds no connection
      hide = setTimeout(() => {
        hide = null;
        parked = true;
        if (retry) {
          clearTimeout(retry);
          retry = null;
        }
        source?.close();
        source = null;
        setLive(false);
      }, HIDE_PARK_MS);
    };
    const unpark = () => {
      if (hide) {
        clearTimeout(hide);
        hide = null;
      }
      if (parked) {
        // The `ready` handler refetches (connects > 1), covering whatever
        // moved while parked — same path as any other reconnect.
        parked = false;
        failures = 0;
        void connect();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // A live race holds the stream open (useLiveHold); nothing to park.
        if (holds.current > 0) return;
        startParkTimer();
        return;
      }
      if (parked || hide) {
        unpark();
      } else {
        // Still connected; catch up on updates coalesced while asleep.
        refresh();
      }
    };
    // A hold taken while hidden cancels the pending park (or reconnects a
    // parked stream); the last hold released while hidden starts the timer.
    onHoldChange.current = () => {
      if (stopped || document.visibilityState !== "hidden") return;
      if (holds.current > 0) unpark();
      else startParkTimer();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // A restored session can begin life hidden, with no visibilitychange
    // coming — start the park timer now or the stream outlives the grace.
    if (document.visibilityState === "hidden") onVisibility();

    return () => {
      stopped = true;
      onHoldChange.current = null;
      if (bump) clearTimeout(bump);
      if (fade) clearTimeout(fade);
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
      if (hide) clearTimeout(hide);
      document.removeEventListener("visibilitychange", onVisibility);
      source?.close();
    };
  }, [enabled]);

  const value = useMemo(
    () => ({ live, version, pulse, last, seq }),
    [live, version, pulse, last, seq],
  );
  return (
    <HoldCtx.Provider value={adjustHold}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </HoldCtx.Provider>
  );
}
