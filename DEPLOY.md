# Deploying CP Trainer

For a club: one URL your members sign into with GitHub, a database that
survives restarts, and a worker that keeps everyone's Codeforces mirror fresh.

## What this app needs, and why "free" is a real choice

Three long-lived things:

| | why it can't be serverless |
| --- | --- |
| **web** | the live board holds one Postgres `LISTEN` connection per process and one SSE stream per viewer |
| **worker** | the Codeforces mirror is a loop with a rate-limited queue — CF allows ~1 request / 2s and the queue is what keeps you under it |
| **Postgres** | everything |

No free tier gives you all three. So there are two honest options, and the
difference is not price — it is which compromise you make.

### Option A — one always-free VM (recommended)

**Everything works, unchanged.** Oracle Cloud's Always Free tier includes an
ARM VM (4 cores / 24GB) that does not expire; any $4–6/mo box works the same
way. [`docker-compose.yml`](docker-compose.yml) runs web + worker + Postgres +
Caddy, and Caddy gets you a real certificate automatically.

Cost: $0. Trade: it's a machine you own — you apply updates, and you take the
backups (one cron line, below).

### Option B — Vercel (free) + Neon (free) + GitHub Actions

Zero machines to run, deploys from GitHub on push, and closer to A than it
first looks:

- **Updates stay push, with a blink every minute.** A serverless host caps how
  long a response may stream (60s on Hobby, which the stream route asks for).
  So the SSE connection is cut on the minute and the browser reconnects — and
  because the client refetches on every reconnect, nothing that happened during
  the gap is missed. Between reconnects it is as instant as A. Polling at 20s
  is only the floor, for a host or proxy where the stream never works at all.
- **Syncing has to move off the worker's loop, and this is Option B's weak
  point.** The intent was `.github/workflows/sync-codeforces.yml` on a cron,
  running the same pass the loop runs. On this install **that schedule never
  fired once** — see *When the schedule never runs* below before you depend on
  it. What this install actually runs is Option B plus the worker on a ~$5/mo
  Railway service — *The hybrid* below — which restores the loop, the **Sync
  now** button, and the immediate first sync when a member links a handle. The
  workflow remains as a manual dispatch fallback.
- Neon's free database sleeps when idle, so the first visitor after a quiet
  spell waits a few seconds.

The real difference from A is not liveness or sync cadence — both are half
hour — it is that you are depending on three free tiers instead of one
machine.

**Two Neon settings that are not optional here:**

1. `DATABASE_URL` → the **pooled** connection string, for ordinary queries.
2. `DATABASE_URL_UNPOOLED` → the **direct** one. `LISTEN` cannot work through a
   transaction pooler: the connection you registered the listener on gets handed
   to someone else between statements and notifications silently never arrive.
   With this unset on Neon, the board looks connected and never moves.

---

## Option A: the runbook

Everything below is one-time except step 6.

### 1. Register a GitHub OAuth app

<https://github.com/settings/developers> → **New OAuth App**

- Homepage URL: `https://cp.yourdomain.com`
- **Authorization callback URL:** `https://cp.yourdomain.com/api/auth/callback`

Keep this separate from your localhost app — one app, one callback. Copy the
client ID and generate a client secret.

### 2. Point a domain at the box

An `A` record for `cp.yourdomain.com` → the VM's IP. Caddy needs the DNS to
resolve before it can get a certificate, so do this first and give it a minute.

No domain? A free subdomain from DuckDNS or similar works — it just has to
resolve.

### 3. Get the code onto the VM

```sh
ssh you@your-vm
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER && exec su -l $USER   # so docker needs no sudo
git clone https://github.com/AAyurzana/cp-trainer.git && cd cp-trainer
git checkout guild
```

### 4. Write the secrets

```sh
cp .env.example .env
```

Fill in — generate the two secrets, don't invent them:

```sh
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)" >> .env
echo "WORKER_TOKEN=$(openssl rand -base64 32)" >> .env
```

Then edit `.env` and set `DOMAIN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
and `ADMIN_GITHUB_LOGINS=Akiko0210`. Delete the localhost `DATABASE_URL` line —
compose builds the real one from `POSTGRES_PASSWORD`.

`.env` is gitignored. It should never be anywhere but that machine.

### 5. Start it

```sh
docker compose up -d --build
docker compose logs -f web
```

The web container applies the schema before it starts serving, so the first
boot creates every table. If a required variable is missing, the startup check
in `src/instrumentation.ts` logs **which one** — read the container log, not the
page.

Check: `curl https://cp.yourdomain.com/api/health` → `{"ok":true,…}`.

