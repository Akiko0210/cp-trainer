import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { workerToken, workerUrl } from "@/lib/env";
import { getMyGuild } from "@/lib/guild-queries";

export const dynamic = "force-dynamic";

/*
  Tells the browser where its live stream lives, and hands it the key.

  With a worker configured, the stream is served by the worker directly —
  a process nothing cuts at 60 seconds — and the browser connects cross-origin,
  where its session cookie is useless. So this route, which *can* see the
  cookie, converts "signed-in member of guild N" into a token the worker can
  verify on its own: HMAC over WORKER_TOKEN, the secret the two services
  already share. Nothing new to provision, nothing worker-side to look up.

  Without a worker (localhost, or a box running the whole compose file) the
  same-origin SSE route serves the stream exactly as before, cookie and all —
  the client treats both answers identically.

  The expiry is hours, not minutes, because an EventSource holds one URL for
  its whole life: expiry only bites on *reconnect*, and the client fetches a
  fresh URL from here on every reconnect anyway. It exists so a leaked URL
  goes stale, not to rotate a live connection.
*/
const TOKEN_TTL_S = 12 * 60 * 60;

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const guild = await getMyGuild(user.id);
  if (!guild)
    return NextResponse.json({ error: "You're not in a guild." }, { status: 404 });

  const base = workerUrl();
  if (!base) return NextResponse.json({ url: "/api/guild/stream" });

  // Signed over the *encoded* payload string so both languages hash identical
  // bytes (worker/broadcast.py is the verifying twin). Coerce the guild id:
  // node-postgres returns bigint as a string, and the worker compares ints.
  const payload = Buffer.from(
    JSON.stringify({
      g: Number(guild.id),
      u: user.id,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S,
    }),
  ).toString("base64url");
  const sig = createHmac("sha256", workerToken() ?? "")
    .update(payload)
    .digest("base64url");

  return NextResponse.json({ url: `${base}/stream?token=${payload}.${sig}` });
}
