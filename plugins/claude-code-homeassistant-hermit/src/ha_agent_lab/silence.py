"""Silence-summary analysis — dead automations, silent sensors, long-unavailable entities."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_EVENT_SENSOR_DEVICE_CLASSES = frozenset({"motion", "door", "window", "opening", "occupancy"})
_INACTIVE_CANDIDATE_DOMAINS = frozenset({"light", "switch", "cover", "climate"})


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts)
    except (ValueError, TypeError):
        return None


def _days_since(now: datetime, then: datetime | None) -> int | None:
    if then is None:
        return None
    delta = now - then.astimezone(UTC)
    return int(delta.total_seconds() // 86400)


def _load_degraded_entity_domains(root: Path) -> set[str]:
    """Return degraded entity-domain prefixes from the integration-health state artifact.

    Returns an empty set if the artifact is missing or malformed — suppression is
    opportunistic; silence.py self-heals after the next ha integration-health run.
    """
    path = root / ".claude-code-hermit" / "state" / "integration-health-degraded-domains.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return {entry["domain"] for entry in data.get("degraded_entity_domains", []) if isinstance(entry.get("domain"), str)}
    except (OSError, json.JSONDecodeError, TypeError):
        return set()


def _classify_automation(
    entity: dict[str, Any],
    now: datetime,
    dead_threshold_days: int,
) -> dict[str, Any] | None:
    """Return a dead-automation payload for enabled automations past the threshold, else None.

    Disabled automations (state == 'off') are dropped silently.
    """
    if entity.get("state") != "on":
        return None
    attrs = entity.get("attributes") or {}
    last_triggered_raw = attrs.get("last_triggered")
    last_triggered = _parse_iso(last_triggered_raw)
    days = _days_since(now, last_triggered)
    never_fired = last_triggered is None
    if not never_fired and (days is None or days < dead_threshold_days):
        return None
    return {
        "entity_id": entity["entity_id"],
        "last_triggered": last_triggered_raw,
        "days_silent": days,
        "never_fired": never_fired,
    }


def _classify_event_sensor(entity: dict[str, Any], now: datetime, stuck_days: int) -> dict[str, Any] | None:
    """Return a silent-event-sensor payload if the sensor hasn't fired in stuck_days, else None."""
    attrs = entity.get("attributes") or {}
    device_class = attrs.get("device_class")
    if device_class not in _EVENT_SENSOR_DEVICE_CLASSES:
        return None
    last_changed = _parse_iso(entity.get("last_changed"))
    days = _days_since(now, last_changed)
    if days is None or days < stuck_days:
        return None
    return {
        "entity_id": entity["entity_id"],
        "device_class": device_class,
        "last_changed": entity.get("last_changed"),
        "days_silent": days,
    }


def compute_silence_summary(
    normalized: dict[str, Any],
    root: Path,
    *,
    now: datetime | None = None,
    stuck_days: int = 7,
    dead_automation_days: int = 30,
) -> dict[str, Any]:
    """Compute silence metrics from the normalized snapshot.

    Reads the integration-health degraded-domains artifact to suppress long_unavailable
    entries that ha-integration-health already covers.
    """
    if now is None:
        now = datetime.now(UTC)

    entity_index: dict[str, Any] = normalized.get("entity_index", {})
    unavailable_list: list[str] = normalized.get("unavailable_entities", [])

    degraded_domains = _load_degraded_entity_domains(root)

    dead_automations: list[dict[str, Any]] = []
    silent_event_sensors: list[dict[str, Any]] = []
    inactive_by_domain: dict[str, list[dict[str, Any]]] = {d: [] for d in _INACTIVE_CANDIDATE_DOMAINS}
    long_unavailable: list[dict[str, Any]] = []

    for entity_id, entity in entity_index.items():
        domain = entity_id.split(".", 1)[0]
        entity_with_id = {**entity, "entity_id": entity_id}

        if domain == "automation":
            result = _classify_automation(entity_with_id, now, dead_automation_days)
            if result:
                dead_automations.append(result)
            continue

        if domain == "binary_sensor":
            payload = _classify_event_sensor(entity_with_id, now, stuck_days)
            if payload:
                silent_event_sensors.append(payload)
            continue

        if domain in _INACTIVE_CANDIDATE_DOMAINS:
            last_changed = _parse_iso(entity.get("last_changed"))
            days = _days_since(now, last_changed)
            if days is not None and days >= stuck_days:
                inactive_by_domain[domain].append({
                    "entity_id": entity_id,
                    "last_changed": entity.get("last_changed"),
                    "days_silent": days,
                })

    suppressed_domains: set[str] = set()
    for entity_id in unavailable_list:
        domain = entity_id.split(".", 1)[0]
        entity = entity_index.get(entity_id, {})
        since = entity.get("last_changed")
        last_changed = _parse_iso(since)
        days = _days_since(now, last_changed)
        if days is None or days < stuck_days:
            continue
        if domain in degraded_domains:
            suppressed_domains.add(domain)
            continue
        long_unavailable.append({"entity_id": entity_id, "domain": domain, "since": since, "days": days})

    def _sort(items: list[dict]) -> list[dict]:
        return sorted(items, key=lambda x: (-(x.get("days_silent") or x.get("days") or 0), x.get("entity_id", "")))

    return {
        "computed_at": now.isoformat(),
        "thresholds": {"stuck_days": stuck_days, "dead_automation_days": dead_automation_days},
        "dead_automations": _sort(dead_automations),
        "silent_event_sensors": _sort(silent_event_sensors),
        "inactive_candidates_by_domain": {d: _sort(v) for d, v in inactive_by_domain.items()},
        "long_unavailable": _sort(long_unavailable),
        "suppressed_entity_domains": sorted(suppressed_domains),
    }
