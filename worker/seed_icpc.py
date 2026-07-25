"""Seed ICPC practice sets from open.kattis.com.

WHAT IS AND ISN'T POSSIBLE HERE (checked, not assumed)
------------------------------------------------------
Kattis has no public API. Its robots.txt allows `/` and `/problem-sources/*`
but explicitly disallows `/users` and `/submissions`, so there is no legitimate
way to mirror the user's Kattis solve state the way we mirror Codeforces. That
is a hard constraint, not a gap to be filled later: solve state for these sets
comes from the app's own timer, or from an explicit "mark solved" tap.

What we CAN read is the archival content, which is all we need: each
`/problem-sources/<name>` page lists a contest's problems with their slug,
title and Kattis difficulty (1.0-9.9). That content changes about once a year
(a new regional season), so this is a re-runnable batch job, not a monitor.

Politeness: a browser UA and >= REQUEST_GAP_S between requests, in one
sequential pass — same discipline as the Codeforces queue in cf_api.py.

Run: uv run python seed_icpc.py       (or POST /seed-icpc on the worker)
"""

import logging
import re
import time
import urllib.parse
import urllib.request

import psycopg

import db

log = logging.getLogger("seed_icpc")

BASE = "https://open.kattis.com"
SEARCH = BASE + "/search?q={q}"

# Kattis search caps at 100 sources per query and ignores &page, so coverage
# comes from unioning several queries rather than paginating one.
QUERIES = (
    "icpc",
    "regional",
    "world finals",
    "qualifier",
    "acm",
    "nwerc",
    "cerc",
    "neerc",
    "swerc",
)

# Many genuine ICPC regionals never say "ICPC" on Kattis (CERC, NWERC,
# Greater New York, Hong Kong Regional, Southeast USA Regionals), so matching
# on the acronym alone silently loses about half the archive.
INCLUDE_RE = re.compile(
    r"\b(icpc|acm|world\s+finals?|regionals?|qualifier|preliminary|preliminaries"
    r"|nwerc|swerc|neerc|cerc|seerc|apac|gnyr)\b",
    re.I,
)
# National olympiads also match "regional"; they are not ICPC-style team sets.
EXCLUDE_RE = re.compile(r"\b(olympiad|in\s+informatics|high\s+school)\b", re.I)
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
REQUEST_GAP_S = 2.0

# A source page row: <a href="/problems/<slug>">Title</a> ... difficulty 4.2
SOURCE_HREF = re.compile(r'href="/problem-sources/([^"]+)"')
PROBLEM_ROW = re.compile(
    r'href="/problems/([a-z0-9_.-]+)"[^>]*>(?:\s*<[^>]*>)*\s*([^<]{1,200}?)\s*<',
    re.I,
)
DIFFICULTY = re.compile(r'difficulty_number[^>]*>\s*([0-9.]+)')

_last_request = 0.0


def _get(url: str) -> str:
    global _last_request
    gap = REQUEST_GAP_S - (time.monotonic() - _last_request)
    if gap > 0:
        time.sleep(gap)
    _last_request = time.monotonic()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", errors="replace")


def discover_sources() -> list[str]:
    """Union of ICPC-style contest sources across all discovery queries."""
    found: list[str] = []
    seen: set[str] = set()
    for query in QUERIES:
        html = _get(SEARCH.format(q=urllib.parse.quote(query)))
        names = {urllib.parse.unquote(m) for m in SOURCE_HREF.findall(html)}
        added = 0
        for name in sorted(names):
            if name in seen:
                continue
            seen.add(name)
            if INCLUDE_RE.search(name) and not EXCLUDE_RE.search(name):
                found.append(name)
                added += 1
        log.info("query %-14r %3s sources, %3s new ICPC-style (%s total)",
                 query, len(names), added, len(found))
    return sorted(found)


