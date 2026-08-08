"""Checks for the upcoming-contest mirror (contests.py).

No pytest — the worker has no test dependency and this is a script like the
rest of them. Point it at a scratch database and run it:

    DATABASE_URL='postgresql://…/scratch' uv run python test_contests.py

It stubs the fetcher registry so nothing touches any judge, and only ever
writes and deletes rows under its own two fake source names — never the real
`cf`/`atcoder`/`codechef` rows. That restriction is not politeness: an earlier
version opened with a table-wide `delete` and silently wiped the mirrored
calendar out of the development database it was pointed at. Exits non-zero on
the first failed assertion.

What it guards: a refresh REPLACES a source's rows — and only that source's.
Upsert alone would let a rescheduled contest keep its old start time and a
cancelled one never leave; a delete that forgot the source scope would let one
judge's refresh wipe every other judge's calendar; and a fetcher that throws
must leave its last good rows standing rather than blanking its judge. A stale
row looks exactly like a fresh one, so none of these would fail loudly.
"""

import asyncio
import logging
import os
import sys

import contests
import db

logging.basicConfig(level=logging.CRITICAL, format="%(asctime)s %(message)s")

FAILURES: list[str] = []

# Fake source names, so every write and delete this test makes is scoped to
# rows no real fetcher owns.
SRC_A = "__test_src_a__"
SRC_B = "__test_src_b__"


def check(label: str, got, want) -> None:
    if got == want:
        print(f"  ok   {label}: {got}")
    else:
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
        FAILURES.append(label)


def rows(conn) -> dict[tuple[str, str], tuple]:
    with conn.cursor() as cur:
        cur.execute(
            """
            select source, external_id, name, platform,
                   extract(epoch from starts_at)::bigint as starts
            from upcoming_contests where source in (%s, %s)
            """,
            (SRC_A, SRC_B),
        )
        return {
            (r["source"], r["external_id"]): (r["name"], r["platform"], r["starts"])
            for r in cur.fetchall()
        }


def row(cid: str, name: str, starts: int, platform: str) -> contests.Row:
    return (cid, name, f"https://example.test/{cid}", starts, 7200, platform)


def cleanup(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "delete from upcoming_contests where source in (%s, %s)", (SRC_A, SRC_B)
        )
    conn.commit()


async def main() -> None:
    conn = db.connect()
    cleanup(conn)

    listings: dict[str, list[contests.Row]] = {SRC_A: [], SRC_B: []}

    def fake(source: str):
        async def fetch() -> list[contests.Row]:
            return listings[source]

        return fetch

    async def broken() -> list[contests.Row]:
        raise RuntimeError("judge is down")

    real_fetchers = contests.FETCHERS
    contests.FETCHERS = {SRC_A: fake(SRC_A), SRC_B: fake(SRC_B)}
    try:
        print("first refresh mirrors each source")
        listings[SRC_A] = [row("9001", "Round A", 2_000_000_000, "Codeforces")]
        listings[SRC_B] = [row("abc900", "ABC 900", 2_000_100_000, "AtCoder")]
        counts = await contests.refresh(conn)
        check("counts", counts, {SRC_A: 1, SRC_B: 1})
        check("row count", len(rows(conn)), 2)

        print("a reschedule moves the stored start; a cancellation removes the row")
        listings[SRC_A] = [
            row("9001", "Round A (moved)", 2_000_050_000, "Codeforces"),
            row("9002", "Round B", 2_000_200_000, "Codeforces"),
        ]
        await contests.refresh(conn)
        got = rows(conn)
        check("rescheduled start", got[(SRC_A, "9001")][2], 2_000_050_000)
        check("renamed", got[(SRC_A, "9001")][0], "Round A (moved)")
        check("new row present", (SRC_A, "9002") in got, True)

        print("one source's refresh never touches another's rows")
        listings[SRC_B] = []
        await contests.refresh(conn)
        got = rows(conn)
        check("source B emptied", (SRC_B, "abc900") in got, False)
        check("source A untouched", len([k for k in got if k[0] == SRC_A]), 2)

        print("a fetcher that throws keeps its last good rows")
        contests.FETCHERS = {SRC_A: broken}
        counts = await contests.refresh(conn)
        check("failed source reported as absent", counts, {})
        check("its rows still standing", len(rows(conn)), 2)
    finally:
        contests.FETCHERS = real_fetchers
        cleanup(conn)
        conn.close()

    if FAILURES:
        print(f"\n{len(FAILURES)} failure(s): {FAILURES}")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    if "DATABASE_URL" not in os.environ:
        print("Set DATABASE_URL to a scratch database first.")
        sys.exit(2)
    asyncio.run(main())
