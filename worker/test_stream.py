"""Checks for the worker-side live stream (broadcast.py + GET /stream).

    DATABASE_URL=postgresql://…scratch… uv run python test_stream.py

Needs a reachable Postgres (the docker-compose one is fine) because the thing
most worth testing is the real path: a pg_notify on one connection arriving
through the broadcaster's LISTEN and coming out of the SSE generator, filtered
to the right guild. No tables are touched — NOTIFY needs no schema.

What it guards, in order of expense:
  * **Filtering.** A stream must never carry another guild's events. This is
    the security property of the whole feature. Since 007 an event may also
    be addressed (`recipient_id`): it reaches that one person and nobody
    else, including a subscriber whose token names no user at all.
  * **Tokens.** The Next app mints, this side verifies; the pair has to agree
    byte-for-byte (the signature is over the encoded payload string). Expired
    and tampered tokens must both bounce.
  * **Idle close.** The LISTEN drops after the grace window with no viewers —
    that is what lets a scale-to-zero database actually sleep.
"""

import asyncio
import os
import sys
import time

import httpx

import broadcast
from broadcast import TokenError, mint_stream_token, verify_stream_token

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {label}: {got!r}" + ("" if ok else f" (wanted {want!r})"))
    if not ok:
        FAILURES.append(label)


def check_true(label: str, cond: bool) -> None:
    check(label, bool(cond), True)


# --- tokens ------------------------------------------------------------------


def test_tokens() -> None:
    print("\ntokens")
    secret = "s3cret"
    tok = mint_stream_token(secret, guild_id=7, user_id=3, ttl_s=60)
    claims = verify_stream_token(tok, secret)
    check("round trip guild", claims["g"], 7)

    for label, bad in [
        ("tampered payload", "x" + tok),
        ("no dot", tok.replace(".", "")),
        ("truncated sig", tok[:-4]),
    ]:
        try:
            verify_stream_token(bad, secret)
            check_true(f"{label} rejected", False)
        except TokenError:
            check_true(f"{label} rejected", True)

    expired = mint_stream_token(secret, guild_id=7, user_id=3, ttl_s=-5)
    try:
        verify_stream_token(expired, secret)
        check_true("expired rejected", False)
    except TokenError:
        check_true("expired rejected", True)

    # Empty secret = localhost development: payload still parsed, expiry still
    # honoured, signature not required (mirrors require_token()).
    check("no-secret dev mode", verify_stream_token(tok, "")["g"], 7)


# --- the stream itself -------------------------------------------------------


async def read_events(lines, n: int, timeout: float = 10.0):
    """Collect n `event:` frames (ignoring heartbeats) from an SSE line
    iterator. Takes the iterator, not the response: httpx allows exactly one
    pass over a streamed body, so the caller makes `aiter_lines()` once."""
    events, current = [], {}
    async with asyncio.timeout(timeout):
        async for line in lines:
            if line.startswith("event:"):
                current["event"] = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                current["data"] = line.split(":", 1)[1].strip()
            elif line == "" and current.get("event"):
                events.append(current)
                current = {}
                if len(events) >= n:
                    return events
    return events


