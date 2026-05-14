"""History API aggregation — pattern detection for ha-analyze-patterns and ha-morning-brief."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .artifacts import write_json_artifact
from .ha_api import HomeAssistantClient
from .time_utils import parse_iso

_DEFAULT_DOMAINS = frozenset({"light", "switch", "cover", "climate", "automation"})
_HISTORY_BINARY_SENSOR_CLASSES = frozenset({"motion", "door", "window", "opening", "occupancy"})

# Informational description of the default scope for documentation and tests.
DEFAULT_ENTITY_SCOPE = (
    "light.*", "switch.*", "cover.*", "climate.*", "automation.*",
    "binary_sensor.* (motion/door/window/opening/occupancy)",
)


def select_history_entities(
    normalized: dict[str, Any],
    *,
    override: list[str] | None = None,
) -> list[str]:
    """Return entity IDs for the history fetch.

    When override is given it is returned verbatim (sorted). Otherwise the
    default scope applies: all entities in light/switch/cover/climate/automation
    domains, plus binary_sensor entities whose device_class is in the event
    sensor set.
    """
    if override is not None:
        return sorted(override)
    entity_index: dict[str, Any] = normalized.get("entity_index", {})
    result: list[str] = []
    for entity_id, entity in entity_index.items():
        domain = entity_id.split(".", 1)[0]
        if domain in _DEFAULT_DOMAINS:
            result.append(entity_id)
        elif domain == "binary_sensor":
            attrs = entity.get("attributes") or {}
            if attrs.get("device_class") in _HISTORY_BINARY_SENSOR_CLASSES:
                result.append(entity_id)
    return sorted(result)


def aggregate_history(
    history: dict[str, list[dict[str, Any]]],
    requested: list[str],
    *,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, dict[str, Any]]:
    """Aggregate HA history events per entity.

    Entities in `requested` that are absent from `history` (no events in the
    window) get synthesized zero-count rows so callers always see a complete
    picture. `state_durations` clips event spans to [window_start, window_end].
    """
    ws = window_start.astimezone(UTC)
    we = window_end.astimezone(UTC)
    result: dict[str, dict[str, Any]] = {}

    for entity_id in requested:
        events = history.get(entity_id)
        if events is None:
            result[entity_id] = {
                "event_count": 0,
                "returned": False,
                "hour_histogram": [0] * 24,
                "last_event_iso": None,
                "state_durations": {},
            }
            continue

        timestamps = [parse_iso(ev.get("last_changed")) for ev in events]

        histogram = [0] * 24
        last_event: datetime | None = None

        for ts in timestamps:
            if ts is not None:
                ts_utc = ts.astimezone(UTC)
                histogram[ts_utc.hour] += 1
                if last_event is None or ts_utc > last_event:
                    last_event = ts_utc

        state_durations: dict[str, float] = {}
        for i, ev in enumerate(events):
            ev_ts = timestamps[i]
            if ev_ts is None:
                continue
            span_start = max(ev_ts.astimezone(UTC), ws)
            next_ts = timestamps[i + 1] if i + 1 < len(timestamps) else None
            span_end = min(next_ts.astimezone(UTC) if next_ts is not None else we, we)
            if span_end > span_start:
                state = ev.get("state", "")
                state_durations[state] = state_durations.get(state, 0.0) + (span_end - span_start).total_seconds()

        result[entity_id] = {
            "event_count": len(events),
            "returned": True,
            "hour_histogram": histogram,
            "last_event_iso": last_event.isoformat() if last_event else None,
            "state_durations": {s: int(secs) for s, secs in state_durations.items()},
        }

    return result


def detect_time_patterns(aggregates: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Return entities with a dominant single-hour activity peak.

    A pattern requires total events >= 5 and the peak hour accounting for
    > 50% of total events. Synthesized zero-count rows are skipped.
    """
    patterns: list[dict[str, Any]] = []
    for entity_id, agg in aggregates.items():
        if not agg.get("returned"):
            continue
        total = agg.get("event_count", 0)
        if total < 5:
            continue
        histogram = agg.get("hour_histogram", [0] * 24)
        peak_hour = max(range(24), key=lambda h: histogram[h])
        peak_count = histogram[peak_hour]
        if peak_count / total > 0.5:
            patterns.append({
                "entity_id": entity_id,
                "peak_hour": peak_hour,
                "peak_count": peak_count,
                "total": total,
                "description": f"{entity_id} — {peak_count}/{total} events at {peak_hour:02d}:00 UTC",
            })
    return sorted(patterns, key=lambda p: (-p["peak_count"], p["entity_id"]))


def fetch_history_snapshot(
    root: Path,
    client: HomeAssistantClient,
    normalized: dict[str, Any],
    *,
    window_days: int = 7,
    entity_override: list[str] | None = None,
) -> dict[str, Any]:
    """Fetch, aggregate, and write a history snapshot artifact.

    Writes both a dated file and a fixed-name latest alias under
    `.claude-code-hermit/raw/snapshot-ha-history-{window_days}d-{date}.json`.
    """
    now = datetime.now(UTC)
    window_start = now - timedelta(days=window_days)

    entity_ids = select_history_entities(normalized, override=entity_override)
    history = client.get_history(entity_ids, window_start, now)
    aggregates = aggregate_history(history, entity_ids, window_start=window_start, window_end=now)
    time_patterns = detect_time_patterns(aggregates)

    returned_entities = sorted(eid for eid, agg in aggregates.items() if agg.get("returned"))
    missing_entities = sorted(eid for eid, agg in aggregates.items() if not agg.get("returned"))

    payload: dict[str, Any] = {
        "window_start": window_start.isoformat(),
        "window_end": now.isoformat(),
        "fetched_at": now.isoformat(),
        "requested_entities": entity_ids,
        "returned_entities": returned_entities,
        "missing_entities": missing_entities,
        "event_total": sum(agg["event_count"] for agg in aggregates.values()),
        "entity_aggregates": aggregates,
        "time_patterns": time_patterns,
    }

    write_json_artifact(
        root,
        ".claude-code-hermit/raw",
        f"snapshot-ha-history-{window_days}d",
        payload,
        latest_name=f"snapshot-ha-history-{window_days}d-latest.json",
    )

    return payload