### 6. Seed the content (from your laptop, not the VM)

The topic tree comes from a large usaco.guide clone that deliberately isn't in
the image. Run the seeds locally against the production database — open the
port temporarily or use an SSH tunnel:

```sh
ssh -L 5433:localhost:5432 you@your-vm     # in one terminal
# in another:
DATABASE_URL='postgresql://cp:PASSWORD@localhost:5433/cp_trainer' pnpm --dir worker exec python seed_usaco.py
DATABASE_URL='postgresql://cp:PASSWORD@localhost:5433/cp_trainer' pnpm --dir worker exec python seed_cf.py
DATABASE_URL='postgresql://cp:PASSWORD@localhost:5433/cp_trainer' pnpm --dir worker exec python seed_icpc.py
```

The ICPC crawl is polite and takes ~6 minutes.

### 7. Sign in and start the guild

Open the site, sign in with GitHub, link your Codeforces handle. The first
account is the operator. Create the guild, then share the invite **link** (not
just the code) from the guild page — it survives sign-in, so a member who has
never used the app lands back on the invite after authorising GitHub.

Each member: sign in → link their handle → the worker picks them up within 30
minutes.

### 8. Backups

The whole thing is one database. A daily dump, kept a fortnight:

```sh
mkdir -p ~/backups
crontab -e
```

```cron
0 4 * * * cd ~/cp-trainer && docker compose exec -T db pg_dump -U cp cp_trainer | gzip > ~/backups/cp-$(date +\%F).sql.gz && find ~/backups -name 'cp-*.sql.gz' -mtime +14 -delete
```

Restore: `gunzip -c backup.sql.gz | docker compose exec -T db psql -U cp -d cp_trainer`.

Test the restore once, into a scratch database, before you need it.

### Updating

```sh
git pull && docker compose up -d --build
```

Migrations run on boot. The database volume is untouched by a rebuild.

---

## Option B: the runbook (Vercel + Neon + Actions)

About 30 minutes. Three accounts, no card. Do the steps in order — two of them
have a dependency that is easy to miss, and both are called out where they bite.

### 0. The repo has to be on the account you will connect to Vercel

Vercel only offers you repositories from the GitHub account you link it to.
Check which account owns yours:

```sh
gh api user --jq .login          # who the CLI is
git remote -v                    # where pushes go
```

If those disagree with the account you intend to use, fix it before going
further:

```sh
gh auth logout && gh auth login                       # sign in as the right one
gh repo create <you>/cp-trainer --private
git remote set-url origin https://github.com/<you>/cp-trainer.git
git push origin main guild group icpc-practice
```

### 1. Neon

Create a project. **Put it in the region nearest the one Vercel will use** —
both default to US East, and a mismatched pair adds a cross-country round trip
to every query on every page load.

From the dashboard, copy **both** connection strings:

- the **pooled** one — its host contains `-pooler`
- the **direct** one

You need both. They are not interchangeable: `LISTEN` cannot work through a
transaction pooler, so the live leaderboard gets the direct one while everything
else uses the pooled one.

### 2. Schema and seed, from your laptop

Nothing on Vercel runs these — the seeds need a large usaco.guide clone that is
deliberately not deployed, and the schema is applied deliberately rather than on
every boot.

Use the **direct** string here — the host must NOT contain `-pooler`:

```sh
export CPDB='postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require'
```
```sh
DATABASE_URL="$CPDB" pnpm db:deploy
```
```sh
DATABASE_URL="$CPDB" pnpm seed
```
```sh
DATABASE_URL="$CPDB" pnpm seed:icpc
```

`db:deploy` prints the table count when it finishes.

**Give the seeds room and don't kill them.** They are much slower against a
hosted Postgres than a local one, because a round trip is ~86 ms there and
effectively free on a laptop — so anything writing a row at a time pays for
every row. Measured against Neon us-east-2 from a laptop:

