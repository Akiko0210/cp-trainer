-- Upcoming-contest mirror. Idempotent; safe to re-run.
--
-- Global, not per-user: a contest calendar is the same for everybody, so one
-- table serves every dashboard. The worker owns it the same way it owns
-- submissions — it is the only process that talks to any judge — with one
-- fetcher per source (worker/contests.py: Codeforces' official API, AtCoder
-- via the kenkoooo dataset, CodeChef's public JSON, and clist.by as an opt-in
-- umbrella for judges that permit nothing direct, like LeetCode). A refresh
-- replaces only that source's rows, so a contest that started, moved, or was
-- cancelled simply stops being listed, and one judge failing never blanks the
-- others. Kattis has no contest feed (no API), the same reason its solves
-- can't be mirrored.
--
-- Readers additionally filter `starts_at > now()`: the table is only as fresh
-- as the last refresh, and a stale mirror must never show a contest as
-- "upcoming" after it has begun.

create table if not exists upcoming_contests (
  id          bigserial primary key,
  source      text not null default 'cf', -- which fetcher owns the row
  external_id text not null,              -- the judge's own contest id/code
  name        text not null,
  url         text not null,
  starts_at   timestamptz not null,
  duration_s  int not null,
  platform    text not null,              -- display name: Codeforces, AtCoder, LeetCode…
  fetched_at  timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists upcoming_contests_starts on upcoming_contests (starts_at);
