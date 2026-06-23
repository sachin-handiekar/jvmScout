"""Authentication, rate limiting, and request-guard helpers.

The collector can capture secrets and PII (local variable values, env vars,
system properties), so every data endpoint is guarded. Auth is enabled by
setting ``COLLECTOR_API_KEY``; when unset the collector runs open (suitable only
for a trusted local network) and logs a prominent warning at startup.
"""
from __future__ import annotations

import hmac
import logging
import time
from collections import deque
from typing import Optional

from fastapi import Header, HTTPException, Query, Request, WebSocket, status

from .config import settings

log = logging.getLogger("collector.security")


def _token_matches(provided: Optional[str]) -> bool:
    if not provided:
        return False
    # Constant-time comparison to avoid leaking the key via timing.
    return hmac.compare_digest(provided, settings.api_key)


def _extract_token(
    authorization: Optional[str], x_api_key: Optional[str], key_qs: Optional[str]
) -> Optional[str]:
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value:
            return value.strip()
        # Allow a bare token in the Authorization header as well.
        if not value:
            return authorization.strip()
    if x_api_key:
        return x_api_key.strip()
    if key_qs:
        return key_qs.strip()
    return None


async def require_auth(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
    key: Optional[str] = Query(default=None),
) -> None:
    """FastAPI dependency: reject requests lacking a valid API key.

    Accepts the key via ``Authorization: Bearer <key>``, ``X-API-Key``, or a
    ``?key=`` query parameter (the last lets the static dashboard pass it). A
    no-op when auth is disabled.
    """
    if not settings.auth_enabled:
        return
    token = _extract_token(authorization, x_api_key, key)
    if not _token_matches(token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid API key",
            headers={"WWW-Authenticate": "Bearer"},
        )


def authorize_websocket(ws: WebSocket) -> bool:
    """Validate a WebSocket handshake. Returns True when allowed."""
    if not settings.auth_enabled:
        return True
    token = _extract_token(
        ws.headers.get("authorization"),
        ws.headers.get("x-api-key"),
        ws.query_params.get("key"),
    )
    return _token_matches(token)


class RateLimiter:
    """Fixed-window-ish per-client limiter using a sliding 60s deque of hits."""

    def __init__(self, per_minute: int) -> None:
        self.per_minute = per_minute
        self._hits: dict[str, deque[float]] = {}

    def allow(self, client: str) -> bool:
        if self.per_minute <= 0:
            return True
        now = time.monotonic()
        window = self._hits.setdefault(client, deque())
        cutoff = now - 60.0
        while window and window[0] < cutoff:
            window.popleft()
        if len(window) >= self.per_minute:
            return False
        window.append(now)
        return True


rate_limiter = RateLimiter(settings.rate_limit_per_min)


def client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"
