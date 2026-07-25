"""Shared, backoff-aware queue for Codeforces API calls (handoff §4.1).

Every CF request in the whole worker goes through `call()`, which serializes
requests behind one lock and enforces a minimum gap between calls. This is the
piece the spec says to build now so multi-user sync doesn't have to retrofit it:
N users syncing concurrently still produce one polite request stream.

CF's informal limit is ~1 request / 2 seconds. We keep 2.2s spacing and back off
exponentially on 429/503/"limit exceeded" responses.
"""

import asyncio
import time
from typing import Any

import httpx

BASE = "https://codeforces.com/api"
MIN_INTERVAL_S = 2.2
MAX_RETRIES = 5

_lock = asyncio.Lock()
_last_call = 0.0


class CFError(Exception):
    """CF answered with status=FAILED (bad handle, etc.) — not retryable."""


async def call(method: str, **params: Any) -> Any:
    """Rate-limited, retrying GET of /api/{method}. Returns the `result` field."""
    global _last_call
    async with _lock:
        for attempt in range(MAX_RETRIES):
            wait = MIN_INTERVAL_S - (time.monotonic() - _last_call)
            if wait > 0:
                await asyncio.sleep(wait)
            _last_call = time.monotonic()
            try:
                async with httpx.AsyncClient(timeout=60) as client:
                    resp = await client.get(f"{BASE}/{method}", params=params)
                if resp.status_code in (429, 503):
                    raise httpx.HTTPStatusError(
                        "rate limited", request=resp.request, response=resp
                    )
                data = resp.json()
            except (httpx.HTTPError, ValueError):
                if attempt == MAX_RETRIES - 1:
                    raise
                await asyncio.sleep(2**attempt * 2)  # 2s, 4s, 8s, 16s
                continue

            if data.get("status") == "OK":
                return data["result"]
            comment = data.get("comment", "")
            if "limit" in comment.lower() and attempt < MAX_RETRIES - 1:
                await asyncio.sleep(2**attempt * 2)
                continue
            raise CFError(comment or f"CF call {method} failed")
    raise CFError(f"CF call {method} exhausted retries")
