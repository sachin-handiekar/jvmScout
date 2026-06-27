"""Authentication, rate limiting, and request-guard helpers.

The collector can capture secrets and PII (local variable values, env vars,
system properties), so every data endpoint is guarded. Auth is enabled by
setting ``COLLECTOR_API_KEY``; when unset the collector runs open (suitable only
for a trusted local network) and logs a prominent warning at startup.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Optional

from fastapi import Depends, Header, HTTPException, Query, Request, WebSocket, status

from . import storage
from .config import settings

log = logging.getLogger("collector.security")

# Roles, narrowest to broadest. ``ingest`` agents may only POST events; ``viewer``
# accounts may only read; ``admin`` may also manage a project's tokens/config.
ROLE_INGEST = "ingest"
ROLE_VIEWER = "viewer"
ROLE_ADMIN = "admin"
VALID_ROLES = frozenset({ROLE_INGEST, ROLE_VIEWER, ROLE_ADMIN})

# Default applied to a token issued without an explicit project/role (and to the
# legacy single-key flow), so existing setups keep full access.
DEFAULT_PROJECT = "default"
DEFAULT_ROLE = ROLE_ADMIN


def hash_token(raw: str) -> str:
    """SHA-256 hex of a raw API token (what we store; never the token itself)."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Principal:
    """The authenticated caller. ``is_master`` is the superadmin (master key):
    it sees every project (``project_id`` filter is None) and passes every role
    gate. A scoped token carries its own ``project_id`` and ``role``."""
    project_id: Optional[str]
    role: str
    is_master: bool = False

    @property
    def scope(self) -> Optional[str]:
        """Project filter to pass to storage: None means 'all projects'."""
        return None if self.is_master else self.project_id

    @property
    def can_read(self) -> bool:
        return self.is_master or self.role in (ROLE_VIEWER, ROLE_ADMIN)

    @property
    def can_ingest(self) -> bool:
        return self.is_master or self.role in (ROLE_INGEST, ROLE_ADMIN)

    @property
    def can_admin(self) -> bool:
        return self.is_master or self.role == ROLE_ADMIN


# Principal used when auth is disabled (open collector): full access, all projects.
OPEN_PRINCIPAL = Principal(project_id=None, role=DEFAULT_ROLE, is_master=True)


class TokenStore:
    """Short-TTL cache mapping active (non-revoked) API-token hashes to their
    ``(project_id, role)``, sourced from the UI-managed `api_tokens` config rows.
    Lets per-token auth + scoping work without a DB hit on every request."""

    def __init__(self, ttl_s: float = 10.0) -> None:
        self._ttl = ttl_s
        self._at = 0.0
        self._by_hash: dict[str, tuple[str, str]] = {}

    async def active(self) -> dict[str, tuple[str, str]]:
        now = time.monotonic()
        if now - self._at > self._ttl:
            rows = await storage.list_config("api_tokens")
            self._by_hash = {
                r["token_hash"]: (
                    r.get("project_id") or DEFAULT_PROJECT,
                    r.get("role") if r.get("role") in VALID_ROLES else DEFAULT_ROLE,
                )
                for r in rows
                if r.get("token_hash") and not r.get("revoked_at")
            }
            self._at = now
        return self._by_hash

    def reset(self) -> None:
        """Force a reload on next use (after a token is issued/revoked, or tests)."""
        self._at = 0.0
        self._by_hash = {}


token_store = TokenStore()


async def resolve_principal(provided: Optional[str]) -> Optional[Principal]:
    """Resolve a raw token to a Principal, or None if it isn't valid."""
    if not provided:
        return None
    if _token_matches(provided):
        return Principal(project_id=None, role=DEFAULT_ROLE, is_master=True)
    candidate = hash_token(provided)
    for h, (project_id, role) in (await token_store.active()).items():
        if hmac.compare_digest(candidate, h):
            return Principal(project_id=project_id, role=role)
    return None


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
) -> Principal:
    """FastAPI dependency: reject requests lacking a valid API key and return the
    resolved Principal (so endpoints can scope by project/role).

    Accepts the key via ``Authorization: Bearer <key>``, ``X-API-Key``, or a
    ``?key=`` query parameter (the last lets the static dashboard pass it). When
    auth is disabled the open superadmin principal is used.
    """
    if not settings.auth_enabled:
        return OPEN_PRINCIPAL
    token = _extract_token(authorization, x_api_key, key)
    principal = await resolve_principal(token)
    if principal is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid API key",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return principal


# Role gates depend on require_auth (FastAPI resolves + caches it once per
# request), so they always receive the validated Principal regardless of
# dependency ordering.
def require_read(principal: Principal = Depends(require_auth)) -> Principal:
    if not principal.can_read:
        raise HTTPException(status_code=403, detail="token lacks read access")
    return principal


def require_ingest(principal: Principal = Depends(require_auth)) -> Principal:
    if not principal.can_ingest:
        raise HTTPException(status_code=403, detail="token lacks ingest access")
    return principal


def require_admin(principal: Principal = Depends(require_auth)) -> Principal:
    if not principal.can_admin:
        raise HTTPException(status_code=403, detail="token lacks admin access")
    return principal


async def authorize_websocket(ws: WebSocket) -> Optional[Principal]:
    """Validate a WebSocket handshake. Returns the Principal or None if rejected."""
    if not settings.auth_enabled:
        return OPEN_PRINCIPAL
    token = _extract_token(
        ws.headers.get("authorization"),
        ws.headers.get("x-api-key"),
        ws.query_params.get("key"),
    )
    principal = await resolve_principal(token)
    if principal is None or not principal.can_read:
        return None
    return principal


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
