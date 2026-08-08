# CP Trainer

Personal competitive-programming trainer. Mirrors your Codeforces history,
estimates per-topic mastery, tracks the mistakes you keep repeating, and picks
what to solve next — training continuously toward ICPC Regionals.

For the engineering record — what was built, and every problem that had to be
solved to get there, with the measurements — see **[PROJECT.md](PROJECT.md)**.

## Architecture

- **`src/`** — Next.js (App Router) + Tailwind. Reads Postgres directly in
  server components; API routes handle attempts, mistake tags, and poking the
  worker. Never calls the Codeforces API in bulk.
- **`worker/`** — Python (FastAPI). Owns all CF API traffic through one
  backoff-aware rate-limited queue ([cf_api.py](worker/cf_api.py)), the
  passive full-history mirror + attempt reconciliation
  ([sync.py](worker/sync.py)), the ability model
  ([estimator.py](worker/estimator.py)) and mastery assembly
  ([mastery.py](worker/mastery.py)), and the usaco.guide / CF problemset /
  Kattis-ICPC seeds. Re-syncs every user on an interval.
- **`db/schema.sql`** — Postgres. The spine: objective `submissions`
  (judge-mirrored) and subjective `attempts`/`mistakes` (user-supplied) are
  separate tables, reconciled by problem + time window. Multi-tenant from day
  one (every table carries `user_id`).

## Run it

Prereqs: Node + pnpm, Python + [uv](https://docs.astral.sh/uv/), Docker (for
Postgres), `node` on PATH (the usaco.guide seed evaluates `ordering.ts`).

```sh
pnpm install
pnpm db          # start Postgres 16 in Docker on :5488 (persistent volume)
pnpm db:schema   # apply db/schema.sql to the Docker Postgres above
pnpm db:migrate  # only for a database created before a schema change
                 # (deploying? `DATABASE_URL=… pnpm db:deploy` does both, over
                 #  the network, without needing psql installed)
pnpm seed        # topics + curated problems from usaco.guide, then CF problemset
pnpm seed:icpc   # ICPC contest sets from open.kattis.com (~6 min, polite crawl)
pnpm dev:all     # worker (:8787) + Next app (:3000) together
```

Then open http://localhost:3000 and link your CF handle. First sync pulls your
entire submission history (CF allows ~1 request / 2s, so big profiles take a
few minutes; the dashboard shows progress).

`pnpm worker` / `pnpm dev` run the two services separately. Config lives in
`.env` (see [.env.example](.env.example)); the defaults match `pnpm db`.

To put this in front of a club, see **[DEPLOY.md](DEPLOY.md)**. Either one
always-on box running [docker-compose.yml](docker-compose.yml) (free on a VM
you own), or the shape this install runs: Vercel + Neon, free, plus the worker
on a ~$5/mo Railway service. The worker is the part that cannot be serverless —
its loop is what syncs on a schedule, it serves the uncut live stream, and it
is why "Sync now" works and a newly linked handle mirrors immediately. The
GitHub Actions cron that was meant to replace it **never fired once**;
DEPLOY.md has the diagnosis and the verified Railway runbook.

## How the numbers work

- **Taxonomy**: 8 canonical ICPC categories (Fundamentals, Data Structures,
  Graphs, DP, Math, Strings, Geometry, Flows & Matchings). Every usaco.guide
  module maps into one, with its division as the tier (Bronze=Basics …
  Advanced=Expert). Mapping lives in [categories.py](worker/categories.py).
- **Estimate** = a fitted ability, not an average. A Codeforces rating is
  *defined* as the level at which you solve a problem 50% of the time, so
  ability is recovered by maximum-a-posteriori fit under the Rasch / 1-PL IRT
  (Elo 400-point) model over every problem you engaged with — successes **and**
  failures. Averaging only your solves is survivorship bias and reads far too
  high. Details and the two corrections that matter are documented at the top
  of [estimator.py](worker/estimator.py):
  - *Selection bias.* You choose what to open and grind practice until it
    falls, so ~90% of your history is solved. CF avoids this by rating problems
    against every round participant, including those who never opened them; we
    reproduce it by counting all problems of every contest entered. Validated:
    took this account's fit from 1921 to 1703 against a true rating of 1595.
  - *Regime.* Contest submissions (`participantType`) are the calibrated case.
    Practice solves get a difficulty discount and less weight (unlimited time,
    editorial available); practice *failures* count fully — couldn't do it with
    unlimited time is a strong ceiling signal.
