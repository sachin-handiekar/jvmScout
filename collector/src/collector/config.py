"""Environment-driven collector settings."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    host: str = "0.0.0.0"
    port: int = 8080
    db_url: str = "sqlite+aiosqlite:///./collector.db"
    retention_days: int = 30

    @staticmethod
    def from_env() -> "Settings":
        return Settings(
            host=os.environ.get("COLLECTOR_HOST", "0.0.0.0"),
            port=int(os.environ.get("COLLECTOR_PORT", "8080")),
            db_url=os.environ.get("COLLECTOR_DB_URL", "sqlite+aiosqlite:///./collector.db"),
            retention_days=int(os.environ.get("COLLECTOR_RETENTION_DAYS", "30")),
        )


settings = Settings.from_env()
