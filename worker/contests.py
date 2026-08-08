"""Upcoming-contest mirror: one fetcher per judge -> upcoming_contests.

Each source replaces ONLY its own rows on refresh: upsert everything the judge
lists, then delete what it no longer lists. That is what makes a rescheduled
contest move and a cancelled one disappear without modelling those states —
and a fetcher that fails leaves its last good rows standing rather than
blanking a judge because one endpoint hiccuped.

Sources, chosen by the same rule that keeps this app from scraping Kattis —
use what each site permits:

  cf        the official Codeforces API, through the shared rate-limited queue
  atcoder   AtCoder has no contests API; its robots.txt allows /contests/, so
            the schedule table is parsed from the page itself (regex, the same
            way seed_icpc.py reads Kattis pages). The kenkoooo community
            dataset was tried first but lags — it had no entry for the next
            ABC the week this was built.
  codechef  the JSON endpoint CodeChef's own frontend uses; /api is not
            disallowed by their robots.txt
  clist     opt-in umbrella (CLIST_USERNAME + CLIST_API_KEY): clist.by's
            documented API covers the judges we cannot touch directly —
            LeetCode's robots.txt forbids /graphql, so LeetCode arrives only
            this way. Filtered to CLIST_RESOURCES and to hosts not already
            fetched natively, so nothing shows up twice.

Notification timing lives in the browser (the stored start time is exact), so
this does not need to run often — the calendar exists so the *list* is fresh,
not so the countdown is.
"""

import html
import logging
import os
import re
import time
from datetime import datetime, timezone

import httpx
import psycopg

import cf_api

log = logging.getLogger("contests")

# external_id, name, url, start_epoch_s, duration_s, platform
Row = tuple[str, str, str, int, int, str]

# One polite identified request per source per refresh.
HEADERS = {"User-Agent": "cp-trainer contest calendar (github.com/Akiko0210/cp-trainer)"}

# Hosts the native fetchers own; clist rows on these are dropped to avoid dupes.
NATIVE_HOSTS = {"codeforces.com", "atcoder.jp", "codechef.com"}

CLIST_PLATFORMS = {
    "leetcode.com": "LeetCode",
    "usaco.org": "USACO",
    "topcoder.com": "Topcoder",
    "hackerrank.com": "HackerRank",
    "yukicoder.me": "yukicoder",
}


async def _get_json(url: str, **params) -> dict | list:
    async with httpx.AsyncClient(timeout=30, headers=HEADERS) as client:
        resp = await client.get(url, params=params or None)
        resp.raise_for_status()
        return resp.json()


async def fetch_cf() -> list[Row]:
    contests = await cf_api.call("contest.list", gym="false")
    return [
        (
            str(c["id"]),
            c["name"],
            f"https://codeforces.com/contests/{c['id']}",
            c["startTimeSeconds"],
            c["durationSeconds"],
            "Codeforces",
        )
        for c in contests
        # A handful of announced-but-unscheduled contests carry no
        # startTimeSeconds; nothing can count down to them.
        if c.get("phase") == "BEFORE" and "startTimeSeconds" in c
    ]


# One schedule row on atcoder.jp/contests/: a JST <time>, the contest link,
# and an HH:MM duration cell. The page also lists active and recent contests
# in the same shape; the start-in-the-future filter is what selects upcoming.
ATCODER_TIME = re.compile(r"<time class='fixtime fixtime-full'>([^<]+)</time>")
ATCODER_LINK = re.compile(r'<a href="/contests/([^"?]+)">([^<]+)</a>')
ATCODER_DURATION = re.compile(r'<td class="text-center">(\d+):(\d{2})</td>')


async def fetch_atcoder() -> list[Row]:
    async with httpx.AsyncClient(timeout=30, headers=HEADERS) as client:
        resp = await client.get("https://atcoder.jp/contests/", params={"lang": "en"})
        resp.raise_for_status()
        page = resp.text

    now = time.time()
    rows: list[Row] = []
    for tr in page.split("<tr>"):
        started = ATCODER_TIME.search(tr)
        link = ATCODER_LINK.search(tr)
        duration = ATCODER_DURATION.search(tr)
        # Rows missing any piece are headers, permanent contests ("∞"), or
        # not schedule rows at all.
        if not (started and link and duration):
            continue
        starts = datetime.strptime(started.group(1), "%Y-%m-%d %H:%M:%S%z").timestamp()
        if starts <= now:
            continue
        slug = link.group(1)
        rows.append(
            (
                slug,
                html.unescape(link.group(2)).strip(),
                f"https://atcoder.jp/contests/{slug}",
                int(starts),
                int(duration.group(1)) * 3600 + int(duration.group(2)) * 60,
                "AtCoder",
            )
        )
    return rows


