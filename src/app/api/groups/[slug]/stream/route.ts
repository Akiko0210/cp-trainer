import { getGroup, getGroupMemberIds } from "@/lib/group-queries";
import { getSessionUser } from "@/lib/auth";
import { subscribe } from "@/lib/realtime";

export const dynamic = "force-dynamic";

/*
  Server-Sent Events, not WebSockets: the leaderboard only ever needs
  server→client, SSE survives proxies that mangle upgrades, and the browser
  reconnects on its own. One long-lived response per viewer.

  Events are filtered to the group's own members here, server-side, so a
  stream can never leak another club's activity.
*/
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await getSessionUser();
  if (!user) return new Response("Sign in first.", { status: 401 });

  const { slug } = await params;
  const group = await getGroup(slug, user.id);
  if (!group) return new Response("No such group.", { status: 404 });
  if (!group.role) return new Response("Join the group first.", { status: 403 });

  // Coerced explicitly: this Set is compared against ids that arrive as JSON in
  // a pg_notify payload, and it is what stops one club seeing another's
  // activity — so the types on both sides must be beyond doubt here.
  const memberIds = new Set(
    (await getGroupMemberIds(group.id)).map((id) => Number(id)),
  );
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

      send("ready", { group: group.slug, members: memberIds.size });

      const unsubscribe = await subscribe((ev) => {
        if (!memberIds.has(Number(ev.user_id))) return;
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