| | local Docker | Neon |
| --- | --- | --- |
| `pnpm db:deploy` | instant | instant |
| `pnpm seed` — usaco.guide half (topics, curated lists) | ~3 min | **minutes**; still a round trip per row |
| `pnpm seed` — CF problemset half (~14,000 problems) | seconds | seconds — 4 statements, batched |
| `pnpm seed:icpc` (Kattis, 2s per page) | ~6 min | ~8 min |

The CF half used to be the bulk of this: ~49,000 round trips, about 67 minutes.
`seed_cf.py` now sends the whole problemset in a handful of statements.
`seed_usaco.py` has not had the same treatment — its inserts are nested (chapter
id feeds module id feeds problem), so it is a real restructuring rather than a
batch call, and it is still the slow part of `pnpm seed`.

They are idempotent, so an interrupted run can simply be run again.

**Do this before anyone signs in.** It is the skeleton every estimate,
recommendation and category page hangs off. And **do not** run
`db/seed-demo-guild.sql` against production — it invents six members on
strangers' Codeforces handles, which is useful on a laptop and confusing in a
club whose roster is meant to be real.

### 3. GitHub OAuth app

**Decide the Vercel project name first**, because the callback URL contains it.
A project named `cp-trainer` is served at `https://cp-trainer.vercel.app`.

Watch for a suffix: if that name is taken across Vercel, you get something like
`cp-trainer-three.vercel.app`, and a callback registered against the name you
*intended* will fail every sign-in with a redirect-URI mismatch. Confirm the
real domain on the project's page before you fill this in.

<https://github.com/settings/developers> → **New OAuth App**

- Application name: anything
- Homepage URL: `https://cp-trainer.vercel.app`
- **Authorization callback URL:** `https://cp-trainer.vercel.app/api/auth/callback`

Copy the client ID, then **Generate a new client secret** and copy that too — it
is shown once.

Two things worth knowing: an OAuth app has exactly **one** callback URL, so
sign-in works on the production URL only and not on Vercel's per-commit preview
URLs. And the callback is editable at any time, so if the deployed URL turns out
different, come back and change it.

### 4. Vercel

**Add New → Project → Import** your repository (connect the GitHub account from
step 0). Then, before deploying:

- **Project name**: the one you used in step 3
- **Framework**: Next.js, detected automatically — change nothing
- **Production branch**: `main`
- **Environment variables** — add these to *Production*:

| name | value |
| --- | --- |
| `DATABASE_URL` | Neon **pooled** string |
| `DATABASE_URL_UNPOOLED` | Neon **direct** string |
| `GITHUB_CLIENT_ID` | from step 3 |
| `GITHUB_CLIENT_SECRET` | from step 3 |
| `PUBLIC_ORIGIN` | `https://cp-trainer.vercel.app` |
| `ADMIN_GITHUB_LOGINS` | your GitHub login |

There is no `WORKER_URL` and no `WORKER_TOKEN` here on purpose: this deployment
has no worker process, and the app only demands a worker token when a worker is
actually configured.

Then **Deploy**.

### 5. Check it actually came up

```sh
curl https://cp-trainer.vercel.app/api/health
```

Expect `{"ok":true,"db_ms":…}`. `db_ms` above a second or two means Neon was
asleep and has just woken, which is normal for the first request.

If it answers `{"ok":false,"error":"database unreachable"}`, the cause is
almost always missing environment variables — and it will **not** look like it.
Next.js logs a failing instrumentation hook and then serves the app anyway, so
the site comes up, `/signin` renders (it touches no database when you have no
cookie), and only the health check fails. Meanwhile `src/lib/db.ts` has fallen
back to its localhost default and is trying to reach `localhost:5488` from
inside a Vercel function, which is refused in well under a second.

A fast failure is the tell: a genuinely unreachable database takes the full
10-second connection timeout.

Read the real error at **Vercel → your project → Logs**, or with the Vercel MCP
/ CLI. It names every variable that is missing:

> `Missing required environment variable(s) in production: DATABASE_URL,
> GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET`

Then add them (below) and **redeploy** — environment variables only apply to
deployments created after they were set.

### 6. Set up syncing

In the repository: **Settings → Secrets and variables → Actions → New repository
secret**

- Name: `DATABASE_URL`
- Value: the Neon **direct** string

Then **Actions → Sync Codeforces → Run workflow**. It should report
`N ok, 0 failed`.