- **Two levels.** A calibrated global anchor (`users.ability_estimate`) from
  full contest sets, then per-topic fits over engaged problems only, pooled
  toward that anchor so a topic with three observations reads "about your usual
  level" instead of swinging. Never-opened contest problems calibrate the
  absolute level but say nothing about a *topic*, so they're excluded there.
  The measured gap between the two universes (`users.selection_offset`) is
  subtracted from topic estimates to put them on one scale.
- **Score (0–100) is current heat**, not lifetime achievement:
  `level × evidence × freshness` — level compares the topic to your own overall
  ability, evidence scales with recent observation mass (floor 0.3), freshness
  is 1.0 for a month after your last activity and then halves every 90 days.
  100 = on fire right now; a topic idle 200+ days reads single digits no matter
  how strong it once was. The worker stores the factors it actually used in
  `topic_mastery.factors`, and the UI renders those rather than re-deriving the
  formula — every category page shows the factors plus each observation's
  `push` (how far that outcome moved the fit), so the arithmetic is auditable.
- **Attempts** (the timer in Solve) unlock think/debug splits: the judge's own
  timestamps for submissions inside the session window are the source of
  truth; you only ever supply the start time and the mistake tags.
- **Recommendations** = unsolved problems in the target topic, rated just
  above your topic estimate, curated (usaco.guide) picks first. With no topic
  chosen, weak/stale topics (weighted by recent mistake concentration) pick
  the topic.

## Guild: one club, and who holds what

A guild is your club — the first being SJSU Competitive Programming. One person
founds it and shares an eight-character invite code (no ambiguous characters, so
it survives being read off a whiteboard) or the link that wraps it.

**You belong to exactly one guild.** That constraint is the feature, not a
restriction: because affiliation is single-valued it lives on `users.guild_id`,
so "my guild" is never ambiguous and the standings can follow you around the app
instead of sitting on a page you have to remember to open. They appear in four
places, all fed by one stream and one champions store, so they can never
disagree with each other:

- **the header chip**, on every page — your rank, your crowns, live
- **every category card** on the dashboard — who holds that area
- **the category page** — the guild's top ten *in that area* beside the header,
  with your own row pinned underneath at its real placement if you're below the
  ten, and how many points you are from the crown
- **`/guild`** — the champions grid and the full boards

### Who holds what

Eight areas, eight holders, ranked on the **per-area Rasch estimate** rather than
the 0–100 heat score. Heat decays when you stop practising, and an area title
should be lost to someone getting better, not to the holder taking a week off.
A card names the holder, the runner-up, and where you sit; when a crown changes
hands the card announces it for a few seconds rather than quietly showing a
different name.

The full boards are three: **Ability** (the calibrated Rasch estimate, optionally
narrowed to one area — the honest "Elo", unfarmable by grinding easy problems
because the fit prices what you fail as well as what you clear), **Streak**, and
**Solved · 30d**.

