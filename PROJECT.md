# CP Trainer — Project Description & Engineering Log

A competitive-programming training platform that mirrors a user's Codeforces
history, fits a calibrated per-topic ability estimate from it, tracks the
mistakes they repeat, and recommends what to solve next — with a live club
leaderboard on top. Built for SJSU Competitive Programming, training toward
ICPC Regionals.

This document is the engineering record: what was accomplished, and every
problem — including the small and embarrassing ones — that had to be solved to
get there. Entries are written in **Google XYZ form** ("accomplished **X**, as
measured by **Y**, by doing **Z**"), each followed by the symptom, the root
cause, and the fix.

---

## At a glance

| | |
|---|---|
| **Stack** | Next.js (App Router) · TypeScript · Tailwind · Python (FastAPI) · PostgreSQL 16 · Swift (AppKit) |
| **Scale** | ~13,600 lines across 134 tracked files · 14 tables · 23 API routes · 34 commits |
| **Surfaces** | Web app, Python sync worker, macOS menu-bar app, Docker/Compose + Vercel/Neon/Railway deployments |
| **External systems** | Codeforces API, open.kattis.com, usaco.guide, GitHub OAuth, GitHub Actions |
| **Modeling** | Rasch / 1-PL IRT maximum-a-posteriori ability fit, two-level with partial pooling |

**Architecture in one line:** `src/` (Next.js) reads Postgres directly and never
calls Codeforces in bulk; `worker/` (Python) owns *all* bulk CF traffic behind a
single rate-limited queue plus the estimator; `db/schema.sql` keeps
judge-mirrored `submissions` separate from user-supplied `attempts`/`mistakes`
and reconciles them by problem and time window.

---

## Headline accomplishments

- **Cut first-sync time by 99.8%, from 1,214 s to ~2 s** for a 2,714-submission
  account, by replacing per-row writes with three batched phases per page —
  10,874 SQL statements reduced to 25.
- **Cut catalog seeding from 67 minutes to seconds** across the ~14,000-problem
  Codeforces problemset, by reusing the same batched helpers — ~49,000 round
  trips reduced to 4 statements.
- **Reduced ability-estimate error from +467 to +108 rating points** against a
  known ground truth (1595), by replacing a solved-problems average with a
  Rasch/1-PL MAP fit over successes *and* failures, corrected for selection bias.
- **Unblocked onboarding for 100% of users with >2,300 submissions**, previously
  killed by the 15-minute GitHub Actions cap, by making a sync resumable and
  fast enough to finish inside one run.
- **Eliminated a permanent, silent history-loss bug** — 50 of 120 submissions
  lost forever per account — by forbidding the submission cursor from advancing
  before the walk completes, pinned by a test that fails on the old code.
- **Took a laptop-only prototype to three deployment targets** (self-hosted
  Compose, Vercel + Neon + Actions, Railway worker), by resolving 15+ distinct
  environment failures spanning IPv6 binding, container hostname resolution,
  package-manager pinning, and OAuth callback derivation behind a TLS proxy.
- **Reduced idle database cost from 6 CU-hours/day to near zero**, by closing the
  `LISTEN` connection when the last viewer disconnects — verified against a live
  Postgres, connection count `0 → 1 → 0`.
- **Secured a public multi-tenant deployment**, by adding shared-token auth to a
  worker whose endpoints could re-sync any member's history and crawl a third
  party's website, plus operator-gating the crawl endpoint and per-device
  revocable tokens for the menu-bar client.

---

# Engineering challenge log

## 1 · Data pipeline performance

### 1.1 The first sync took 20 minutes and the scheduler killed it at 15

> **Cut a 2,714-submission first sync from 1,214 s to ~2 s (99.8%)**, as measured
> by SQL statements issued (10,874 → 25) against the same account, by restructuring
> the page loop into three batched phases — problems, CF tag links, then submissions.

- **Symptom.** Onboarding simply never completed for anyone with a real history.
  The GitHub Actions job is capped at 15 minutes; a first sync took ~20.
- **Root cause.** `worker/sync.py` wrote one row per network round trip — roughly
  four statements per submission (problem upsert, one per tag, then the
  submission itself). Free against local Docker; ruinous against hosted Postgres.
- **The measurement that explained everything.** A round trip to Neon is **86 ms**,
  and **500 rows in one call costs the same as one row** (~90 ms). So
  `2,714 × 4 × 86 ms ≈ 16 minutes` — the arithmetic closed against the observed
  1,214 s with nothing left to diagnose.
- **Fix.** Batch per phase per page. Nothing about *what* is written changed:
  still an upsert (verdicts genuinely change `TESTING → OK`), still idempotent,
  CF calls untouched, and `upsert_problem` / `link_cf_tags` kept their signatures
  so the seed path was unaffected.

### 1.2 The catalog seed had the same shape, and the docs told you to wait an hour

> **Cut `pnpm seed` from 67 minutes to seconds**, as measured against the
> ~14,000-problem CF problemset, by routing `seed_problemset` through the batched
> helpers built for the sync loop — ~49,000 round trips → 4 statements.

- **Root cause.** Identical per-row pattern: one insert per problem plus one per tag.
- **Honest scope note.** `seed_usaco.py` was deliberately left alone — its inserts
  are nested (chapter id feeds module id feeds problem id), so batching it is a
  restructuring rather than a call swap. It became the slow half, and the docs
  say so rather than implying both halves got faster.

### 1.3 Postgres will not take an unbounded batch

> **Prevented batch writes from failing on large pages**, by chunking every batch
> below Postgres's hard ceiling of **65,535 bind parameters per statement**.

### 1.4 A killed run threw away all of its progress

> **Made an interrupted sync resumable**, by writing `last_synced_submission_id`
> alongside the rows it covers rather than after the mastery refit.

- **Symptom.** A run killed during the refit committed its submissions but
  recorded no progress, so the next run re-read the entire history from scratch.

---

## 2 · Data correctness

### 2.1 The cursor bug that silently deleted history

> **Eliminated permanent, invisible history loss** — reproduced as 50 of 120
> submissions lost forever — by restricting the submission cursor to advance only
> once the walk is complete, pinned by a regression test that fails on the prior code.

- **Symptom.** None. Nothing looked like an error. The account simply had less
  history than it should, permanently.
- **Root cause.** Codeforces returns submissions **newest-first**. After page one,
  the highest id seen is already the newest in the account. A `quick=true` sync on
  a freshly linked handle read the newest 50 submissions and set the cursor to the
  newest id — so the full sync behind it stopped immediately and the *older* pages
  were never fetched.
- **Fix.** The cursor moves only when the walk has met data already held or run off
  the end of the account. This is the single most dangerous class of bug in the
  project: correct-looking, silent, and unrecoverable.

### 2.2 Deduplication kept the wrong copy

> **Restored correct verdict resolution in batched writes**, by keying the dedupe
> on submission id so the *last* occurrence survives, pinned by a test.

- **Symptom.** A page reporting the same id as `TESTING` and then `OK` stored `TESTING`.
- **Root cause.** The batch dedupe skipped later occurrences; the per-row upserts it
  replaced had let the last write win. A behavioural change hidden inside a
  performance change.

### 2.3 A test fixture collided with real data

> **Removed a false test failure**, by moving the sync fixture off contest 1700 — a
> real Codeforces contest whose rows collide with the seeded catalog.

### 2.4 `bigint` arrives as a string, and every real-time event vanished

> **Fixed 100% event loss on the live leaderboard**, by installing an INT8 type
> parser in `db.ts` so ids compare equal across the driver and JSON payloads.

- **Symptom.** The board looked connected and never moved.
- **Root cause.** node-postgres returns `bigint` as a **string** to protect
  precision above 2^53. The member-id `Set` held `"4"` while `pg_notify` payloads
  carried `4`, so every event was filtered out.

### 2.5 `ON CONFLICT` cannot infer a partial index

> **Prevented a total sign-in failure before it shipped**, by making the
> `github_id` unique index unconditional (Postgres already permits many NULLs there).

- **Root cause.** `ON CONFLICT (github_id)` cannot infer a **partial** unique index,
  so the sign-in upsert would have failed outright for every user.

### 2.6 An unused `$N` is a hard error, not an ignored argument

> **Removed a class of query failure**, by ensuring every `$N` placeholder appears
> in the query text — Postgres raises "could not determine data type" rather than
> ignoring the extra argument.

### 2.7 The UI drifted from the number it was explaining

> **Guaranteed the mastery breakdown matches the stored score**, by having the
> worker write the factors it actually multiplied into `topic_mastery.factors` and
> the UI render those verbatim.

- **Root cause.** An earlier version recomputed the formula client-side and silently
  diverged from the score it claimed to explain. **Never re-derive a stored number.**

---

## 3 · The ability model

### 3.1 Averaging your solves is survivorship bias

> **Cut ability-estimate error from +467 to +108 points** against a ground-truth
> rating of 1595, by replacing an average of solved-problem ratings with a
> maximum-a-posteriori fit under the Rasch / 1-PL IRT (Elo 400-scale) model over
> successes **and** failures.

- **Symptom.** The old heuristic read **2062** for a 1595-rated account — whose
  solves in that topic average 1677 and whose *failures* average 2045.
- **Why the model is the right one.** A Codeforces rating is *defined* as the level
  at which you solve a problem 50% of the time, so the fit recovers exactly the
  quantity the scale already means.

### 3.2 Even counting failures overestimated, by +326

> **Reduced residual error from +326 to +108**, by counting *all* problems of every
> contest entered rather than only problems submitted to — taking the fit from 1921
> to 1703 against a true 1595, and moving the 50% solve crossover into the right band.

- **Root cause.** You choose what to open and grind practice until it falls, so ~90%
  of any history is solved. Codeforces avoids this by rating problems against every
  round participant *including those who never opened them*; the fix reproduces that
  denominator.

### 3.3 Contest and practice are different regimes

> **Separated calibrated from uncalibrated evidence**, by capturing
> `author.participantType` and discounting practice solves (unlimited time,
> editorial available) while counting practice **failures** at full weight — being
> unable to solve it with unlimited time is a strong ceiling signal.

### 3.4 Topic estimates on a different scale from the global one

> **Put per-topic and global estimates on one comparable scale**, by fitting two
> levels — a calibrated global anchor over full contest sets, then per-topic fits
> over engaged problems pooled toward it — and storing the measured gap between
> those universes (`users.selection_offset`) to subtract from topic estimates.
> Partial pooling means a topic with three observations reads "about your usual
> level" instead of swinging wildly.

### 3.5 Ranking champions on the wrong number

> **Made area titles reflect improvement rather than recency**, by ranking champions
> on `rating_estimate` and never on the 0–100 `score`.

- **Root cause.** Score is *current heat* (`level × evidence × freshness`) and decays
  with inactivity. Ranked on heat, a title would be lost by the holder taking a week
  off rather than to someone actually getting better.

### 3.6 The demo data demonstrated nothing

> **Made the champions grid legible as a contest**, by re-picking the demo roster
> from grandmasters to real public handles rated ~1650–1810 — spreading crowns
> across three members instead of one member holding all eight.

---

## 4 · Real-time and interface

### 4.1 `LISTEN` cannot survive a transaction pooler

> **Restored live updates on pooled deployments**, by pointing the listener at
> `DATABASE_URL_UNPOOLED`.

- **Symptom.** The worst possible failure mode: it connects fine and then silently
  never receives anything. The board looks live and simply never moves.
- **Root cause.** Under PgBouncer transaction pooling the connection the listener
  registered on is handed to another caller between statements.

### 4.2 A serverless route cuts the stream every ten seconds

> **Reduced SSE reconnects from ~6/minute to 1/minute**, by requesting
> `maxDuration = 60` (the platform ceiling) and having the client refetch on every
> reconnect — so a cut stream costs a blink, not a missed event.

### 4.3 Four surfaces, four connections, four opinions

> **Cut per-event network traffic from 8+ requests to 1** and removed the
> possibility of surfaces disagreeing, by holding **one** `EventSource` per tab and
> **one** champions store that every badge reads from.

- **Context.** Guild standings appear in four places: header chip, dashboard
  category cards, category-page board, and `/guild`. Per-component streams would
  have meant four connections and surfaces that could contradict each other.

### 4.4 Members who joined while you watched were invisible

> **Made new members appear immediately rather than on reload**, by carrying
> `guild_id` in every `pg_notify` payload and filtering streams on it — replacing a
> filter against the set of member ids read at connect time.

### 4.5 FLIP measured the wrong top

> **Fixed rows flying across the page on reorder**, by measuring `offsetTop` instead
> of `getBoundingClientRect().top`.

- **Root cause.** A viewport-relative measurement means any scroll between renders
  gives every row a bogus inverse transform.

### 4.6 FLIP in a background tab never released its transform

> **Prevented a permanently shuffled-looking list**, by skipping the animation
> unless `document.visibilityState === "visible"` and using a timeout rather than a
> frame for delta badges.

- **Root cause.** `requestAnimationFrame` never fires in a background tab, so the
  inverse transform is applied and never released. A viewer returning to the tab
  finds a scrambled board.

### 4.7 Reserved colour meanings leaked into decoration

> **Protected verdict legibility**, by moving the "live" dot off verdict-green to
> the brand accent and clamping guild crest hues to the 215°–330° band.

- **Rule.** Green, red and amber mean **AC, WA and TLE**. Nothing else may use them
  — not a live dot, not a success state. The streak flame burns violet-to-magenta
  for the same reason: amber is TLE.

### 4.8 A sticky element that could not stick

> **Removed a property that was a lie**, by measuring rather than assuming: a sticky
> element can only travel inside its own containing block, and this board is the
> taller card in its grid row. Tried it, measured it, took it out.

### 4.9 Every timestamp showed the server's timezone

> **Corrected timestamps for 100% of users outside UTC**, by rendering the server
> snapshot as explicit UTC and swapping to the viewer's locale and zone on hydration.

- **Symptom.** A sync that ran at 10:33 AM in California displayed as 5:33 PM —
  defeating the field's only job, judging whether the last run was recent.
- **Root cause.** `toLocaleString()` called from a server component gets Vercel's UTC.
- **Second instance.** The recommender had the same bug on a *calendar date*, where
  the error is a whole day east of UTC. It now takes elapsed days from Postgres and
  says "today" / "yesterday" / "N days ago" — the same number everywhere.

### 4.10 One busy day flattened the whole chart

> **Restored readability of the 8-week activity strip**, by switching to a
> square-root scale — a single 40-submission day was compressing every ordinary day
> into a flat line.

### 4.11 Small consistency debts

> **Removed duplicate logic and inconsistent controls**, by reusing the existing
> `daysAgo` helper instead of a second SQL column and local copy, unifying the flame
> path into one component shared by all three sizes, and replacing native selects
> with a designed listbox that keeps the full keyboard contract (arrows, Home/End,
> type-ahead, Enter, Escape) and supports option groups.

---

## 5 · Authentication and security

### 5.1 The worker had no authentication at all

> **Closed a full-takeover hole before public deployment**, by requiring a shared
> token on every acting worker endpoint — leaving only `/health` open, because a
> platform probe cannot hold a secret and it reveals nothing.

- **Exposure.** The endpoints re-sync *any* member's full Codeforces history and
  crawl Kattis. Reaching the address must not be the same thing as being allowed to
  drive it.

### 5.2 An unguarded endpoint that crawls someone else's website

> **Prevented the install from being used as a scraper**, by gating
> `/api/icpc/seed` to operators via `ADMIN_GITHUB_LOGINS`.

- **Exposure.** A several-minute crawl of a third party's site, triggerable by anyone
  who knew the URL.

### 5.3 OAuth callbacks broke behind a TLS-terminating proxy

> **Fixed sign-in rejection in every proxied deployment**, by building the callback
> from `x-forwarded-proto` / `x-forwarded-host` with `PUBLIC_ORIGIN` as an override.

- **Root cause.** Building it from the request URL reads `http://` behind the proxy,
  and GitHub rejects the mismatch.

### 5.4 The menu-bar app had been silently broken since auth shipped

> **Restored the macOS readout with least-privilege access**, by issuing a paired
> device token — an ordinary session row, so it expires and can be revoked — scoped
> to read the streak and nothing else.

- **Symptom.** It had been showing a dash for weeks and nobody noticed:
  `/api/streak` needs a session cookie and a Swift app is not a browser.
- **Hardening.** A device token **cannot mint another device token**, or a leaked one
  would be permanent. Unpaired, the app shows a **key**, not a plausible-looking zero.

### 5.5 Sign-in would have orphaned every existing row

> **Preserved thousands of mirrored submissions and every mastery estimate across
> the auth migration**, by having first sign-in *adopt* the pre-auth local account
> rather than minting a new one.

### 5.6 Invite links died at the OAuth round trip, safely

> **Made invite links survive sign-in**, by carrying the target through OAuth in a
> cookie — validated as a same-site path so it cannot become an open redirect.

### 5.7 Codes that survive a whiteboard

> **Made invite codes readable aloud at a club meeting**, by drawing them from an
> alphabet with no `O`/`0` or `I`/`1`.

### 5.8 A club could be stranded

> **Guaranteed a guild always has someone who can rotate its invite code**, by
> handing ownership to the longest-standing remaining member when the owner leaves.

---

## 6 · Deployment and infrastructure

### 6.1 The container bound to its own container id

> **Fixed a health check that would have failed forever while the app looked
> perfectly fine**, by not letting Docker's `HOSTNAME` reach the standalone server's
> bind address.

- **Root cause.** Docker sets `HOSTNAME` to the container id, Next's standalone
  server binds to it, and nothing listens on `127.0.0.1`.
- **Class of bug.** Found by running the container; the source alone would never
  have shown it.

### 6.2 The build image installed the wrong package manager

> **Fixed lockfile-incompatible builds**, by pinning `packageManager` — corepack was
> installing pnpm 11 against a lockfile written by pnpm 9.

### 6.3 A `COPY` of a directory git cannot track

> **Restored `docker compose up --build` from a clean checkout** — i.e. the entire
> Option A runbook — by deleting the Next template's `COPY /app/public ./public`.

- **Root cause.** The directory is empty, git cannot track an empty directory, so it
  existed only on machines where `create-next-app` left it behind. The image built on
  a laptop and nowhere else.
- **How it surfaced.** A Railway build pointed at the wrong Dockerfile; reproduced by
  cloning to a scratch directory.

### 6.4 The platform healthcheck arrived over IPv6

> **Fixed a deploy that was healthy and unreachable at once**, by building the
> listening socket in `serve.py` with `IPV6_V6ONLY` off before binding, and handing
> it to uvicorn — verified `/health` 200 over both `127.0.0.1` and `[::1]`.

- **Symptom.** uvicorn up on `0.0.0.0:8787` while the platform's healthcheck retried
  "service unavailable" for 91 s and then killed the deploy.
- **Why the obvious fix fails the other way.** `--host ::` breaks IPv4, because
  asyncio sets `IPV6_V6ONLY` on every `AF_INET6` listener it creates — regardless of
  the kernel's `bindv6only=0`. Verified in-container: connection refused on
  `127.0.0.1` against a server listening on `[::]:8787`.

### 6.5 The platform injects `PORT`, and deleting a service deletes your workaround

> **Removed the last piece of manual dashboard configuration**, by honouring the
> injected `PORT` first while keeping `WORKER_PORT` and the 8787 default for compose
> and self-hosted boxes. Verified with `PORT=5123`.

- **Root cause.** A worker honouring only `WORKER_PORT` is "service unavailable" on
  every deploy unless someone remembers a manual variable — and deleting the service
  deletes that variable, so the failure survived every recreate.

### 6.6 Dashboard configuration that didn't take

> **Made the build reproducible and reviewable**, by moving Dockerfile path, health
> check path, restart policy, and replica count into `railway.json` — config-as-code
> is authoritative over auto-detection.

- **Symptom.** The dashboard's Dockerfile setting was ignored; build logs showed the
  root Next.js stages, from a stale commit.
- **Critical constraint encoded there.** **Replicas pinned to 1** — the Codeforces
  rate limiter lives in process memory, so a second replica is a second limiter and
  more traffic than CF permits from one address.

### 6.7 The env template was never in the repo

> **Fixed a README that linked to a file no clone ever received**, by negating
> `.env*` for `.env.example`.

- **Root cause.** Next's default `.gitignore` swallows `.env.example` along with
  `.env`. The template holds no values; `.env` itself stays ignored.

### 6.8 The platform renamed the project and broke every sign-in

> **Documented a one-way door**, by recording that Vercel appends a suffix when a
> project name is taken (this one became `cp-trainer-three`) — and an OAuth callback
> registered against the intended name fails 100% of sign-ins. An OAuth app has
> exactly **one** callback, so preview URLs cannot sign in either.

### 6.9 "The site is up" is not "the site is configured"

> **Corrected a documented falsehood that would have hidden a broken deploy**, by
> establishing that a failing `instrumentation.ts` does **not** stop Next from
> serving — it logs and carries on, `db.ts` falls back to localhost, and the only
> tell is a health check failing in half a second while `/signin` renders fine.

### 6.10 Nothing runs migrations for you

> **Prevented silent schema drift in production**, by documenting that no platform
> step runs migrations and shipping `scripts/migrate.mjs` — which applies
> `schema.sql` and pending migrations with the pg driver, because a deploy container
> has no `psql`.

### 6.11 A proxy that buffers SSE looks exactly like a broken feature

> **Kept live updates working behind a reverse proxy**, by configuring Caddy not to
> buffer the SSE route (and sending `X-Accel-Buffering: no` for nginx and friends).

### 6.12 Documentation calibrated on the wrong machine

> **Stopped users from killing a working seed**, by publishing both laptop and
> hosted timings — `pnpm seed` is ~3 minutes locally and was **67 minutes** against
> Neon before batching. Someone would reasonably have assumed it had hung.

---

## 7 · Scheduling: the cron that never fired

### 7.1 Thirty hours of silence with every check green

> **Ended a multi-day misdiagnosis by proving the failure was upstream of the
> repository**, by escalating through an ordered, evidence-producing checklist
> rather than repeated speculative fixes.

- **Symptom.** Zero scheduled runs in ~30 hours. Dispatch never failed. CI passed on
  the very commit that edited the cron. Settings reported "up to date" throughout.
- **What was tried, in order:** toggling the Actions setting → an empty poke commit
  to prove push events were delivered at all → pushing the workflow file itself →
  **renaming** the workflow to force a new record → a temporary probe on `*/5` with
  no secrets, deps or checkout, so a silent hour was *evidence* rather than another
  "maybe it's just delayed".
- **The real mechanism.** A workflow's cron lives on its workflow **record**, keyed
  by file path, and that record is **not re-read when the file changes**. Both
  records still reported `updated_at == created_at` from the moment the repo was
  created — which is when event delivery was dead. So the record was indexed with no
  schedule and kept serving `workflow_dispatch` happily.
- **Resolution.** The cron was deleted rather than left as decoration; a cron that
  does not fire is worse than none. `workflow_dispatch` stays as the manual fallback,
  and DEPLOY.md now carries the checklist, ending in "stop, it is not your config".

### 7.2 A dead schedule rendered identically to a healthy one

> **Made staleness visible instead of implied**, by reporting any run older than two
> hours (four missed passes) as stale in neutral colours, with a pointer to the
> Actions tab.

- **Root cause.** The card said "up to date" whenever the *last run* succeeded,
  however long ago that was.

### 7.3 Scheduling arithmetic against a real budget

> **Kept scheduled syncing inside the free 2,000 Actions minutes/month**, by
> computing it rather than guessing: a pass measured 25 s for 6 members, billing is
> per run **rounded up**, so hourly ≈ 1,500 min and half-hourly ≈ 3,000 — which stops
> working part-way through the month. After batching cut a run to ~20 s, half-hourly
> became viable at ~1,440, and the schedule moved to `:10`/`:40`.
> A **concurrency group** prevents overlapping passes, since each would hold its own
> rate-limit lock and together exceed what CF allows from one address.
> Documented: a 30-member club crosses into ~3 billed minutes a run and must drop
> back to hourly.

---

## 8 · Serverless architecture constraints

### 8.1 Every member could sign in and none could onboard

> **Unblocked onboarding for 100% of members on the serverless deployment**, by
> making the single handle-validation lookup directly from `src/lib/cf.ts` instead of
> through a worker that does not exist there.

- **Symptom.** Sign-in worked; onboarding did not. `POST /api/user` validated a
  handle by calling the worker, so every member was told *"the sync worker isn't
  running — start it with `pnpm worker`"* — meaningless advice, and a hard stop: an
  account with no handle has no data, no estimate, and no place on any board.
- **Why this is a deliberate exception.** The rule "only the worker talks to
  Codeforces" exists so the *thousands* of requests a history mirror makes stay
  behind one rate-limited queue. It is about bulk. This is a single request, made
  once, when someone types their handle — and where a worker does exist, the route
  still prefers it.
- **The pattern behind it.** This was the **third** place routed through the worker
  with no fallback. The other two — "Sync now", "Refresh ICPC sets" — were cosmetic
  and now state what actually happens instead of failing.

### 8.2 Connection pools multiply with instances

> **Prevented "too many clients already" on a capped free tier**, by dropping the pg
> pool to 3 on Vercel — every warm serverless instance holds its own pool — and
> skipping standalone output there, since the platform builds its own bundle.

---

## 9 · Database cost: the meter that never stopped

### 9.1 A silent socket that cost 6 CU-hours a day

> **Reduced idle database compute from 6 CU-hours/day to near zero** — a 100-hour
> monthly allowance was on track to be spent in ~17 days by an app nobody was using —
> by closing the `LISTEN` connection 30 seconds after the last viewer disconnects.
> Verified against a live Postgres: listener backends `0 → 1` on subscribe, `1`
> immediately after unsubscribe, `0` after the grace window.

- **Symptom.** The endpoint stopped suspending entirely. `ENDPOINT INACTIVE` bands
  vanished from the monitoring chart and RAM sat flat at ~400 MB around the clock.
- **First, what it was *not*.** The 400 MB is baseline: shared buffers, WAL buffers,
  the local file cache, and a few MB per backend. It read as "constantly high" only
  because a compute that never suspends never returns to zero. Memory was a
  *symptom*; the billable fault was the connection.
- **Root cause.** `realtime.ts` opened a dedicated client, ran `listen standings`,
  and had **no close path at all** — `subscribe()`'s unsubscribe only removed the
  callback from the fan-out set. Scale-to-zero bills on *"is anything connected"*,
  not on query volume, and a parked `LISTEN` connection is indistinguishable from a
  busy one to that meter.
- **Compounding factor.** With `maxDuration = 60`, every SSE stream is cut each
  minute and the browser reconnects — possibly onto a new instance, which opens
  *another* listener. Frozen instances never closed theirs.
- **Why the fix needs a delay.** Closing the instant the count hits zero would tear
  down and rebuild the connection every 60 seconds. A 30-second grace window rides
  over a reconnect and only truly fires when the last tab is gone.
- **Two leaks fixed alongside.** The `error` handler dropped its reference without
  calling `end()`, leaving half-dead backends to accumulate; and a failed connect
  cached a **rejected promise** on `globalThis`, so every later subscriber inherited
  the same failure forever.
- **Known limit, stated rather than papered over.** Serverless hosts *freeze*
  instances rather than killing them, so an instance frozen mid-stream never runs the
  timer and its socket lingers until the database reaps it. This gets most of the way,
  not all of it.

### 9.2 The architectural conclusion

> **Identified that shared-state pub/sub was a workaround for serverless, not a
> requirement**, by tracing why `pg_notify` existed at all: serverless instances hold
> their subscriber set in local memory and cannot reach each other, so the database
> was the only shared thing available. A single always-on process that both writes and
> holds the sockets reduces the fan-out to an in-process function call — and lets the
> database sleep. Scoped, with its costs named (cross-origin auth; the box becomes
> load-bearing) rather than adopted silently.

---

## 10 · Domain-specific constraints

### 10.1 Kattis cannot be mirrored, by rule

> **Kept ICPC practice within a third party's stated boundaries**, by sourcing solve
> state from this app's own timer rather than scraping.

- **Constraint.** Kattis has **no public API**, and its `robots.txt` disallows
  `/users` and `/submissions`. Solves are recorded as `submissions` rows with
  `source='manual'`, so every solved-check works unchanged while staying auditable.
- **Model boundary.** ICPC problems stay **out** of the mastery model deliberately —
  Kattis carries no topic tags and its 1–10 difficulty is not CF-comparable, so mixing
  it in would corrupt a calibrated scale. Mistake tags from ICPC sessions *do* feed
  the mistake analytics.

### 10.2 Classifying 171 contest sets from their names alone

> **Placed every ingested set on the real ICPC ladder** — qualifier, regional,
> championship, world finals, with North America Championship called out as its own
> rung — by making classification a **pure function of the source name**, so it
> re-derives without re-crawling.

- **Bugs found while classifying:** "Division Championships" was being read as NAC;
  the 2024+ "… Central Division" naming is a *regional*, not a championship; and
  `\bcodesprint\b` never matched "CodeSprintLA", so Code Jam sets survived the
  non-ICPC filter.
- **Partial data made honest.** Sets Kattis only partially publishes (some regionals
  list a single problem) are *marked* rather than left looking broken.
- **Documentation correction.** The crawl finds **171** sources; **165** survive
  classification. The README had been claiming 171.

### 10.3 A favicon that turns to mush

> **Made the tab mark render identically everywhere**, by drawing the `//` as two
> parallelograms rather than setting it as text — a favicon is rasterised at 16 px,
> where a mono font's glyphs depend on whatever font the renderer happens to have.
> Ships as `icon.svg`, a real multi-size `favicon.ico`, and an `apple-icon.png`, so
> browsers requesting `/favicon.ico` by convention stop getting the Next.js default.
> Colours are fixed, not themed — a tab strip has no theme to follow.

---

## 11 · Process

### 11.1 Handing off an unsolved problem without losing the evidence

> **Prevented a known-hard problem from being rediscovered from scratch**, by
> handing it off with the measurements attached: the 86 ms per-statement figure, the
> arithmetic that closes against the observed 1,214 s, the second bug in the same
> loop, the newest-first ordering trap that makes the naive fix lose data, what must
> not break (the verdict upsert branch, idempotency, the CF rate limit, the quick
> path), how to verify end to end (the ability fit must still come out at 1763), and
> the alternatives already rejected — so nobody re-proposes an always-on server as
> the answer to a latency problem.

### 11.2 Documentation as part of the change

> **Kept the runbook executable**, by rewriting DEPLOY.md as a sequential guide and
> fixing two steps that would have failed on contact: seed commands that looked for
> `python` in `node_modules/.bin` rather than the uv venv, and an ordering that
> created the OAuth app *after* Vercel — when the app refuses to boot in production
> without the client id, so the callback URL has to be decided from the project name
> up front.

### 11.3 Invariants extracted from failures

> **Made hard-won constraints cheap to honour and expensive to lose**, by promoting
> each one into [AGENTS.md](AGENTS.md) as it was learned — reserved verdict colours,
> the single CF rate-limit queue, never re-deriving a stored number, `LISTEN` vs
> transaction poolers, the INT8 parser, unused `$N` placeholders, Kattis's
> constraints, the newest-first cursor rule, the 86 ms round trip, and the two FLIP
> details. Every entry in that file was learned by getting it wrong first.

---

## Deliberately deferred

Not omissions — decisions, with the schema already accommodating them.

- **ICPC/NAC curated grind modes** — a hand-built `contest → topic` mapping, so a
  category page could recommend "the DP problems from past NAC sets".
- **Shared virtual contests.** `contest_sessions.user_id` is a single person today.
  Making a Kattis set a room several guildmates share is the one feature where a
  leaderboard would be *genuinely* real-time — every solve is written by this app
  rather than fetched from a judge, so it reaches other screens in well under a
  second with nothing to poll.

---

## Recurring lessons

1. **The dangerous bugs look fine.** The cursor bug, the INT8 mismatch, the dead
   cron, the pooled `LISTEN`, the broken menu-bar app, the stale-but-green sync card
   — none surfaced as an error. Several rendered *identically* to correct behaviour.
2. **Measure before restructuring.** 86 ms per round trip explained a 20-minute sync
   completely. The arithmetic closing is what proved there was nothing left to find.
3. **Local and hosted are different machines.** Row-at-a-time writes, seed timings,
   and pooled connections were all free on Docker and ruinous on Neon.
4. **The container finds what the source cannot.** `HOSTNAME`, IPv6-only binding,
   the untracked `public/` directory, corepack's pnpm version.
5. **Stored numbers beat re-derived ones.** Any formula computed in two places will
   eventually disagree in one of them.
6. **State the limits.** Every fix above that is partial says so — the frozen-instance
   caveat, `seed_usaco` still being slow, the worker box becoming load-bearing.
