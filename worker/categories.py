"""Canonical top-level categories — the major ICPC topic areas.

The usaco.guide module tree is great for curriculum ordering but too granular
for a mastery overview (100+ modules). Every module maps into exactly one of
these 8 categories; the module's usaco.guide division doubles as its tier
inside the category (Bronze=Basics ... Advanced=Expert; e.g. Suffix Array is
an Expert-tier Strings module). Category mastery is computed over the union
of member modules' problems, so each category gets ONE comprehensive score.

Stored as: topics rows with slug 'cat-<slug>' / division 'Category', and
topics.category_slug on each module pointing at its category. Colors/tier
labels live in the frontend (src/lib/taxonomy.ts).

Re-runnable via seed_usaco or `uv run python categories.py`.
"""

import logging

import psycopg

log = logging.getLogger("categories")

CATEGORIES = [
    ("fundamentals", "Fundamentals"),        # search, sorting, greedy, ad hoc
    ("data-structures", "Data Structures"),
    ("graphs", "Graphs"),
    ("dp", "Dynamic Programming"),
    ("math", "Math"),
    ("strings", "Strings"),
    ("geometry", "Geometry"),
    ("flow", "Flows & Matchings"),
]

MODULE_CATEGORY: dict[str, str] = {
    # --- fundamentals: complete search, sorting, binary search, greedy, ad hoc
    "time-comp": "fundamentals",
    "simulation": "fundamentals",
    "intro-complete": "fundamentals",
    "complete-rec": "fundamentals",
    "intro-sorting": "fundamentals",
    "casework": "fundamentals",
    "intro-greedy": "fundamentals",
    "ad-hoc": "fundamentals",
    "prefix-sums": "fundamentals",
    "more-prefix-sums": "fundamentals",
    "two-pointers": "fundamentals",
    "binary-search-sorted-array": "fundamentals",
    "binary-search": "fundamentals",
    "sorting-custom": "fundamentals",
    "greedy-sorting": "fundamentals",
    "intro-bitwise": "fundamentals",
    "meet-in-the-middle": "fundamentals",
    "ternary-search": "fundamentals",
    "fracturing-search": "fundamentals",
    "random": "fundamentals",
    "interactive": "fundamentals",
    "vectorization": "fundamentals",
    "bronze-conclusion": "fundamentals",
    "silver-conclusion": "fundamentals",
    "gold-conclusion": "fundamentals",
    "plat-conclusion": "fundamentals",
    # --- data structures
    "intro-ds": "data-structures",
    "intro-sets": "data-structures",
    "priority-queues": "data-structures",
    "intro-sorted-sets": "data-structures",
    "custom-cpp-stl": "data-structures",
    "stacks": "data-structures",
    "sliding-window": "data-structures",
    "PURS": "data-structures",
    "hashmaps": "data-structures",
    "segtree-ext": "data-structures",
    "range-sweep": "data-structures",
    "RURQ": "data-structures",
    "sparse-segtree": "data-structures",
    "2DRQ": "data-structures",
    "DC-SRQ": "data-structures",
    "sqrt": "data-structures",
    "bitsets": "data-structures",
    "offline-del": "data-structures",
    "springboards": "data-structures",
    "wavelet": "data-structures",
    "count-min": "data-structures",
    "segtree-beats": "data-structures",
    "persistent": "data-structures",
    "treaps": "data-structures",
    # --- graphs (incl. trees)
    "intro-graphs": "graphs",
    "graph-traversal": "graphs",
    "flood-fill": "graphs",
    "intro-tree": "graphs",
    "func-graphs": "graphs",
    "unweighted-shortest-paths": "graphs",
    "dsu": "graphs",
    "toposort": "graphs",
    "shortest-paths": "graphs",
    "mst": "graphs",
    "tree-euler": "graphs",
    "binary-jump": "graphs",
    "merging": "graphs",
    "hld": "graphs",
    "centroid": "graphs",
    "VT": "graphs",
    "kruskal-tree": "graphs",
    "sp-neg": "graphs",
    "eulerian-tours": "graphs",
    "BCC-2CC": "graphs",
    "SCC": "graphs",
    "eulers-formula": "graphs",
    "critical": "graphs",
    "link-cut-tree": "graphs",
    # --- dynamic programming (incl. tree DP and DP optimizations)
    "intro-dp": "dp",
    "knapsack": "dp",
    "paths-grids": "dp",
    "lis": "dp",
    "dp-bitmasks": "dp",
    "dp-ranges": "dp",
    "digit-dp": "dp",
    "dp-trees": "dp",
    "all-roots": "dp",
    "comb-sub": "dp",
    "dp-broken-profile": "dp",
    "dp-more": "dp",
    "dp-sos": "dp",
    "DC-DP": "dp",
    "convex-hull-trick": "dp",
    "line-container": "dp",
    "slope-trick": "dp",
    "lagrange": "dp",
    # --- math (number theory, combinatorics, polynomials, game theory)
    "divisibility": "math",
    "modular": "math",
    "combo": "math",
    "PIE": "math",
    "matrix-expo": "math",
    "extend-euclid": "math",
    "catalan": "math",
    "xor-basis": "math",
    "prefix-sums-nt-1": "math",
    "prefix-sums-nt-2": "math",
    "fft": "math",
    "fft-ext": "math",
    "game-theory": "math",
    # --- strings
    "hashing": "strings",
    "string-search": "strings",
    "suffix-array": "strings",
    "string-suffix": "strings",
    # --- geometry
    "rect-geo": "geometry",
    "geo-pri": "geometry",
    "sweep-line": "geometry",
    "convex-hull": "geometry",
    # --- flows & matchings
    "max-flow": "flow",
    "min-cut": "flow",
    "flow-lb": "flow",
    "min-cost-flow": "flow",
    "matroid-isect": "flow",
}


def apply(conn: psycopg.Connection) -> None:
    """Create/refresh category topic rows and stamp modules. Idempotent."""
    with conn.cursor() as cur:
        cur.execute("alter table topics add column if not exists category_slug text")
        for i, (slug, name) in enumerate(CATEGORIES):
            cur.execute(
                """
                insert into topics (slug, name, parent_id, division, ordering)
                values (%s, %s, null, 'Category', %s)
                on conflict (slug) do update set name = excluded.name,
                  division = 'Category', ordering = excluded.ordering
                """,
                (f"cat-{slug}", name, i),
            )
        for module, cat in MODULE_CATEGORY.items():
            cur.execute(
                "update topics set category_slug = %s where slug = %s",
                (f"cat-{cat}", module),
            )
        # Surface modules the mapping missed (new usaco.guide content).
        cur.execute(
            """select slug from topics where parent_id is not null
               and division <> 'General' and category_slug is null"""
        )
        for r in cur.fetchall():
            log.warning("module %r has no category — add it to MODULE_CATEGORY", r["slug"])
    conn.commit()


if __name__ == "__main__":
    import db

    logging.basicConfig(level=logging.INFO)
    with db.connect() as conn:
        apply(conn)
    print("categories applied")