async def test_stream() -> None:
    import uvicorn

    import app as worker_app  # imported here so env is settled first

    # A real socket, not httpx's ASGITransport: that transport buffers until
    # the app completes, and an SSE response never completes — the suite's
    # first version hung on exactly this.
    config = uvicorn.Config(
        worker_app.app, host="127.0.0.1", port=8799, log_level="warning"
    )
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve())
    async with asyncio.timeout(10):
        while not server.started:
            await asyncio.sleep(0.05)

    secret = worker_app.WORKER_TOKEN or ""

    async with httpx.AsyncClient(base_url="http://127.0.0.1:8799") as client:
        print("\nauth on /stream")
        r = await client.get("/stream")
        check("no token -> 401", r.status_code, 401)
        r = await client.get("/stream?token=garbage.garbage")
        check("garbage token -> 401", r.status_code, 401)

        print("\ndelivery and filtering")
        tok = mint_stream_token(secret, guild_id=1, user_id=1, ttl_s=60)
        async with client.stream("GET", f"/stream?token={tok}") as resp:
            check("stream opens", resp.status_code, 200)
            lines = resp.aiter_lines()
            (ready,) = await read_events(lines, 1)
            check("first frame is ready", ready["event"], "ready")

            # Real path: NOTIFY on a separate connection, through the
            # broadcaster's LISTEN, out of the generator. One event for our
            # guild, one for another — only ours may arrive, and arrival
            # order proves the filter dropped the other rather than lagging.
            import db

            def fire() -> None:
                with db.connect() as conn, conn.cursor() as cur:
                    cur.execute(
                        "select pg_notify('standings',"
                        " '{\"type\":\"solve\",\"guild_id\":2,\"user_id\":9}')"
                    )
                    cur.execute(
                        "select pg_notify('standings',"
                        " '{\"type\":\"solve\",\"guild_id\":1,\"user_id\":4}')"
                    )
                    conn.commit()

            await asyncio.to_thread(fire)
            (ev,) = await read_events(lines, 1)
            check("event arrives", ev["event"], "standings")
            check_true("it is ours, not guild 2's", '"user_id": 4' in ev["data"]
                       or '"user_id":4' in ev["data"])

            # Addressed events (the inbox, 007): same guild, but one carries
            # recipient_id 2 and we are user 1. Only the one addressed to us
            # may arrive, and it arrives first — the other was dropped, not
            # delayed.
            def fire_addressed() -> None:
                with db.connect() as conn, conn.cursor() as cur:
                    cur.execute(
                        "select pg_notify('standings',"
                        " '{\"type\":\"inbox\",\"guild_id\":1,\"recipient_id\":2,\"id\":50}')"
                    )
                    cur.execute(
                        "select pg_notify('standings',"
                        " '{\"type\":\"inbox\",\"guild_id\":1,\"recipient_id\":1,\"id\":51}')"
                    )
                    cur.execute(
                        "select pg_notify('standings',"
                        " '{\"type\":\"solve\",\"guild_id\":1,\"user_id\":5}')"
                    )
                    conn.commit()

            await asyncio.to_thread(fire_addressed)
            mine, broad = await read_events(lines, 2)
            check_true("addressed to me arrives", '"id": 51' in mine["data"]
                       or '"id":51' in mine["data"])
            check_true("the one for user 2 never did; guild-wide still does",
                       '"user_id": 5' in broad["data"] or '"user_id":5' in broad["data"])

        print("\naddressed events need a user claim")
        # A token with no `u` gets guild-wide events and NO addressed ones —
        # "nobody in particular" must never mean "everybody".
        import json as _json
        payload = broadcast._b64url(_json.dumps({"g": 1, "exp": int(time.time()) + 60}).encode())
        import hmac as _hmac
        sig = broadcast._b64url(_hmac.new(secret.encode(), payload.encode(), "sha256").digest())
        anon = f"{payload}.{sig}"
        async with client.stream("GET", f"/stream?token={anon}") as resp:
            check("anonymous-user stream opens", resp.status_code, 200)
            lines = resp.aiter_lines()
            await read_events(lines, 1)
            await asyncio.to_thread(fire_addressed)
            (only,) = await read_events(lines, 1)
            check_true("only the guild-wide event arrives",
                       '"user_id": 5' in only["data"] or '"user_id":5' in only["data"])

        print("\nidle close")
        # The stream above is closed; after the grace window the LISTEN must
        # be gone so the database can sleep. Shrunk so the suite stays fast.
        check_true("listener was up", broadcast.broadcaster._listener is not None)
        broadcast.IDLE_CLOSE_S = 0.2
        # Re-arm the idle timer at the shrunk grace (the real one was armed at
        # 30s when the stream closed).
        if broadcast.broadcaster._idle is not None:
            broadcast.broadcaster._idle.cancel()
        broadcast.broadcaster._idle = asyncio.get_running_loop().create_task(
            broadcast.broadcaster._idle_close()
        )
        await asyncio.sleep(0.6)
        check("listener closed with no viewers", broadcast.broadcaster._listener, None)

    server.should_exit = True
    await server_task


async def main() -> int:
    test_tokens()
    await test_stream()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {', '.join(FAILURES)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