That is a manual button, and on this install it is the *only* trigger, because
the cron never worked. There is no *Sync now* button in the app either — no
worker process to poke — so Settings says solves appear on a schedule and shows
the sync as **stale** once no run has completed for two hours.

**Before choosing Option B, read the next section.** Unattended syncing is the
whole point of Option B, and it is the part that failed.

### When the schedule never runs

On this install, `schedule` produced **zero** runs across ~30 hours while
`workflow_dispatch` succeeded every time. Everything below was tried; none of it
produced a single scheduled run.

Work through it in this order — the first two are ordinary and do get hit:

1. **Is the repo delivering events at all?** Push a commit and check:

   ```sh
   gh api repos/<repo>/commits/<sha>/check-suites --jq '.check_suites[].app.name'
   ```

   If every connected app appears *except* "GitHub Actions", event delivery is
   dead — no push, PR or cron will ever fire, while **Run workflow** keeps
   working, so nothing looks broken. Fix: **Settings → Actions → General →
   Disable Actions**, save, re-enable. This is real and it did fix pushes here.

2. **Is the cron actually registered?** A schedule lives on the *workflow
   record*, keyed by file path, and is **not** re-read when the file's contents
   change:

   ```sh
   gh api repos/<repo>/actions/workflows --jq '.workflows[] | {name, updated_at}'
   ```

   If `updated_at` still equals `created_at` after you pushed an edit to that
   file, it was never re-indexed — the schedule does not exist no matter how
   correct the YAML is, and CI passing on the same commit proves nothing.
   **Renaming the file** forces a fresh record; editing it does not.

