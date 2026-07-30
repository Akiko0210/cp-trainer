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

### Option B — Vercel (free) + Neon (free), no worker

Zero machines to run. Deploys from GitHub on push. The compromises are real
and you should know them before choosing:

- **Live updates degrade to polling.** Serverless caps how long a response can
  stream. The app detects this and falls back to a 20-second poll, so the board
  is *correct* but no longer instant — the crown-steal animation fires up to 20s
  late. (Everything else is identical.)
- **Nothing syncs on its own.** With no always-on worker, Codeforces history
  only updates when someone presses *Sync now*, or from a scheduled GitHub
  Action you'd add. Free Vercel cron runs once a day.
- Neon's free database sleeps when idle; the first visitor after a quiet spell
  waits a few seconds.

If the club will mostly check standings a few times a day, B is fine. If you
want the leaderboard to feel live during a practice session, take A.

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
boot creates every table. If a required variable is missing it refuses to start
and names it — that is deliberate; a half-configured deploy that *serves* is
worse than one that doesn't.

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

## Option B: Vercel + Neon

1. Create a Neon project; copy the pooled connection string (it ends in
   `?sslmode=require`).
2. Apply the schema from your laptop:
   `DATABASE_URL='postgres://…' pnpm db:deploy`
3. Import the repo into Vercel, branch `guild`. Set `DATABASE_URL`,
   `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `WORKER_TOKEN` (any random
   string — nothing will call the worker, but the app requires it to boot),
   `PUBLIC_ORIGIN=https://your-app.vercel.app`, `ADMIN_GITHUB_LOGINS`.
4. Register the OAuth app against the Vercel URL, as in step 1 above.
5. Seed as in step 6, against the Neon URL directly.
6. Syncing: members press **Sync now** in Settings. To automate it, add a
   GitHub Action on a schedule that runs the worker's sync against
   `DATABASE_URL` — the worker is a plain Python program and does not need to
   be a service.

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
