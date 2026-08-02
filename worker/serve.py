"""Entry point that binds dual-stack, because no uvicorn flag can.

Railway's healthchecks and private networking arrive over IPv6; docker-compose
and the image's own HEALTHCHECK arrive over IPv4. One bind has to serve both.
`--host 0.0.0.0` is IPv4-only, and `--host ::` *ought* to be dual-stack on
Linux (bindv6only defaults to 0) — but asyncio explicitly sets IPV6_V6ONLY on
every AF_INET6 listener it creates, so uvicorn's own bind refuses IPv4 no
matter what the kernel would allow. Measured, not assumed: 127.0.0.1 got
connection-refused from a server listening on [::]:8787.

So: make the socket here, turn V6ONLY off before binding, and give uvicorn the
finished listener. Still one process — the CF rate limiter and per-user locks
in app.py live in process memory, so this must never become two servers.
"""

import os
import socket

import uvicorn

# PORT first: that is the variable Railway injects and aims its healthcheck
# and routing at, so honouring it removes a whole class of "healthy but
# unreachable" — no dashboard port config needed at all. WORKER_PORT is the
# name app.py's docs promise for a box of your own; 8787 the compose default.
PORT = int(os.environ.get("PORT") or os.environ.get("WORKER_PORT") or "8787")

sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
sock.bind(("::", PORT))
sock.listen(2048)

if __name__ == "__main__":
    config = uvicorn.Config("app:app", log_level="info")
    uvicorn.Server(config).run(sockets=[sock])