**Everything is live.** Triggers on `submissions`, `topic_mastery` and `users`
`pg_notify` a `standings` channel with the guild in the payload; one LISTEN
connection fans out to an SSE stream per viewer (filtered server-side by
guild, so a member who joins while you're watching appears immediately), and
one client-side stream per tab tells every guild surface to re-fetch. With a
worker configured the stream comes from the worker itself — browsers connect
to it directly with a token the app signs, so no serverless duration cap ever
cuts it and the whole thing costs one database connection; without one, the
web app serves the same stream per Node process. When the order changes, rows **physically travel** from their old rank
to the new one via FLIP, carrying a `▲2` / `▼1` badge for a few seconds, and your
own row gets a ring pulse when you climb. Under `prefers-reduced-motion` rows cut
instead of sliding and the badge holds still; in a background tab the FLIP is
skipped entirely, since `requestAnimationFrame` never fires there and a
half-finished FLIP would leave the list looking shuffled.

Leaving hands the guild to its longest-standing remaining member, so a club is
never left with a code nobody can rotate.

### Auth

Sign-in is **GitHub OAuth** — a club tool has no business storing other
people's passwords, and every competitive programmer already has an account.
An invite link survives it: the target is carried through the OAuth round trip
in a cookie, so someone who wasn't signed in lands back on the invite rather
than on the dashboard.

Register an app at [github.com/settings/developers](https://github.com/settings/developers)
with callback `http://localhost:3000/api/auth/callback`, then:

```sh
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

Until those exist, `next dev` offers **Continue as local user**, which signs
you into the local account holding your mirrored history — so a solo install
never needs an OAuth app. That route 404s in production or as soon as real
credentials are set.

Each member links their own Codeforces handle (one handle per member, enforced),
and the worker syncs everyone on its schedule. A handle can be unlinked again
from Settings: the mirrored CF history and topic mastery go with it — they are
that handle's judge record, not the account's — while attempts, mistake tags
and Kattis solves stay. Linking a different handle does the same purge first,
so two people's histories never merge under one account.

To see a populated guild before real members join, apply
[db/seed-demo-guild.sql](db/seed-demo-guild.sql) — six demo members on real
public Codeforces handles chosen near this account's own level, so the champions
grid shows a contest rather than one grandmaster sweeping all eight areas. The
file says how to remove them.

### The arena: duels and custom contests

Two ways a guild races, both deliberately rating-free — nothing in the arena
writes to mastery or the ability fit, so losing a duel costs pride and only
pride.

A **duel** is a challenge to one guildmate: the invitation holds for five
minutes, and accepting it starts a 45-minute race on one random problem —
rated near the pair's average, drawn from the mirrored CF problemset, and
untouched by either player (any past submission counts as touched; a problem
half-solved last month is a head start). First accepted solution wins, on the
judge's own clock. A **guild contest** is the same idea for the whole roster:
anyone opens a lobby naming a problem count, a rating band and a duration;
members join; the creator starts it, which is when the problems are chosen —
against the final field, so nobody has seen theirs. The board ranks by solves,
ties broken by summed solve time, with no wrong-answer penalty: a fun contest
that punishes trying is neither.

Solving happens on Codeforces as usual. Detection is the worker's arena loop
([worker/arena.py](worker/arena.py)): while something is live it polls each
participant's newest submissions through the same rate-limited queue as every
other CF call, writes them into the ordinary mirror, and settles winners in
SQL. The loop is *dormant unless something is live* — the app pokes it when a
race starts, it parks itself when the last one ends — because an always-on
poll would keep a scale-to-zero database awake around the clock for a feature
nobody is using at 4am. No worker, no arena: the UI says so rather than
offering a race nobody can win.

## Streak, and the menu bar readout

The dashboard opens with the streak because the motivating moment isn't "you
have a streak" — it's "your streak is alive and today is still open". Three
states: **on fire** (today logged), **at risk** (alive, today still open — the
one time the UI actively nags), and **cold**. A day counts if you made a
Codeforces submission *or* ran a timed attempt, so ICPC work counts too.

It's a slim band, not a hero. The streak is a *status* and Mastery is the
page's subject; a status worth a fifth of the viewport pushes the thing you
came for below the fold. Same three states, one row
([StreakBar.tsx](src/components/StreakBar.tsx)).

The same three states sit in the site header on every page, as a chip: the
streak gradient when today is logged, an outlined pulsing flame and `4!` when
it's alive but today is still open, a quiet `0` when there's nothing to lose.
It links to /solve, because from any page that isn't the dashboard the useful
answer to seeing `4!` is to go and solve something.

`menubar/` is the same readout outside the browser — a standalone macOS menu
bar app, plain AppKit, no SwiftBar or xbar needed:

```sh
cd menubar && ./build.sh && open CPStreak.app
```

It polls [`/api/streak`](src/app/api/streak/route.ts) and shows a **filled
flame + count** when today is logged, a **hollow flame + `5!`** when the streak
is alive but today isn't, and a **dash** when the trainer isn't reachable (never
a false zero). The dropdown has the streak, your best, the next milestone, a
14-day strip, and shortcuts to solve or open the dashboard. To start it
automatically: System Settings → General → Login Items → add `CPStreak.app`.

**It has to be paired.** The app is not a browser and can hold no cookie, so
since sign-in became a requirement it authenticates with a token of its own:
**Settings → Menu bar app → Pair the menu bar app**, then run the two lines it
prints. Unpaired, it shows a **key** rather than a flame, which is the honest
answer — it can reach the trainer but isn't allowed to read anything.

```sh
defaults write local.cptrainer.streak baseURL https://your-deployment
defaults write local.cptrainer.streak deviceToken <token from Settings>
```

The token is an ordinary session row: it expires on its own, and pairing again
replaces it.

## Upcoming contests

The worker mirrors each judge's contest calendar into a global
`upcoming_contests` table (one fetch per source every
`CONTEST_REFRESH_MINUTES`, default 6 hours — see
[contests.py](worker/contests.py)); the app reads that table, never a judge,
and caches that read for five minutes — the calendar is the same for everyone
and changes on the worker's schedule, so the dashboard doesn't pay a query
per load for it.

Two surfaces, one mirror. The **dashboard card** is the next five rounds in
*your* timezone with a live countdown; **`/contests`** is the whole calendar,
grouped by day (Today / Tomorrow / weekday) and filtered by judge and by how
far ahead you care to look. Each row carries its judge's mark rather than
repeating the platform's name in the text.

Those marks are not the judges' brand colours, on purpose: Codeforces red,
LeetCode orange and HackerRank green would collide head-on with the one colour
rule this app has — green/red/amber mean AC/WA/TLE and nothing else — and a red
badge beside a red verdict badge reads as a verdict. Each judge gets the
nearest hue from the category palette instead.

Sources follow the same rule that keeps this app from scraping Kattis — use
what each site permits:

- **Codeforces** — the official API, through the shared rate-limited queue.
- **AtCoder** — no contests API exists, but its robots.txt allows
  `/contests/`, so the schedule table is read from the page itself (regex, the
  same way the Kattis archive crawl reads pages).
- **CodeChef** — the JSON endpoint its own frontend uses; `/api` is not
  disallowed by their robots.txt.
- **Everything else via [clist.by](https://clist.by)**, opt-in: set
  `CLIST_USERNAME` + `CLIST_API_KEY` (free account → API key), and optionally
  `CLIST_RESOURCES` (comma-separated hosts, default
  `leetcode.com,usaco.org`). This is how LeetCode arrives — its robots.txt
  forbids `/graphql`, `/api/` and `/*/api`, and its pages answer 403 to
  anything that isn't a browser, so there is no direct route to take. Hosts
  already covered natively are filtered out so nothing appears twice.
  **Without these two variables set, no LeetCode contests appear at all** —
  the worker logs one line per refresh saying so.

Each judge is shown with its own logo, drawn as a vector rather than
hotlinked, so no page load sends the viewer's IP out to four judges. The
colours are sampled from each judge's real favicon; AtCoder's crowned crest is
reduced to its shield and monogram, because nothing else in it survives 20px.

Each source replaces only its own rows on refresh, so a rescheduled round
moves, a cancelled one disappears, and one judge's outage never blanks the
others.

**Remind me** turns on a browser notification 15 minutes before each round. It
is a plain Web Notification scheduled in the tab, so it only fires while a
trainer tab is open — the honest constraint, accepted on purpose: real push
would need a service worker, a push service, and server-side device rows, all
to duplicate what codeforces.com's own calendar subscription already does. The
case this covers is the one that actually happens: you are grinding in one tab
and would otherwise miss the round starting. Each reminder fires once (recorded
per contest in `localStorage`), and it is scheduled from the *unfiltered* list —
the filter on `/contests` is a view of the board, not a decision about which
rounds you get told about.

Kattis has no contest feed (no API) — the same reason its solves can't be
mirrored — so it is the one judge the calendar can't carry.

## ICPC practice (Kattis)

165 real contest sets — World Finals, regionals, qualifiers — ingested from
open.kattis.com by [seed_icpc.py](worker/seed_icpc.py). (The crawl finds 171
sources; six are Code Jam and similar, dropped by the classifier in
[icpc_taxonomy.py](worker/icpc_taxonomy.py).) Run a set as a **virtual
contest**: one countdown clock over the whole set, one problem at a time, splits
measured from the start, then an ICPC-style summary (solved count, penalty, per
problem splits) with one-tap mistake tagging on the ones that got away.

Kattis has **no public API**, and its `robots.txt` disallows `/users` and
`/submissions` — so solve state there can never be mirrored the way Codeforces
is. That is a hard constraint, not a gap: solves come from the app's own timer
(hitting *Solved* records one) or an explicit *Mark solved*, stored as
`submissions` rows with `source='manual'` so every solved-check works unchanged
while staying auditable. The archive itself changes about once a year, so
refreshing it is a button in Settings, not a schedule.

ICPC problems stay out of the mastery model on purpose — Kattis carries no
topic tags and its 1–10 difficulty is not CF-comparable, so mixing it in would
corrupt a scale that is currently calibrated. Mistake tags from ICPC sessions
*do* feed the mistake analytics totals.

## Deliberately deferred (schema already accommodates)

- **ICPC/NAC curated grind modes** — a hand-built `contest → topic` mapping, so
  a category page could recommend "the DP problems from past NAC sets".
- **Shared virtual contests.** `contest_sessions.user_id` is a single person, so
  a Kattis set is you against the clock. Making it a room several guildmates
  share is the one feature where a leaderboard would be *genuinely* real-time —
  every solve is written by this app rather than fetched from a judge, so it
  reaches the other screens in well under a second with nothing to poll.

Multi-user auth is no longer deferred: sign-in, sessions, per-device tokens and
guild membership are all built. See the Guild and Auth sections above.
