import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";
import { subscribe } from "@/lib/realtime";

export const dynamic = "force-dynamic";

/*
  Ask for as long as the host will give us.

  On a machine you own this is ignored and the stream lives until the browser
  goes away. On a serverless host the default is around ten seconds, which
  would mean a reconnect every ten seconds forever; 60 is the Hobby ceiling.
  The client refetches on every reconnect (GuildLive.tsx), so a cut stream
  costs a blink, not a missed event.
*/
export const maxDuration = 60;

/*
  The FALLBACK stream, for installs with no worker. With WORKER_URL set the
  stream-token route points browsers at the worker's /stream instead — a
  process nothing cuts at 60 seconds and one LISTEN total — and this route
  goes unvisited. It stays for localhost development and worker-less boxes.

  Server-Sent Events, not WebSockets: the leaderboard only ever needs
  server→client, SSE survives proxies that mangle upgrades, and the browser
  reconnects on its own. One long-lived response per viewer.

  Events are filtered to the viewer's own guild here, server-side, so a stream
  can never leak another guild's activity. Filtering on the payload's guild_id
  (rather than on a snapshot of member ids) means a member who joins while you
  have the page open starts showing up immediately.
*/
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });

  const guild = await getMyGuild(user.id);
  if (!guild) return new Response("You're not in a guild.", { status: 404 });

  // Coerced explicitly. node-postgres hands back bigint as a *string*, and this
  // comparison is the thing that stops one guild seeing another's activity, so
  // the types on both sides must be beyond doubt.
  const guildId = Number(guild.id);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      send("ready", { guild: guild.slug, members: guild.member_count });

      const unsubscribe = await subscribe((ev) => {
        if (Number(ev.guild_id) !== guildId) return;
        // Addressed events (the inbox) reach one person. Same coercion, same
        // reason: the id in the payload is a JSON number, the session's may
        // not be.
        if ("recipient_id" in ev && Number(ev.recipient_id) !== Number(user.id)) return;
        send("standings", ev);
      });

      // Comment-only heartbeat: keeps intermediaries from reaping an idle
      // connection, and costs one line every 25s.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 25_000);

      const cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Nginx and friends buffer by default, which would defeat the point.
      "X-Accel-Buffering": "no",
    },
  });
}
