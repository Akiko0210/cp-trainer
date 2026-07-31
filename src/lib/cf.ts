/*
  One Codeforces lookup, made directly by the web app.

  This is the deliberate exception to "only the worker talks to Codeforces".
  That rule exists so the thousands of requests a full history mirror makes stay
  behind a single rate-limited queue (worker/cf_api.py, ≥2.2s apart) — it is
  about *bulk*. Validating a handle is one request, made once, when a member
  types their handle into the onboarding box.

  It exists because a serverless deployment has no worker at all. Without it,
  every member signs in, enters their handle, and is told to run `pnpm worker` —
  which is meaningless advice and a hard stop, since an account with no handle
  has no data, no estimate and no place on any board.

  When a worker IS configured (docker-compose, or a laptop), the route prefers
  it: an independent call from here would sit outside the queue the mirror is
  pacing itself with.
*/

export class HandleNotFound extends Error {
  constructor(handle: string) {
    super(`Codeforces doesn't know the handle “${handle}”.`);
  }
}

export type HandleInfo = {
  handle: string;
  rating: number | null;
  maxRating: number | null;
  rank: string | null;
};

/** Shape-identical to the worker's /validate-handle, so the caller can't tell. */
export async function fetchHandleInfo(handle: string): Promise<HandleInfo> {
  const url = `https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      // Codeforces is occasionally slow; a member staring at a spinner is worse
      // than a clear "try again".
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "cp-trainer" },
      cache: "no-store",
    });
  } catch {
    throw new Error("Couldn't reach Codeforces just now — try again in a moment.");
  }

  // CF answers 400 with a JSON body for an unknown handle, so parse either way.
  const body = (await res.json().catch(() => null)) as {
    status?: string;
    result?: Array<{
      handle: string;
      rating?: number;
      maxRating?: number;
      rank?: string;
    }>;
    comment?: string;
  } | null;

  if (!body || body.status !== "OK" || !body.result?.length) {
    if (body?.comment?.includes("not found")) throw new HandleNotFound(handle);
    throw new Error(body?.comment ?? "Codeforces rejected that handle.");
  }

  const u = body.result[0];
  return {
    handle: u.handle,
    rating: u.rating ?? null,
    maxRating: u.maxRating ?? null,
    rank: u.rank ?? null,
  };
}
