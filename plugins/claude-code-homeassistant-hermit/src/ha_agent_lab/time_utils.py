"""Shared time-parsing helpers for the HA snapshot pipeline."""
from __future__ import annotations

from datetime import UTC, datetime


def parse_iso(ts: str | None) -> datetime | None:
    """Parse an ISO 8601 timestamp. Returns None for falsy or malformed input."""
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts)
    except (ValueError, TypeError):
        return None


def days_since(now: datetime, then: datetime | None) -> int | None:
    """Whole days between two timestamps (now - then). Returns None if `then` is None."""
    if then is None:
        return None
    delta = now - then.astimezone(UTC)
    return int(delta.total_seconds() // 86400)
