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
- **Syncing moves to a schedule.** `.github/workflows/sync.yml` runs the same
  pass the worker's loop runs, every half hour. A run is ~20s for a couple of
  members and billed as a rounded-up minute, so half-hourly is ~1,440 of a
  private repo's 2,000 free Actions minutes a month. The per-member cost is
  two rate-limited CF calls (~5s), so a 30-person club is a ~3-minute run —
  at that size half-hourly (~4,300) no longer fits and the cron should drop
  back to hourly.
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

### 6. Turn on the scheduled sync

In the repository: **Settings → Secrets and variables → Actions → New repository
secret**

- Name: `DATABASE_URL`
- Value: the Neon **direct** string

Then **Actions → Sync Codeforces → Run workflow** and watch it finish before you
trust the schedule. It should report `N ok, 0 failed`.

There is no *Sync now* button on this deployment — no worker process to poke —
so Settings says "syncing runs every half hour" instead of offering a control
that could only fail. Run this workflow by hand when someone needs their solves
counted immediately. If Settings shows the sync as **stale** (no completed run
for over two hours), the schedule itself has stopped — start with the banner at
the top of the Actions tab.

Note: GitHub disables scheduled workflows in a repository with no pushes for 60
days. It emails first, and one commit re-enables them — but over a summer break
that is exactly how a club tool quietly stops updating.

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
| Actions minutes | 2,000/mo on a private repo | syncs silently stop part-way through the month — half-hourly at 1 min/run is ~1,440; a 30-member club (~3 min/run) must drop to hourly |
| Neon idle suspend | — | first visitor after a quiet spell waits a few seconds |

Making the repo public would give unlimited Actions minutes, at the cost of the
repo being public.

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
