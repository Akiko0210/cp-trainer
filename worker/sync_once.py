"""Sync every member once, then exit.

The worker's normal shape is a service with a loop (app.py). That needs a
process that stays up, which a free serverless host doesn't have — so this is
the same work as one pass of that loop, packaged to be run by a scheduler that
starts it, waits, and throws the machine away. GitHub Actions is the intended
caller; cron on any box works identically.

    DATABASE_URL=… uv run python sync_once.py

Exits non-zero only if *every* member failed, which is the difference between
"Codeforces was flaky for one handle" and "the database is unreachable" — a
scheduled job that cries wolf gets muted, and then nobody notices the real one.
"""

import asyncio
import logging
import os
import sys
import time

import db
import sync

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("sync_once")


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        log.error("DATABASE_URL is not set")
        return 2

    started = time.monotonic()
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            "select id, cf_handle from users where cf_handle is not null order by id"
        )
        members = [(r["id"], r["cf_handle"]) for r in cur.fetchall()]

    if not members:
        log.info("no linked members — nothing to sync")
        return 0

    log.info("syncing %d member(s)", len(members))
    ok, failed = 0, 0

    for user_id, handle in members:
        try:
            # Each user is its own connection and its own transaction: one
            # member's bad data must not roll back everybody else's sync.
            with db.connect() as conn:
                result = await sync.sync_user(conn, user_id)
            ok += 1
            log.info("  %-20s ok  %s", handle, result)
        except Exception as e:  # noqa: BLE001 — a per-member failure is expected
            failed += 1
            log.warning("  %-20s FAILED  %s", handle, e)

    log.info(
        "done in %.0fs — %d ok, %d failed", time.monotonic() - started, ok, failed
    )
    return 1 if ok == 0 else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
