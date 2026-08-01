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
- `LISTEN` cannot survive a transaction pooler — the real-time client uses
  `DATABASE_URL_UNPOOLED`. Through a pooler it connects fine and then silently
  never receives anything.
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

**Layout.** A bare `grid` with no mobile column count leaves an *auto* track,
and an auto track sizes to **max-content** — one wide table inside it stretches
every sibling card and the whole page scrolls sideways. Always name the narrow
count (`grid-cols-1 … lg:grid-cols-2`); Tailwind's numeric `grid-cols-*` expand
to `minmax(0,1fr)`, which is the clamp that stops it. The nav switches to its
single row at `lg`, not `sm`: logo, wordmark, five links and the chip cluster
need ~790px on one line, so switching at 640 put every page into horizontal
scroll for the entire tablet range. Check a change at 320px as well as 390 —
the fifth nav link only fits from 360 up.

**Motion.** FLIP measures `offsetTop`, never `getBoundingClientRect().top`, and
is skipped when `document.visibilityState !== "visible"` — a background tab never
runs `requestAnimationFrame`, so the inverse transform would never be released.

**Deployment.** A failing `instrumentation.ts` does *not* stop Next from
serving; it logs and carries on. Don't treat "the site is up" as proof the
environment is configured.

**Docs are part of the change.** [README.md](README.md) explains what the app
does and why the numbers mean anything; [DEPLOY.md](DEPLOY.md) is the runbook.
If behaviour moves, move them in the same commit.
