"""Real-time fan-out, moved to the process that is allowed to stay alive.

The schema's triggers pg_notify('standings', …) on every accepted write; this
module holds ONE LISTEN connection for the whole worker and fans out to every
connected browser. It exists because the web app's copy of this idea
(src/lib/realtime.ts) runs on a serverless host: one LISTEN client *per
lambda*, every stream cut at 60 seconds, and each of those parked connections
keeping the database's scale-to-zero meter running. Here a stream is cut
never, and there is exactly one Postgres connection no matter how many tabs
are open.

Browsers reach this endpoint directly, cross-origin, so requests carry a
token minted by the Next app — HMAC-signed with WORKER_TOKEN, the secret the
two services already share. The token names the guild; filtering happens here,
server-side, so a stream can never leak another guild's activity.

The LISTEN connection is torn down ~30s after the last viewer leaves, for the
same reason realtime.ts does it: Postgres that scales to zero bills on "is
anything connected", and a parked LISTEN is indistinguishable from a busy one
to that meter. The sync loop wakes the database twice an hour regardless;
an idle leaderboard should not keep it awake around the clock.
"""

import asyncio
import base64
import binascii
import hmac
import json
import logging
import os
import time
from urllib.parse import urlsplit, urlunsplit

import psycopg

log = logging.getLogger("broadcast")


def listen_url(url: str) -> str:
    """The direct endpoint for a Neon pooled URL; anything else unchanged.

    Neon names its pooler `<endpoint>-pooler.<region>…` and the same host
    without the suffix is the direct connection. This exists because the
    production worker was given only the pooled DATABASE_URL: LISTEN went
    through PgBouncer, registered without complaint, logged "up", and never
    received a single notification — every live surface froze until a
    reload, and nothing anywhere looked like an error.
    """
    parts = urlsplit(url)
    userinfo, at, hostport = parts.netloc.rpartition("@")
    host, colon, port = hostport.partition(":")
    first, dot, rest = host.partition(".")
    if not first.endswith("-pooler"):
        return url
    host = first[: -len("-pooler")] + dot + rest
    return urlunsplit(parts._replace(netloc=f"{userinfo}{at}{host}{colon}{port}"))


# LISTEN cannot survive a transaction pooler: the connection the listener was
# registered on is handed to another caller between statements, and
# notifications silently never arrive. Prefer the direct URL where one exists,
# and derive it from a recognisably pooled one where it doesn't.
DATABASE_URL = listen_url(
    os.environ.get("DATABASE_URL_UNPOOLED")
    or os.environ.get("DATABASE_URL")
    or "postgresql://cp:cp@localhost:5488/cp_trainer"
)
# Where writers NOTIFY from — the triggers fire on whatever connection the
# app and the sync use. The startup probe sends through this one so it tests
# the real path.
NOTIFY_URL = os.environ.get("DATABASE_URL") or DATABASE_URL
PROBE_CHANNEL = "cp_listen_probe"
PROBE_TIMEOUT_S = 10.0

IDLE_CLOSE_S = 30.0
RECONNECT_DELAY_S = 2.0
QUEUE_MAX = 256


