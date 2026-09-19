<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# CP Trainer — invariants

Each of these was learned by getting it wrong. They are cheap to honour and
expensive to rediscover.

**Colour.** Green, red and amber mean AC, WA and TLE. Nothing else may use them
— not a "live" dot, not a success state. The brand accent is indigo-violet, and
streak/guild accents live in the 215°–330° band for the same reason.

There is exactly one exception, and it is scoped: **judge logos** carry their
real brand colour, which means Codeforces' red bar and LeetCode's orange
(`--judge-*` in globals.css, sampled from each judge's own favicon). A judge is
an identity, not a verdict, and it is only safe because no contest surface
renders an AC/WA/TLE badge — the mark never sits beside a verdict it could be
mistaken for. Don't extend those tokens to anywhere a verdict can also appear,
and don't "fix" the red bar.

**Codeforces traffic.** Only `worker/` talks to the CF API in bulk, through the
single lock in `cf_api.py` (≥2.2s between calls). Two processes syncing at once
will exceed what CF allows from one address. The Next app never bulk-fetches.

**Never re-derive a stored number.** The worker writes the factors it actually
multiplied into `topic_mastery.factors`; the UI renders those. An earlier
version recomputed the formula client-side and silently drifted from the score
it was explaining.

**Champions rank on `rating_estimate`, not `score`.** Heat decays with
inactivity; an area title should be lost to someone improving, not to the holder
taking a week off.

**Postgres.**
- `LISTEN` cannot survive a transaction pooler — every real-time client uses
  `DATABASE_URL_UNPOOLED` (or a direct `DATABASE_URL`). Through a pooler it
  connects fine and then silently never receives anything. This happened in
  production (2026-09): the worker had only the pooled URL, logged "LISTEN
  up", and no live update reached any browser. Both listeners now rewrite a
  Neon `-pooler` host to the direct one, and the worker proves delivery with a
  test NOTIFY at startup — don't remove either. "LISTEN up" is not evidence.
- A `standings` event carrying `recipient_id` is *addressed*: both fan-outs
  must deliver it only to that user, and a subscriber with no user claim gets
  none of them. The inbox (`notifications`) is written only by the trigger on
  `duels` — never from the app — so every transition, wherever it happens,
  produces its row exactly once.
- There are two LISTEN fan-outs and only one runs at a time: the worker's
  (`worker/broadcast.py`) serves browsers directly whenever `WORKER_URL` is
  set; the web app's (`src/lib/realtime.ts` + the stream route) is the
  fallback for worker-less installs. Both tear down their connection ~30s
  after the last viewer leaves so a scale-to-zero database can sleep — don't
  "fix" that by keeping either connected.
- node-postgres returns `bigint` as a *string*. `db.ts` installs an INT8 parser;
  don't revert it, or ids stop comparing equal to the same ids arriving as JSON.
- Every `$N` must appear in the query text. An unused placeholder is a hard
  error ("could not determine data type"), not an ignored argument.
- **Row at a time is the expensive mistake here.** A round trip to a hosted
  Postgres is ~86 ms and 500 rows in one call cost the same as one row, so a
  loop that writes per row is free against local Docker and ruinous against
  Neon. The first sync spent 1,214 s that way. Batch the write; `worker/sync.py`
  does one statement per phase per page. Postgres binds at most 65,535
  parameters per statement, so batches have to chunk.

**A submission cursor may only advance once the walk is complete.** Codeforces
returns submissions newest-first, so after page one the highest id seen is
already the newest in the account. Persisting it mid-walk makes the next run
stop immediately and never fetch the *older* pages — the history is silently
lost, and nothing about it looks like an error. `sync_state
.last_synced_submission_id` moves only when the walk has met data we already
hold or run off the end of the account; `quick=true` reads one page and so
usually leaves it alone.

**Kattis** has no API and its `robots.txt` disallows `/users` and `/submissions`.
Solve state there comes from this app's own timer, never from scraping.

**Motion.** FLIP measures `offsetTop`, never `getBoundingClientRect().top`, and
is skipped when `document.visibilityState !== "visible"` — a background tab never
runs `requestAnimationFrame`, so the inverse transform would never be released.

**Deployment.** A failing `instrumentation.ts` does *not* stop Next from
serving; it logs and carries on. Don't treat "the site is up" as proof the
environment is configured.

**Docs are part of the change.** [README.md](README.md) explains what the app
does and why the numbers mean anything; [DEPLOY.md](DEPLOY.md) is the runbook.
If behaviour moves, move them in the same commit.
