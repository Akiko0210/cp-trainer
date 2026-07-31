# Handoff: the sync is 20× slower than it needs to be

**Status:** known, measured, unfixed. The owner has deliberately deferred it —
do not start work on this without asking.

**One line:** `worker/sync.py` writes one row per network round trip, which is
free against a local Postgres and ruinous against a hosted one.

---

## The symptom

A member's first sync takes ~20 minutes against Neon. The GitHub Actions job
that runs it is capped at 15 minutes, so **any member with more than roughly
2,300 submissions can never finish onboarding** through the normal path. Every
hourly run restarts, spends 15 minutes, and is killed.

Smaller histories are fine. This bites the strongest members, who are the ones
a club leaderboard most wants.

## What was measured (2026-07-31, this deployment)

| | |
| --- | --- |
| full first sync, 2,714 submissions, laptop → Neon `us-east-2` | **1,214 s** (20m14s) |
| same work, GitHub runner → Neon | 2,000 rows in ~700 s |
| effective write rate | **~2.9 rows/second** |
| round trip for one trivial statement (`select 1`) | **86 ms** |
| one call returning 500 rows | **90 ms** |
| the same sync against local Docker Postgres | seconds |

The last two rows are the whole story: **500 rows in one call costs the same as
one row in one call.** Latency, not throughput, not Postgres, not Codeforces.

Reproduce the latency measurement:

```sh
node -e 'const {Client}=require("pg");const c=new Client({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true}});
(async()=>{await c.connect();const t=Date.now();for(let i=0;i<20;i++)await c.query("select 1");
console.log(((Date.now()-t)/20).toFixed(1)+" ms/statement");await c.end()})()'
```

## Root cause

[`worker/sync.py`](worker/sync.py), inside `_run()`'s page loop (`for s in subs:`
at line 147), each submission costs **about four separate statements**:

| line | statement | per |
| --- | --- | --- |
| 32 | `upsert_problem()` — one `insert … on conflict` | submission |
| 61 | `link_cf_tags()` — **one execute per tag**, in a Python `for` loop | tag (~2–3) |
| 158 | the `insert into submissions` itself | submission |

So: `2,714 submissions × ~4 statements × 86 ms ≈ 16 minutes`, and the observed
1,214 s is that plus the Codeforces calls and the mastery refit. The arithmetic
closes. There is no mystery left to investigate — go straight to the fix.

Codeforces is **not** the bottleneck: a first sync is 2 API calls (~4.4 s of
rate-limited waiting) out of 1,214 s.

## Second, smaller bug in the same area

`sync_state.last_synced_submission_id` is written only after `_run()` returns
(line 96), but each page commits its rows (line 184). So a killed run **commits
2,000 submissions and records no progress** — the next run re-fetches from
`from=1` and redoes the same work, forever. Even with batching, this is worth
fixing: persist `max_seen` per page, inside the same transaction as the rows.

Careful with the ordering if you do: Codeforces returns submissions
newest-first, so after page 1 `max_seen` is already the newest id overall.
Persisting it naively would make the next run stop immediately and never fetch
the *older* pages. Track a low-water mark for a first sync, or only persist
`max_seen` once the walk is complete.

## The fix

Restructure the page loop into three batched phases. psycopg 3 pipelines
`cursor.executemany()`, so most of the win is available without hand-writing
multi-row `VALUES`.

1. **Problems** — collect the distinct problems in the page, upsert them in one
   statement with `returning id`, build a `{(contestId, index): problem_id}` map.
2. **Tag links** — one `executemany` (or one multi-row insert) for every
   `(problem_id, topic_id)` pair in the page.
3. **Submissions** — one `executemany` for the whole page.

Expected: 4 statements per page instead of ~8,000. A 2,714-submission sync
should land in **well under a minute**, on Actions, for any history size.

### What must not change

- `on conflict (user_id, source, external_submission_id) do update set verdict …`
  — verdicts genuinely change (`TESTING` → `OK`), so this is an upsert, not an
  insert. A batched version must keep the update branch.
- Idempotency. Re-running a sync must be safe; it is how every retry works.
- The Codeforces rate limit stays in `worker/cf_api.py`. Do not parallelise API
  calls to make this faster — the ≥2.2 s gap is the thing keeping this install
  inside what CF allows from one address.
- `quick=true` (the solve-page verdict check) uses the same code path with
  `count=50`. Keep it working; it is latency-sensitive in the opposite way.

### How to verify

```sh
# against a scratch database, not production
DATABASE_URL='postgresql://…' uv run python -c "
import asyncio, time, db, sync
t=time.monotonic()
with db.connect() as c: print(asyncio.run(sync.sync_user(c, <user_id>)))
print(f'{time.monotonic()-t:.0f}s')"
```

Then re-run it: the second pass must report `new_submissions: 0` and change
nothing. Compare `count(*)`, `count(*) filter (where verdict='OK')` and
`users.ability_estimate` before and after — the ability fit is the end-to-end
check, and for the owner's account it must still come out at **1763**.

## Alternatives already considered and rejected

| | why not |
| --- | --- |
| run the sync more often | does not help; each run still can't finish |
| raise the Actions timeout | 15 min was chosen to cap the free minutes budget; the job would still take 20 |
| always-on server + Neon | removes the timeout but each member still takes 20 min of round trips |
| always-on server + **local** Postgres | genuinely fixes it — latency goes to ~0 — but costs a machine to run, and batching fixes it for free |
| parallelise the CF calls | breaks the rate limit; also not the bottleneck |

## Today's workaround

For a member whose first sync can't finish on Actions, run it once from a
laptop, where nothing kills it:

```sh
cd worker && DATABASE_URL='<neon direct string>' uv run python sync_once.py
```

~20 minutes, once per person. Afterwards they are incremental (one page, stops
at the first known id) and every scheduled run is a few seconds.

## Context you will want

- Deployment shape and the free-tier limits: [DEPLOY.md](DEPLOY.md)
- Invariants that are expensive to rediscover: [AGENTS.md](AGENTS.md)
- The scheduled job: [.github/workflows/sync.yml](.github/workflows/sync.yml),
  hourly, 15-minute timeout, ~2,000 free minutes/month on a private repo
- Current scale: 1 member, 2,714 submissions, 18 MB of Neon's 512 MB