3. **Prove it with a probe rather than waiting.** A workflow with no secrets,
   no checkout and no dependencies on `*/5 * * * *` (GitHub's floor) turns a
   30-minute guess into a 5-minute answer. If the probe never fires, the fault
   is not your workflow.

4. Also ordinary: schedules are best-effort and delayed under load, and GitHub
   disables them in a repo with no pushes for 60 days (it emails first) — over
   a summer break that is exactly how a club tool quietly stops updating.

If all of that is clean and it still never fires, stop: it is not your config.
Both the repo-settings toggle *and* making the repository public were tried here
with no effect, matching an open, unanswered GitHub community report. Move the
sync to a worker that owns its own loop — the hybrid below, or **Option A** —
rather than spending another day on it.

### The hybrid that this install actually runs: worker on Railway

Vercel and Neon stay exactly as Option B left them; a ~$5/mo Railway service
runs `worker/app.py`, whose loop syncs every member every
`SYNC_INTERVAL_MINUTES`. That loop is what the Actions cron was standing in
for. Verified end to end on 2026-08-03: the pass fires on the half hour with
nothing external triggering it, and linking a handle syncs immediately.

The repo already carries [`railway.json`](railway.json), which pins the build
to `worker/Dockerfile` and the healthcheck to `/health` — no dashboard build
configuration.

1. **GitHub access.** Railway sees repositories through its GitHub App
   *installation*, not your OAuth login. If its repo picker says "No
   repositories found", fix the grant at github.com/settings/installations →
   Railway → add the repo — and install under the account that owns the repo.
   A grant is by repository *id*: re-creating a repo, or flipping
   private→public, silently orphans the old grant. A half-broken connection
   can still clone once and then never deliver another push, which presents as
   Railway forever building a stale commit; "Redeploy" rebuilds that same
   commit, so use "Deploy latest commit" after fixing the grant.
2. **New service** from the repo. Region: match the database — Neon
   `us-east-2` means **US East**, or every statement pays a cross-country
   round trip (§ the 86 ms lesson).
3. **Variables:** `DATABASE_URL` (the Neon **direct** string), `WORKER_TOKEN`
   (`openssl rand -hex 32` — Vercel gets the identical value),
   `SYNC_INTERVAL_MINUTES=30`, and `PORT=8787` so the app, the healthcheck and
   the domain all agree on one port. `serve.py` binds whatever `PORT` says
   (Railway injects one otherwise) and listens dual-stack (`::`), because
   Railway's healthchecks arrive over IPv6 — an IPv4-only bind reads as
   "service unavailable" from a process that is demonstrably up.
4. **Networking → Generate Domain**, routed to **8787**. Then prove both
   halves from any terminal: `GET /health` answers `{"ok":true}`, and an
   unauthenticated `POST /sync/1` answers **401** — run the second one; a
   worker that answers anything else is publicly triggerable.
5. **Vercel:** set `WORKER_URL=https://<the domain>` (no trailing slash) and
   `WORKER_TOKEN`, then redeploy. The Settings page swaps the schedule notice
   for a live **Sync now** button — that's `workerConfigured()` flipping, and
   the same flip makes a newly linked handle mirror its history immediately.
6. **Never scale above 1 replica.** The Codeforces rate limiter and per-user
   locks live in process memory; two replicas is two rate limiters from one
   address.

The box is stateless — all data is in Neon — so if the service dies, recreate
it from these six steps and nothing is lost. `sync-codeforces.yml` remains as
a manual dispatch for the day the worker is down, and the Settings card shows
**stale** once nothing has completed for two hours.

### 7. Take the install, then open it up

Visit the URL, **Sign in with GitHub**, and link your Codeforces handle. The
first account is the operator (or whoever `ADMIN_GITHUB_LOGINS` names).

Create the guild, then share the invite **link** rather than the bare code — the
link survives the GitHub round trip, so a member who has never used the app
lands back on the invite after authorising instead of on a dashboard with no
guild.

Each member: sign in → link their handle → they appear on the boards after the
next half-hourly sync. A first sync mirrors the member's whole history inside that
run — a few seconds even for several thousand submissions, because each page is
written in a handful of statements rather than one per row. A run interrupted
part-way through the history re-reads it from the top next time, which is now
cheap; nothing is lost or double-counted either way.

### 8. Menu bar app, if you want it (macOS, optional)

**Settings → Menu bar app → Pair the menu bar app**, then run the two `defaults
write` lines it gives you — they point the app at the deployed URL and give it
its own token. Rebuild with `cd menubar && ./build.sh`.

---

## Shipping changes after the first deploy

Push to `main`; Vercel builds and promotes automatically.

**Migrations are the exception — nothing runs them for you.** When a change
touches `db/`, apply it yourself, before or immediately after the deploy:

```sh
DATABASE_URL="$CPDB" pnpm db:deploy
```

(You can automate this by setting Vercel's build command to
`node scripts/migrate.mjs && next build`, but then every preview build migrates
your production database too — which is why it is not the default.)

**Rolling back** the app is instant: Vercel → Deployments → the previous one →
**Promote to Production**. Rolling back the *database* is not — Neon keeps a
short restore history, so check what your plan retains before you need it.

### What to watch on the free tiers

| | limit | what it looks like when you hit it |
| --- | --- | --- |
| Neon storage | 0.5 GB | writes start failing; your database is ~31 MB with 6 members, so it is roughly 5–10 MB per active member |
| Neon direct connections | one per open live stream | the board stops updating for late arrivals; only a concern above ~20 people watching at once |
| Actions minutes | 2,000/mo on a private repo, unlimited on a public one | only bites if you get a schedule working at all; billing rounds each run up to a minute |
| Neon idle suspend | — | first visitor after a quiet spell waits a few seconds |

Making the repo public gives unlimited Actions minutes, at the cost of the repo
being public. It does **not** fix a schedule that never fires — that was tried
here, and changed nothing.

---

## Security notes

What is already true of this branch, so you know what you are and aren't
relying on:

- **No passwords, ever.** Sign-in is GitHub OAuth; sessions are opaque random
  tokens in HTTP-only cookies, with the row in Postgres as the source of truth
  so any session can be revoked server-side.
- **The dev-only sign-in cannot exist in production.** `/api/auth/local` is
  gated on `NODE_ENV === "development"` *and* no OAuth credentials configured.
- **The worker is not on the internet.** No published port, and every acting
  endpoint additionally requires `WORKER_TOKEN` — it can re-sync any member's
  history and crawl Kattis, so reaching it must not be the same as being
  allowed to drive it.
- **Postgres is not on the internet.** No published port; only the other
  containers can reach it.
- **Operator actions are separated from membership.** Re-crawling Kattis is
  restricted to `ADMIN_GITHUB_LOGINS`.
- **Paired devices are least-privilege.** The menu bar app's token can read
  your streak and nothing else — in particular it cannot mint another token.
  Revoke all of them from Settings.

Rotate a secret by changing it in `.env` and running
`docker compose up -d`. Rotating `WORKER_TOKEN` needs both services restarted
together, which that command does.
