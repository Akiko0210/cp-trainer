"""CF problemset ingest + the CF-tag -> topic supplement mapping (handoff §4.2).

usaco.guide's curated lists are the trusted topic signal (origin 'usaco_guide').
CF tags are noisier, so they're only a volume supplement (origin 'cf_tag'):
they let solves outside the curated lists still count toward mastery, and give
the recommender a deeper pool. The mapping below sends each useful CF tag to
one representative usaco.guide module; chapter rollups spread it upward.
Slugs are validated against the topics table at run time — a mapping entry
whose module wasn't seeded is skipped with a warning.
"""

import asyncio
import logging

import psycopg

import cf_api
import db

log = logging.getLogger("seed_cf")

# CF tag -> usaco.guide module slug (validated at runtime).
CF_TAG_TO_MODULE = {
    "dp": "intro-dp",
    "graphs": "graph-traversal",
    "dfs and similar": "graph-traversal",
    "trees": "intro-tree",
    "binary search": "binary-search",
    "ternary search": "binary-search",
    "two pointers": "two-pointers",
    "sortings": "intro-sorting",
    "greedy": "intro-greedy",
    "math": "divisibility",
    "number theory": "divisibility",
    "combinatorics": "combo",
    "data structures": "intro-ds",
    "dsu": "dsu",
    "shortest paths": "shortest-paths",
    "strings": "string-search",
    "string suffix structures": "string-suffix",
    "hashing": "hashing",
    "bitmasks": "intro-bitwise",
    "geometry": "geo-pri",
    "matrices": "matrix-expo",
    "games": "game-theory",
    "divide and conquer": "DC-SRQ",
    "meet-in-the-middle": "meet-in-the-middle",
    "brute force": "intro-complete",
    "constructive algorithms": "ad-hoc",
    "implementation": "simulation",
    "flows": "max-flow",
    "graph matchings": "max-flow",
    "fft": "fft",
}

_cache: dict[str, int] | None = None


def tag_topic_ids(conn: psycopg.Connection) -> dict[str, int]:
    """Resolve the tag mapping to topic ids; cached per worker process."""
    global _cache
    if _cache is not None:
        return _cache
    with conn.cursor() as cur:
        cur.execute(
            "select slug, id from topics where slug = any(%s)",
            (list(set(CF_TAG_TO_MODULE.values())),),
        )
        by_slug = {r["slug"]: r["id"] for r in cur.fetchall()}
    resolved = {}
    for tag, slug in CF_TAG_TO_MODULE.items():
        if slug in by_slug:
            resolved[tag] = by_slug[slug]
        else:
            log.warning("tag %r maps to unknown module slug %r — skipped", tag, slug)
    _cache = resolved
    return resolved


async def seed_problemset(conn: psycopg.Connection) -> int:
    """Ingest the full CF problemset into problem_catalog (+ cf_tag links)."""
    from sync import link_cf_tags, upsert_problem  # avoid import cycle

    result = await cf_api.call("problemset.problems")
    problems = result["problems"]
    topic_ids = tag_topic_ids(conn)
    n = 0
    with conn.cursor() as cur:
        for prob in problems:
            pid = upsert_problem(cur, prob)
            if pid is not None:
                link_cf_tags(cur, pid, prob.get("tags", []), topic_ids)
                n += 1
    conn.commit()
    log.info("problemset ingest: %s problems", n)
    return n


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    with db.connect() as conn:
        asyncio.run(seed_problemset(conn))
