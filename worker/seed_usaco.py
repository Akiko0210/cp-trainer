"""Seed topics + curated problem catalog from usaco.guide (handoff §4.2).

Re-runnable. Pipeline:
  1. Shallow sparse-clone (or reuse) the cpinitiative/usaco-guide repo — only
     the content/ tree, no history.
  2. Parse content/ordering.ts (division -> chapter -> module ids) via a tiny
     Node helper, since it's TypeScript.
  3. Read each module's .mdx frontmatter (id, title) and .problems.json
     (curated problems with difficulty labels + judge URLs).
  4. Insert topics: chapters as parents, modules as children (division +
     ordering preserved — these are the structural truth the UI leans on).
  5. Insert problems: CF-linked ones active; CSES/AtCoder/Kattis/USACO rows
     stored but inactive until those integrations ship. Topic links carry
     origin 'usaco_guide' (the trusted signal, vs the 'cf_tag' supplement).
"""

import json
import logging
import re
import subprocess
from pathlib import Path

import psycopg

import db

log = logging.getLogger("seed_usaco")

REPO_URL = "https://github.com/cpinitiative/usaco-guide.git"
REPO_DIR = Path(__file__).parent / "data" / "usaco-guide"

DIVISIONS = {  # section id -> display name
    "general": "General",
    "bronze": "Bronze",
    "silver": "Silver",
    "gold": "Gold",
    "plat": "Platinum",
    "adv": "Advanced",
}

CF_URL = re.compile(
    r"codeforces\.com/(?:(?:contest|gym)/(\d+)/problem/(\w+)"
    r"|problemset/problem/(\d+)/(\w+))"
)

SOURCE_MAP = {"cses": "cses", "kattis": "kattis", "ac": "atcoder"}


def ensure_repo() -> None:
    if REPO_DIR.exists():
        subprocess.run(["git", "-C", str(REPO_DIR), "pull", "--depth=1", "--rebase"],
                       check=False, capture_output=True)
        return
    REPO_DIR.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "clone", "--depth=1", "--filter=blob:none", "--sparse",
         REPO_URL, str(REPO_DIR)],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(REPO_DIR), "sparse-checkout", "set", "content"],
        check=True,
    )


def load_ordering() -> dict:
    out = subprocess.run(
        ["node", str(Path(__file__).parent / "parse_ordering.mjs"),
         str(REPO_DIR / "content" / "ordering.ts")],
        check=True, capture_output=True, text=True,
    )
    return json.loads(out.stdout)


def scan_content() -> tuple[dict[str, str], dict[str, list]]:
    """Walk content/ for module titles (.mdx frontmatter) and problem lists."""
    titles: dict[str, str] = {}
    problems: dict[str, list] = {}
    content = REPO_DIR / "content"
    for mdx in content.rglob("*.mdx"):
        head = mdx.read_text(errors="ignore")[:2000]
        mid = re.search(r"^id:\s*['\"]?([\w-]+)['\"]?", head, re.M)
        title = re.search(r"^title:\s*['\"]?(.+?)['\"]?\s*$", head, re.M)
        if mid and title:
            titles[mid.group(1)] = title.group(1)
    for pj in content.rglob("*.problems.json"):
        try:
            data = json.loads(pj.read_text())
        except json.JSONDecodeError:
            log.warning("bad json: %s", pj)
            continue
        module_id = data.pop("MODULE_ID", None)
        if not module_id:
            continue
        plist = []
        for table in data.values():
            if isinstance(table, list):
                plist.extend(table)
        problems[module_id] = plist
    return titles, problems


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def parse_problem(p: dict) -> dict | None:
    """Normalize a usaco.guide problem entry to a catalog row."""
    url = p.get("url", "")
    uid = p.get("uniqueId", "")
    m = CF_URL.search(url)
    if m:
        contest = m.group(1) or m.group(3)
        index = (m.group(2) or m.group(4)).upper()
        return {
            "source": "cf",
            "external_id": f"{contest}{index}",
            "title": p.get("name", uid),
            "url": f"https://codeforces.com/contest/{contest}/problem/{index}",
            "difficulty_label": p.get("difficulty"),
            "active": True,
        }
    if not uid or not url:
        return None
    src = SOURCE_MAP.get(uid.split("-")[0].lower(), "other")
    if "kattis" in url:
        src = "kattis"
    return {
        "source": src,
        "external_id": uid,
        "title": p.get("name", uid),
        "url": url,
        "difficulty_label": p.get("difficulty"),
        "active": False,  # non-CF judges are stored but inactive in v1
    }


def seed(conn: psycopg.Connection) -> None:
    ensure_repo()
    ordering = load_ordering()
    titles, module_problems = scan_content()

    with conn.cursor() as cur:
        chapter_ord = 0
        n_topics = n_probs = n_links = 0
        for section, chapters in ordering.items():
            division = DIVISIONS.get(section, section)
            for chapter in chapters:
                chapter_ord += 1
                # 'ch-' prefix keeps chapter slugs from colliding with module
                # ids (e.g. module 'bronze-conclusion' vs chapter 'Conclusion').
                ch_slug = f"ch-{section}-{slugify(chapter['name'])}"
                cur.execute(
                    """
                    insert into topics (slug, name, parent_id, division, ordering)
                    values (%s, %s, null, %s, %s)
                    on conflict (slug) do update set
                      name = excluded.name, division = excluded.division,
                      ordering = excluded.ordering
                    returning id
                    """,
                    (ch_slug, chapter["name"], division, chapter_ord),
                )
                ch_id = cur.fetchone()["id"]
                n_topics += 1
                for mod_ord, module_id in enumerate(chapter.get("items", [])):
                    name = titles.get(module_id, module_id)
                    cur.execute(
                        """
                        insert into topics (slug, name, parent_id, division, ordering)
                        values (%s, %s, %s, %s, %s)
                        on conflict (slug) do update set
                          name = excluded.name, parent_id = excluded.parent_id,
                          division = excluded.division, ordering = excluded.ordering
                        returning id
                        """,
                        (module_id, name, ch_id, division, mod_ord),
                    )
                    topic_id = cur.fetchone()["id"]
                    n_topics += 1

                    for p in module_problems.get(module_id, []):
                        row = parse_problem(p)
                        if row is None:
                            continue
                        cur.execute(
                            """
                            insert into problem_catalog
                              (source, external_id, title, url, rating, tags,
                               difficulty_label, active)
                            values (%(source)s, %(external_id)s, %(title)s, %(url)s,
                                    null, '{}', %(difficulty_label)s, %(active)s)
                            on conflict (source, external_id) do update set
                              difficulty_label = coalesce(excluded.difficulty_label,
                                                          problem_catalog.difficulty_label)
                            returning id
                            """,
                            row,
                        )
                        pid = cur.fetchone()["id"]
                        n_probs += 1
                        cur.execute(
                            """
                            insert into problem_topics (problem_id, topic_id, origin)
                            values (%s, %s, 'usaco_guide') on conflict do nothing
                            """,
                            (pid, topic_id),
                        )
                        n_links += 1
    conn.commit()
    log.info("seeded topics=%s problems=%s links=%s", n_topics, n_probs, n_links)

    # Canonical ICPC category layer (category rows + module stamps).
    import categories

    categories.apply(conn)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    with db.connect() as conn:
        seed(conn)
