import { Client } from "pg";

/*
  Real-time fan-out.

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
  | { type: "roster"; guild_id: number; user_id: number };

type Subscriber = (event: StandingsEvent) => void;

const globalForRT = globalThis as unknown as {
  rtSubscribers?: Set<Subscriber>;
  rtClient?: Client | null;
  rtConnecting?: Promise<void> | null;
};

const subscribers: Set<Subscriber> =
  globalForRT.rtSubscribers ?? (globalForRT.rtSubscribers = new Set());

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
      connectionString:
        process.env.DATABASE_URL_UNPOOLED ??
        process.env.DATABASE_URL ??
        "postgresql://cp:cp@localhost:5488/cp_trainer",
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
      // a dead socket and silently never delivering again.
      globalForRT.rtClient = null;
    });
    await client.connect();
    await client.query("listen standings");
    globalForRT.rtClient = client;
    globalForRT.rtConnecting = null;
  })();

  return globalForRT.rtConnecting;
}

export async function subscribe(fn: Subscriber): Promise<() => void> {
  await ensureListening();
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
