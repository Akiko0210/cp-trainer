import { getSessionUser } from "@/lib/auth";
import { getMyGuild } from "@/lib/guild-queries";
import { subscribe } from "@/lib/realtime";

export const dynamic = "force-dynamic";

/*
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
