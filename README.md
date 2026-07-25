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
  ([sync.py](worker/sync.py)), the mastery heuristic
  ([mastery.py](worker/mastery.py) — the one tunable module), and the
  usaco.guide / CF problemset seeds. Re-syncs every user on an interval.
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
- **Estimate** per topic/category = recency-weighted (90-day half-life)
  average difficulty of your solved problems there, bumped for clean solves
  (≤1 WA, fast debug) and docked for grindy ones. "How hard is what you solve
  here."
- **Score (0–100) is current heat**, not lifetime achievement:
  `level × evidence × freshness` — level maps the estimate against your CF
  rating, evidence scales with solves in the last 90 days (floor 0.3),
  freshness is 1.0 for a month after your last solve and then halves every 90
  days. 100 = on fire right now; a topic idle 200+ days reads single digits
  regardless of how strong it once was. Formula in
  [mastery.py](worker/mastery.py); every category page shows the three
  factors and the contributing problems — no black box.
- **Attempts** (the timer in Solve) unlock think/debug splits: the judge's own
  timestamps for submissions inside the session window are the source of
  truth; you only ever supply the start time and the mistake tags.
- **Recommendations** = unsolved problems in the target topic, rated just
  above your topic estimate, curated (usaco.guide) picks first. With no topic
  chosen, weak/stale topics (weighted by recent mistake concentration) pick
  the topic.

## Deliberately deferred (schema already accommodates)

Kattis integration, ICPC/NAC contest grind modes, ELO-style inferred rating,
multi-user auth hardening. See the v1 handoff spec for details.