async def fetch_codechef() -> list[Row]:
    data = await _get_json("https://www.codechef.com/api/list/contests/all")
    rows: list[Row] = []
    for c in data.get("future_contests", []):
        # ISO with the +05:30 offset; duration is minutes, as a string.
        starts = int(datetime.fromisoformat(c["contest_start_date_iso"]).timestamp())
        rows.append(
            (
                c["contest_code"],
                c["contest_name"].strip(),
                f"https://www.codechef.com/{c['contest_code']}",
                starts,
                int(c["contest_duration"]) * 60,
                "CodeChef",
            )
        )
    return rows


def _clist_host(resource) -> str:
    """v4 documents resource as the host string; be lenient if it nests."""
    if isinstance(resource, dict):
        return str(resource.get("host") or resource.get("name") or "")
    return str(resource or "")


async def fetch_clist() -> list[Row]:
    username = os.environ.get("CLIST_USERNAME", "").strip()
    api_key = os.environ.get("CLIST_API_KEY", "").strip()
    if not username or not api_key:
        # Unconfigured is a normal state, not an error — but say so once per
        # refresh at INFO. "Why is there no LeetCode?" is otherwise invisible:
        # the calendar just quietly lacks a judge, with nothing in the log to
        # explain which one or why.
        log.info(
            "clist not configured (CLIST_USERNAME/CLIST_API_KEY unset) — "
            "LeetCode and other umbrella-only judges will not appear"
        )
        return []
    wanted = {
        h.strip().lower()
        for h in os.environ.get("CLIST_RESOURCES", "leetcode.com,usaco.org").split(",")
        if h.strip()
    }
    async with httpx.AsyncClient(
        timeout=30,
        headers={**HEADERS, "Authorization": f"ApiKey {username}:{api_key}"},
    ) as client:
        resp = await client.get(
            "https://clist.by/api/v4/contest/",
            params={
                "upcoming": "true",
                "format": "json",
                "order_by": "start",
                "limit": "200",
                # Server-side narrowing; the client-side filter below is the
                # one that's load-bearing, in case a deployment's param set
                # drifts from the docs.
                "resource__in": ",".join(sorted(wanted)),
            },
        )
        resp.raise_for_status()
        objects = resp.json().get("objects", [])

    rows: list[Row] = []
    for c in objects:
        host = _clist_host(c.get("resource")).lower()
        if host not in wanted or host in NATIVE_HOSTS:
            continue
        start = datetime.fromisoformat(c["start"])
        if start.tzinfo is None:  # clist times are UTC, sometimes naive
            start = start.replace(tzinfo=timezone.utc)
        rows.append(
            (
                str(c["id"]),
                str(c["event"]).strip(),
                str(c["href"]),
                int(start.timestamp()),
                int(c["duration"]),
                CLIST_PLATFORMS.get(host, host),
            )
        )
    return rows


FETCHERS = {
    "cf": fetch_cf,
    "atcoder": fetch_atcoder,
    "codechef": fetch_codechef,
    "clist": fetch_clist,
}


def _replace_source(cur, source: str, rows: list[Row]) -> None:
    if rows:
        # A judge's whole upcoming set is at most a few hundred rows — one
        # statement, well under the bind-parameter limit.
        values = ",".join(["(%s,%s,%s,%s,to_timestamp(%s),%s,%s)"] * len(rows))
        cur.execute(
            f"""
            insert into upcoming_contests
              (source, external_id, name, url, starts_at, duration_s, platform)
            values {values}
            on conflict (source, external_id) do update set
              name = excluded.name,
              url = excluded.url,
              starts_at = excluded.starts_at,
              duration_s = excluded.duration_s,
              platform = excluded.platform,
              fetched_at = now()
            """,
            [v for row in rows for v in (source, *row)],
        )
    cur.execute(
        """
        delete from upcoming_contests
        where source = %s and not (external_id = any(%s))
        """,
        (source, [r[0] for r in rows]),
    )


async def refresh(conn: psycopg.Connection) -> dict[str, int]:
    """Mirror every source. Returns {source: upcoming count} for the ones that
    succeeded; a failed source is logged, left as it was, and retried next
    interval."""
    counts: dict[str, int] = {}
    for source, fetch in FETCHERS.items():
        try:
            rows = await fetch()
            with conn.cursor() as cur:
                _replace_source(cur, source, rows)
            conn.commit()
        except Exception:
            # The write is inside the try, not just the fetch: a judge whose
            # rows fail to store must not take the other judges' calendars
            # down with it. The rollback is what makes that true — psycopg
            # leaves the transaction aborted after a failed statement, so
            # without it every later source in this pass fails too, on an
            # error that has nothing to do with them.
            conn.rollback()
            log.exception("contest refresh failed for %s", source)
            continue
        counts[source] = len(rows)
    return counts
