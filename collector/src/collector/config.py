"""Environment-driven collector settings."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _split_csv(value: str) -> tuple[str, ...]:
    return tuple(p.strip() for p in value.split(",") if p.strip())


@dataclass(frozen=True)
class Settings:
    host: str = "0.0.0.0"
    port: int = 8080
    db_url: str = "sqlite+aiosqlite:///./collector.db"
    retention_days: int = 30

    # Security / limits.
    api_key: str = ""
    # Explicitly run the collector unauthenticated. When False (default) and no
    # COLLECTOR_API_KEY is set, a master token is bootstrapped into the token
    # store on first start and printed once - the collector never silently runs
    # open, because captured events can contain secrets/PII.
    allow_anonymous: bool = False
    cors_origins: tuple[str, ...] = field(default_factory=tuple)
    max_body_bytes: int = 5 * 1024 * 1024  # 5 MiB
    rate_limit_per_min: int = 0  # 0 disables rate limiting
    purge_interval_seconds: int = 3600  # 0 disables periodic purge
    # Allow alert webhooks to target private/internal addresses. Off by default:
    # in multi-tenant mode a project admin controls the destination URL, and the
    # collector must not be usable as an SSRF proxy into its own network.
    alert_allow_private: bool = False

    @property
    def auth_enabled(self) -> bool:
        return bool(self.api_key) or not self.allow_anonymous

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            host=os.environ.get("COLLECTOR_HOST", "0.0.0.0"),
            port=int(os.environ.get("COLLECTOR_PORT", "8080")),
            db_url=os.environ.get("COLLECTOR_DB_URL", "sqlite+aiosqlite:///./collector.db"),
            retention_days=int(os.environ.get("COLLECTOR_RETENTION_DAYS", "30")),
            api_key=os.environ.get("COLLECTOR_API_KEY", ""),
            allow_anonymous=os.environ.get(
                "COLLECTOR_ALLOW_ANONYMOUS", "").lower() in ("1", "true", "yes"),
            cors_origins=_split_csv(os.environ.get("COLLECTOR_CORS_ORIGINS", "")),
            max_body_bytes=int(os.environ.get("COLLECTOR_MAX_BODY_BYTES", str(5 * 1024 * 1024))),
            rate_limit_per_min=int(os.environ.get("COLLECTOR_RATE_LIMIT_PER_MIN", "0")),
            purge_interval_seconds=int(os.environ.get("COLLECTOR_PURGE_INTERVAL_SECONDS", "3600")),
            alert_allow_private=os.environ.get(
                "COLLECTOR_ALERT_ALLOW_PRIVATE", "").lower() in ("1", "true", "yes"),
        )


settings = Settings.from_env()
