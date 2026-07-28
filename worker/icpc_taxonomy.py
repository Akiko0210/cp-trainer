"""Classify Kattis contest sets by where they sit on the real ICPC ladder.

THE LADDER (this is the actual competition structure, not a naming scheme)
--------------------------------------------------------------------------
A team advances upward; each rung is a materially harder field:

  qualifier     Online gate before regionals — North America Qualifier (NAQ),
                Singapore/Hong Kong preliminaries, national contests that feed
                a regional.
  regional      The regional contests themselves. In North America these are
                geographic divisions (Pacific Northwest, Mid-Central, East
                Central, …); in Europe NWERC/SWERC/CERC; in Asia the city
                regionals.
  championship  Above regionals: the North America Championship (NAC) — the
                nationals — plus the division championships that feed it.
  world-finals  The top of the ladder.

  practice      Dress rehearsals and practice sessions attached to the above.
                Kept, but never mixed in with the real thing.

`series` is the subgroup INSIDE a level — the thing that makes "Pacific
Northwest" and "Mid-Central" separately meaningful rather than one undifferentiated
pile of regionals. `region` is the continent, so the ladder can be shown
North-America-first for a North American competitor.

Everything here is a pure function of the source name, so re-classifying does
not require re-crawling Kattis. `uv run python icpc_taxonomy.py` reclassifies
every stored set and prints the result for eyeballing.
"""

import logging
import re

import psycopg

log = logging.getLogger("icpc_taxonomy")

# Ladder order, lowest rung first. The UI reverses this to lead with the top.
LEVELS = ["qualifier", "regional", "championship", "world-finals", "practice", "other"]
LEVEL_ORDER = {name: i for i, name in enumerate(LEVELS)}

REGIONS = ["North America", "Europe", "Asia", "Other"]

# Not ICPC at all — these surface from the broad discovery queries and would
# be actively misleading filed under an ICPC ladder.
NOT_ICPC = re.compile(
    # No trailing \b on codesprint: the real name is "CodeSprintLA".
    r"(google\s+code\s+jam|\bcode\s+jam\b|codesprint|\bcroatian\b"
    r"|nsa\s+challenge|icpc\)?\s+challenge)",
    re.I,
)

# --- North America regional divisions -------------------------------------
# Order matters: "North Central" must beat the looser "Central" patterns, and
# "East Central" must not be swallowed by "North Central".
NA_SERIES = [
    ("Pacific Northwest", r"pacific\s+north\s*west|\bpacnw\b"),
    ("East Central NA", r"east[-\s]?central"),
    ("North Central NA", r"north[-\s]?central|\bncna\b"),
    ("Mid-Central USA", r"mid[-\s]?central"),
    ("Mid-Atlantic", r"mid[-\s]?atlantic"),
    ("Southeast USA", r"south\s?east"),
    ("South Central USA", r"south[-\s]?central"),
    ("Rocky Mountain", r"rocky\s+mountain|\brmrc\b"),
    ("Greater New York", r"greater\s+new\s+york"),
    ("Northeast NA", r"north\s?east\s+north\s+america"),
    ("Southern California", r"southern\s+california"),
    # Since ~2024 ICPC North America renamed its regionals as geographic
    # Divisions. These are regional-level events despite the word "Division";
    # only "Division Championship" sits above a regional.
    ("Central Division", r"central\s+division"),
    ("East Division", r"east\s+division"),
    ("West Division", r"west\s+division"),
    ("South Division", r"south\s+division"),
]

# --- Europe / Asia series --------------------------------------------------
EU_SERIES = [
    ("NWERC · Northwestern Europe", r"\bnwerc\b|north\s?western\s+europe"),
    ("SWERC · Southwestern Europe", r"\bswerc\b|south\s?western\s+europe"),
    ("CERC · Central Europe", r"\bcerc\b|central\s+europe"),
    ("EWPC · Women's", r"\bewpc\b|women"),
    ("Nordic", r"\bnordic\b|swedish|norwegian|danish|finnish"),
]