def classify(name: str) -> tuple[str, int | None, str | None]:
    """Derive (kind, year, region) from a source name.

    Names look like "2015 ACM ICPC Singapore Regional" or
    "2013 ACM-ICPC North American Qualifier".
    """
    year_m = re.search(r"\b(19|20)\d{2}\b", name)
    year = int(year_m.group(0)) if year_m else None

    lower = name.lower()
    if "world finals" in lower:
        kind = "world-finals"
    elif "practice" in lower or "warm" in lower:
        kind = "practice"
    elif "qualif" in lower:
        kind = "qualifier"
    elif "regional" in lower or "region" in lower:
        kind = "regional"
    else:
        kind = "other"

    # Region = what's left after stripping the year and the boilerplate.
    region = re.sub(r"\b(19|20)\d{2}\b", "", name)
    region = re.sub(
        r"\b(acm[- ]?icpc|acm|icpc|regionals?|contests?|qualifier|world finals?"
        r"|practice session|practice|programming|division)\b",
        "",
        region,
        flags=re.I,
    )
    region = re.sub(r"\s{2,}", " ", region).strip(" -–—")
    return kind, year, (region or None)


def parse_source_page(html: str) -> list[tuple[str, str, float | None]]:
    """-> [(slug, title, kattis_difficulty)] in listed order."""
    rows = PROBLEM_ROW.findall(html)
    difficulties = DIFFICULTY.findall(html)
    out: list[tuple[str, str, float | None]] = []
    seen: set[str] = set()
    for i, (slug, title) in enumerate(rows):
        if slug in seen:
            continue
        seen.add(slug)
        diff = None
        if i < len(difficulties):
            try:
                diff = float(difficulties[i])
            except ValueError:
                diff = None
        out.append((slug, title.strip(), diff))
    return out


def upsert_set(conn: psycopg.Connection, name: str, problems: list) -> int:
    """Insert/refresh one contest set and its members. Returns problems linked."""
    kind, year, region = classify(name)
    url = f"{BASE}/problem-sources/{urllib.parse.quote(name)}"
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into contest_sets (source, slug, name, kind, region, year, url)
            values ('kattis', %s, %s, %s, %s, %s, %s)
            on conflict (source, slug) do update set
              name = excluded.name, kind = excluded.kind,
              region = excluded.region, year = excluded.year, url = excluded.url
            returning id
            """,
            (name, name, kind, region, year, url),
        )
        set_id = cur.fetchone()["id"]

        n = 0
        for ordering, (slug, title, difficulty) in enumerate(problems):
            cur.execute(
                """
                insert into problem_catalog
                  (source, external_id, title, url, kattis_difficulty, active)
                values ('kattis', %s, %s, %s, %s, false)
                on conflict (source, external_id) do update set
                  title = excluded.title,
                  kattis_difficulty = coalesce(excluded.kattis_difficulty,
                                               problem_catalog.kattis_difficulty)
                returning id
                """,
                (slug, title, f"{BASE}/problems/{slug}", difficulty),
            )
            pid = cur.fetchone()["id"]
            cur.execute(
                """
                insert into contest_set_problems (set_id, problem_id, ordering)
                values (%s, %s, %s)
                on conflict (set_id, problem_id) do update set
                  ordering = excluded.ordering
                """,
                (set_id, pid, ordering),
            )
            n += 1
    conn.commit()
    return n


def seed(conn: psycopg.Connection, limit: int | None = None) -> dict:
    names = discover_sources()
    if limit:
        names = names[:limit]
    log.info("ingesting %s ICPC sources", len(names))
    sets = problems = 0
    for i, name in enumerate(names, 1):
        try:
            html = _get(f"{BASE}/problem-sources/{urllib.parse.quote(name)}")
            parsed = parse_source_page(html)
            if not parsed:
                log.warning("no problems parsed from %r", name)
                continue
            problems += upsert_set(conn, name, parsed)
            sets += 1
            log.info("[%s/%s] %s -> %s problems", i, len(names), name, len(parsed))
        except Exception:
            log.exception("failed on source %r", name)
    return {"sets": sets, "problems": problems}


if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    cap = int(sys.argv[1]) if len(sys.argv) > 1 else None
    with db.connect() as conn:
        print(seed(conn, limit=cap))