class TokenError(Exception):
    pass


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64url(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def mint_stream_token(secret: str, guild_id: int, user_id: int, ttl_s: int) -> str:
    """The Next app is the real minter (stream-token route); this twin exists
    so the tests exercise the exact verify path a browser will hit."""
    payload = _b64url(
        json.dumps(
            {"g": guild_id, "u": user_id, "exp": int(time.time()) + ttl_s}
        ).encode()
    )
    sig = _b64url(hmac.new(secret.encode(), payload.encode(), "sha256").digest())
    return f"{payload}.{sig}"


def verify_stream_token(token: str, secret: str) -> dict:
    """Returns the claims, or raises TokenError.

    The signature is over the *encoded* payload string, so both languages hash
    identical bytes and nobody re-canonicalises JSON. An empty secret skips
    the signature — the localhost-development stance require_token() already
    takes; in production the Next app refuses to boot without the token set.
    """
    try:
        payload_b64, sig_b64 = token.split(".")
    except ValueError:
        raise TokenError("Malformed token")
    if secret:
        want = hmac.new(secret.encode(), payload_b64.encode(), "sha256").digest()
        try:
            got = _unb64url(sig_b64)
        except (binascii.Error, ValueError):
            raise TokenError("Malformed signature")
        if not hmac.compare_digest(want, got):
            raise TokenError("Bad signature")
    try:
        claims = json.loads(_unb64url(payload_b64))
        guild_id = int(claims["g"])
        exp = int(claims["exp"])
    except (binascii.Error, ValueError, KeyError, TypeError):
        raise TokenError("Malformed payload")
    if exp < time.time():
        raise TokenError("Token expired")
    return {"g": guild_id, "u": claims.get("u"), "exp": exp}


class Broadcaster:
    def __init__(self) -> None:
        # (queue, guild, user). The user is what an addressed event — one
        # carrying `recipient_id`, the inbox — is matched against; it is None
        # for a token minted without one, and such a subscriber gets no
        # addressed events at all rather than everybody's.
        self._subs: set[tuple[asyncio.Queue, int, int | None]] = set()
        self._listener: asyncio.Task | None = None
        self._idle: asyncio.Task | None = None
        # Set while the LISTEN is registered; cleared when the connection
        # drops. register() waits on it so a viewer is never told "ready"
        # while events are still falling on the floor — a connected-looking
        # board that misses events is this feature's worst failure.
        self._up = asyncio.Event()

    async def register(self, guild_id: int, user_id: int | None = None) -> asyncio.Queue:
        if self._idle is not None:
            self._idle.cancel()
            self._idle = None
        if self._listener is None or self._listener.done():
            self._listener = asyncio.create_task(self._listen())
        try:
            await asyncio.wait_for(self._up.wait(), timeout=10)
        except TimeoutError:
            # Database unreachable. Serve the stream anyway: the listener task
            # keeps retrying behind the scenes, and a degraded stream that
            # heals beats a 500 the browser would hammer us to retry.
            log.warning("stream registered before LISTEN came up")
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self._subs.add((q, guild_id, user_id))
        return q

    def unregister(self, q: asyncio.Queue, guild_id: int, user_id: int | None = None) -> None:
        self._subs.discard((q, guild_id, user_id))
        if not self._subs:
            self._idle = asyncio.create_task(self._idle_close())

    async def _idle_close(self) -> None:
        await asyncio.sleep(IDLE_CLOSE_S)
        if not self._subs and self._listener is not None:
            self._listener.cancel()
            self._listener = None
            log.info("no viewers for %.0fs — LISTEN closed, database may sleep",
                     IDLE_CLOSE_S)

    def shutdown(self) -> None:
        for t in (self._listener, self._idle):
            if t is not None:
                t.cancel()
        self._listener = None
        self._idle = None

    async def _listen(self) -> None:
        while True:
            try:
                conn = await psycopg.AsyncConnection.connect(
                    DATABASE_URL, autocommit=True
                )
                probe: asyncio.Task | None = None
                try:
                    await conn.execute("listen standings")
                    await conn.execute(f"listen {PROBE_CHANNEL}")
                    self._up.set()
                    log.info("LISTEN standings up")
                    heard = asyncio.Event()
                    probe = asyncio.create_task(self._probe(heard))
                    async for n in conn.notifies():
                        if n.channel == PROBE_CHANNEL:
                            heard.set()
                            continue
                        self._dispatch(n.payload)
                finally:
                    if probe is not None:
                        probe.cancel()
                    self._up.clear()
                    await conn.close()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Reconnect rather than die: a dead listener with live streams
                # is a board that looks connected and never moves.
                log.exception(
                    "listener dropped; reconnecting in %.0fs", RECONNECT_DELAY_S
                )
                await asyncio.sleep(RECONNECT_DELAY_S)

    async def _probe(self, heard: asyncio.Event) -> None:
        """Prove the listener actually hears: NOTIFY on a private channel
        through the writers' connection and wait for it to come back. "LISTEN
        up" is not evidence — through a pooler it is logged and then nothing
        ever arrives. A failed probe says so loudly in the log, which is the
        only place this failure is visible at all."""
        try:
            async with await psycopg.AsyncConnection.connect(
                NOTIFY_URL, autocommit=True
            ) as c:
                await c.execute("select pg_notify(%s, 'probe')", (PROBE_CHANNEL,))
            await asyncio.wait_for(heard.wait(), timeout=PROBE_TIMEOUT_S)
            log.info("LISTEN verified: a test NOTIFY round-tripped")
        except asyncio.CancelledError:
            raise
        except TimeoutError:
            log.error(
                "LISTEN is up but a test NOTIFY never arrived within %.0fs — the "
                "listener is almost certainly behind a transaction pooler, and no "
                "live update will reach any browser. Set DATABASE_URL_UNPOOLED to "
                "the direct connection string.",
                PROBE_TIMEOUT_S,
            )
        except Exception:
            log.exception("LISTEN probe could not run")

    def _dispatch(self, payload: str | None) -> None:
        if not payload:
            return
        try:
            event = json.loads(payload)
            guild_id = int(event["guild_id"])
            recipient = event.get("recipient_id")
            recipient = None if recipient is None else int(recipient)
        except (ValueError, KeyError, TypeError):
            return  # a malformed payload must not take down the listener
        for q, gid, uid in list(self._subs):
            if gid != guild_id:
                continue
            # Addressed events go to one person. A subscriber with no user
            # claim is not "everyone" — they are nobody, for these.
            if recipient is not None and (uid is None or uid != recipient):
                continue
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # A consumer this far behind is a dead connection waiting to be
                # noticed; its heartbeat write will fail and clean it up. The
                # client refetches on reconnect, so dropped events are not lost
                # truth, just a later repaint.
                pass


broadcaster = Broadcaster()
