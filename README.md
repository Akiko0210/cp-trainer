# CP Trainer

Personal competitive-programming trainer. Mirrors your Codeforces history,
estimates per-topic mastery, tracks the mistakes you keep repeating, and picks
what to solve next — training continuously toward ICPC Regionals.

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
pnpm db:schema   # apply db/schema.sql (idempotent)
pnpm seed        # topics + curated problems from usaco.guide, then CF problemset
pnpm seed:icpc   # ICPC contest sets from open.kattis.com (~6 min, polite crawl)
pnpm dev:all     # worker (:8787) + Next app (:3000) together
```

Then open http://localhost:3000 and link your CF handle. First sync pulls your
entire submission history (CF allows ~1 request / 2s, so big profiles take a
few minutes; the dashboard shows progress).

`pnpm worker` / `pnpm dev` run the two services separately. Config lives in
`.env` (see [.env.example](.env.example)); the defaults match `pnpm db`.

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

## ICPC practice (Kattis)

171 real contest sets — World Finals, regionals, qualifiers — ingested from
open.kattis.com by [seed_icpc.py](worker/seed_icpc.py). Run a set as a **virtual
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

ICPC/NAC *curated* grind modes (a hand-built `contest → topic` mapping) and
multi-user auth hardening. See the v1 handoff spec for details.