ASIA_SERIES = [
    ("Singapore", r"singapore|\bsg\b"),
    ("Hong Kong", r"hong\s+kong"),
    ("Vietnam", r"vietnam|danang|nha\s+trang|hanoi|ho\s+chi\s+minh"),
    ("Jakarta", r"jakarta|indonesia"),
    ("India", r"amritapuri|india|kanpur|kharagpur"),
]


def _match(name: str, table) -> str | None:
    for label, pattern in table:
        if re.search(pattern, name, re.I):
            return label
    return None


def _all_matches(name: str, table) -> list[str]:
    return [label for label, pattern in table if re.search(pattern, name, re.I)]


def classify(name: str) -> dict | None:
    """-> {level, region, series, year} or None if it isn't an ICPC contest."""
    if NOT_ICPC.search(name):
        return None

    year_m = re.search(r"\b(19|20)\d{2}\b", name)
    year = int(year_m.group(0)) if year_m else None

    is_practice = bool(
        re.search(r"\bpractice\b|dress\s+rehearsal|warm[-\s]?up", name, re.I)
    )

    # --- level ---
    if re.search(r"world\s+finals?", name, re.I):
        level = "world-finals"
        region = "Global"
        series = "World Finals"
    elif re.search(r"division\s+championship", name, re.I):
        # Feeds the NAC — above a regional, below the championship itself.
        level = "championship"
        region = "North America"
        series = "Division Championships"
    elif re.search(r"championship|\bnac\b", name, re.I):
        level = "championship"
        region = "North America"
        series = "NAC · North America Championship"
    elif re.search(r"qualifier|preliminar|national\s+programming|provincial", name, re.I):
        level = "qualifier"
        region, series = _region_and_series(name)
        if region == "North America":
            series = "NAQ · North America Qualifier"
    else:
        level = "regional"
        region, series = _region_and_series(name)

    # Practice sessions ride alongside their parent but must not be mistaken
    # for the contest itself.
    if is_practice:
        level = "practice"
        if series == "Other":
            series = "Dress rehearsal"

    return {"level": level, "region": region, "series": series, "year": year}


def _region_and_series(name: str) -> tuple[str, str]:
    """Continent + subgroup for the non-championship, non-WF levels."""
    eu = _match(name, EU_SERIES)
    if eu:
        return "Europe", eu
    asia = _match(name, ASIA_SERIES)
    if asia:
        return "Asia", asia

    hits = _all_matches(name, NA_SERIES)
    if len(hits) > 1:
        # e.g. "South Central, South East and Mid Atlantic Regional" — a single
        # combined event; filing it under one division would be wrong.
        return "North America", "Combined divisions"
    if hits:
        return "North America", hits[0]
    if re.search(r"north\s+america", name, re.I):
        # Generic multi-region NA event with no division named.
        return "North America", "North America (all divisions)"
    return "Other", "Other"


def reclassify_all(conn: psycopg.Connection) -> dict:
    """Re-derive level/region/series for every stored set. No crawling."""
    with conn.cursor() as cur:
        cur.execute("select id, name from contest_sets")
        rows = cur.fetchall()
        updated = dropped = 0
        for r in rows:
            info = classify(r["name"])
            if info is None:
                cur.execute("delete from contest_sets where id = %s", (r["id"],))
                dropped += 1
                continue
            cur.execute(
                """update contest_sets
                   set level = %s, region = %s, series = %s, year = coalesce(%s, year)
                   where id = %s""",
                (info["level"], info["region"], info["series"], info["year"], r["id"]),
            )
            updated += 1
    conn.commit()
    return {"updated": updated, "dropped_non_icpc": dropped}


if __name__ == "__main__":
    import db

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    with db.connect() as conn:
        print(reclassify_all(conn))
        with conn.cursor() as cur:
            cur.execute(
                """select level, region, series, count(*) n,
                          min(year) y0, max(year) y1
                   from contest_sets group by level, region, series
                   order by level, region, series"""
            )
            for r in cur.fetchall():
                print(
                    f"  {r['level']:<14} {r['region']:<14} {r['series']:<34} "
                    f"{r['n']:>3}  {r['y0']}-{r['y1']}"
                )
