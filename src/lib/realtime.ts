import { Client } from "pg";
import type { NotificationKind } from "./notification-queries";

/*
  Real-time fan-out — the FALLBACK copy. When WORKER_URL is set, browsers
  stream from the worker's own broadcaster (worker/broadcast.py) and none of
  this runs; this version serves localhost development and worker-less boxes,
  where "one LISTEN per Node process" is one connection, not one per lambda.

  Writers don't know or care who is watching: the schema puts triggers on
  `submissions`, `topic_mastery` and `users` that `pg_notify('standings', …)`.
  The worker syncing a member's Codeforces history therefore publishes
  automatically, with no coupling between the Python service and the web app.

  On this side we hold ONE dedicated LISTEN connection for the whole Node
  process and fan out to every subscribed SSE stream in memory. A connection per
  viewer would exhaust Postgres the moment a club actually used this.
*/

/*
  Every payload names the guild it belongs to, and a stream filters on that.
  The earlier design filtered against the set of member ids read when the
  viewer connected, which silently dropped events from anyone who joined
  afterwards — they stayed invisible until a reload.
*/
export type StandingsEvent =
  | {
      type: "mastery";
      guild_id: number;
      user_id: number;
      topic_id: number;
      score: number | null;
      estimate: number | null;
    }
  | { type: "solve"; guild_id: number; user_id: number; problem_id: number | null }
  | { type: "roster"; guild_id: number; user_id: number }
  // The arena (db/migrations/005_arena.sql): duel and guild-contest state
  // changes ride the same channel, so every consumer's "something moved,
  // refetch" logic covers them with no new plumbing.
  | { type: "duel"; guild_id: number; duel_id: number; status: string }
  | { type: "contest"; guild_id: number; contest_id: number; status: string }
  // 006: a battle's own row (status = its lifecycle) or one of its children
  // (status 'players' | 'match'). Consumers refetch and diff; nothing reads
  // the payload beyond guild_id.
  | { type: "battle"; guild_id: number; battle_id: number; status: string }
  // 007: an inbox row for ONE person. `recipient_id` marks the event as
  // addressed; this fan-out and the worker's both drop it for anyone else.
  // (Not `user_id`: mastery/solve/roster use that name for the actor.)
  | {
      type: "inbox";
      guild_id: number;
      recipient_id: number;
      id: number;
      kind: NotificationKind;
      duel_id: number | null;
    };

type Subscriber = (event: StandingsEvent) => void;

const globalForRT = globalThis as unknown as {
  rtSubscribers?: Set<Subscriber>;
  rtClient?: Client | null;
  rtConnecting?: Promise<void> | null;
  rtIdleTimer?: ReturnType<typeof setTimeout> | null;
};

const subscribers: Set<Subscriber> =
  globalForRT.rtSubscribers ?? (globalForRT.rtSubscribers = new Set());

/*
  Nothing watching, nothing connected.

  Postgres that scales to zero bills on "is anything connected", not on query
  volume — and a parked LISTEN connection is indistinguishable from a busy one
  to that meter. Left open, this single silent socket keeps the database awake
  around the clock: 0.25 CU × 24h is 6 CU-hours a day, which spends a 100-hour
  monthly allowance in under three weeks on an app nobody is using.

  The delay is what makes closing safe. A serverless host cuts every SSE
  response at its duration ceiling (60s, see the stream route) and the browser
  reconnects a moment later, so closing the instant the count hits zero would
  tear the listener down and rebuild it every minute. The grace window rides
  over a reconnect and only really fires when the last tab has gone.
*/
const IDLE_CLOSE_MS = 30_000;

function cancelIdleClose(): void {
  if (!globalForRT.rtIdleTimer) return;
  clearTimeout(globalForRT.rtIdleTimer);
  globalForRT.rtIdleTimer = null;
}

function scheduleIdleClose(): void {
  cancelIdleClose();
  const timer = setTimeout(() => {
    globalForRT.rtIdleTimer = null;
    if (subscribers.size > 0) return;
    const client = globalForRT.rtClient;
    // Cleared before the close is awaited, so a viewer arriving mid-teardown
    // builds a fresh client instead of adopting one already on its way out.
    globalForRT.rtClient = null;
    void client?.end().catch(() => {});
  }, IDLE_CLOSE_MS);
  // A pending close is not a reason to keep the process alive.
  timer.unref?.();
  globalForRT.rtIdleTimer = timer;
}

/**
 * The direct endpoint for a Neon pooled URL; anything else unchanged.
 * Neon's pooler host is `<endpoint>-pooler.<region>…` and the same host
 * without the suffix is the direct one. A LISTEN through the pooler connects,
 * registers, and never receives anything — so a pooled URL here is rewritten
 * rather than trusted. (The worker's twin is broadcast.listen_url.)
 */
export function listenUrl(url: string): string {
  try {
    const u = new URL(url);
    const [first, ...rest] = u.hostname.split(".");
    if (!first.endsWith("-pooler")) return url;
    u.hostname = [first.slice(0, -"-pooler".length), ...rest].join(".");
    return u.toString();
  } catch {
    return url;
  }
}

async function ensureListening(): Promise<void> {
  if (globalForRT.rtClient) return;
  if (globalForRT.rtConnecting) return globalForRT.rtConnecting;

  globalForRT.rtConnecting = (async () => {
    const client = new Client({
      /*
        The UNPOOLED url, when there is one.

        Managed Postgres hands you two connection strings: a pooled one
        (PgBouncer in transaction mode) and a direct one. `LISTEN` cannot work
        through transaction pooling — the connection you registered the listener
        on is handed to somebody else between statements, so notifications
        silently never arrive. The board would look connected and simply never
        move, which is the worst possible failure for this feature.
      */
      // `||`, not `??`: the local launch entries set DATABASE_URL_UNPOOLED
      // to an empty string to mean "none", and an empty connection string
      // connects to nothing — the stream would open, send `ready`, and never
      // deliver an event.
      connectionString: listenUrl(
        process.env.DATABASE_URL_UNPOOLED ||
          process.env.DATABASE_URL ||
          "postgresql://cp:cp@localhost:5488/cp_trainer",
      ),
    });
    client.on("notification", (msg) => {
      if (!msg.payload) return;
      try {
        const event = JSON.parse(msg.payload) as StandingsEvent;
        for (const fn of subscribers) fn(event);
      } catch {
        // A malformed payload must not take down the listener.
      }
    });
    client.on("error", () => {
      // Drop it and let the next subscriber reconnect, rather than sitting on
      // a dead socket and silently never delivering again. End it too: a
      // half-dead client that is merely forgotten stays a backend on the
      // server until something else reaps it, and those accumulate.
      if (globalForRT.rtClient === client) globalForRT.rtClient = null;
      void client.end().catch(() => {});
    });
    try {
      await client.connect();
      await client.query("listen standings");
    } catch (err) {
      // Without this the failed attempt stays cached as a rejected promise and
      // every later subscriber inherits the same failure forever.
      globalForRT.rtConnecting = null;
      void client.end().catch(() => {});
      throw err;
    }
    globalForRT.rtClient = client;
    globalForRT.rtConnecting = null;
  })();

  return globalForRT.rtConnecting;
}

export async function subscribe(fn: Subscriber): Promise<() => void> {
  // Before connecting, so a viewer arriving during the grace window keeps the
  // listener that is already up instead of racing its teardown.
  cancelIdleClose();
  await ensureListening();
  subscribers.add(fn);
  return () => {
    if (!subscribers.delete(fn)) return;
    if (subscribers.size === 0) scheduleIdleClose();
  };
}
