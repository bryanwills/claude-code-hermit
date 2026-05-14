"""Integration-health domain analysis — degraded entity-domain detection."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def compute_degraded_domains(
    normalized: dict[str, Any],
    *,
    min_total: int = 3,
    min_ratio: float = 0.5,
) -> dict[str, Any]:
    """Return degraded entity-domain prefixes from the normalized snapshot.

    A domain is degraded when total >= min_total AND unavailable/total >= min_ratio.
    Matches the threshold rule documented in skills/ha-integration-health/SKILL.md:31-34.
    """
    entity_index: dict[str, Any] = normalized.get("entity_index", {})
    unavailable_set: set[str] = set(normalized.get("unavailable_entities", []))

    domain_totals: dict[str, int] = {}
    domain_unavailable: dict[str, int] = {}
    for entity_id in entity_index:
        domain = entity_id.split(".", 1)[0]
        domain_totals[domain] = domain_totals.get(domain, 0) + 1
        if entity_id in unavailable_set:
            domain_unavailable[domain] = domain_unavailable.get(domain, 0) + 1

    degraded: list[dict[str, Any]] = []
    for domain in sorted(domain_totals):
        total = domain_totals[domain]
        unavail = domain_unavailable.get(domain, 0)
        if total < min_total:
            continue
        ratio = unavail / total
        if ratio < min_ratio:
            continue
        degraded.append({"domain": domain, "total": total, "unavailable": unavail, "ratio": round(ratio, 4)})

    return {
        "computed_at": datetime.now(UTC).isoformat(),
        "thresholds": {"min_total": min_total, "min_ratio": min_ratio},
        "degraded_entity_domains": degraded,
        "scanned_domains": len(domain_totals),
    }


def write_degraded_domains_artifact(root: Path, payload: dict[str, Any]) -> Path:
    """Write the degraded-domains state artifact consumed by silence.py."""
    state_dir = root / ".claude-code-hermit" / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / "integration-health-degraded-domains.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def format_integration_health_stdout(payload: dict[str, Any], date_str: str) -> str:
    """Produce the scheduled-check stdout block in the exact documented shape."""
    degraded = payload["degraded_entity_domains"]
    scanned = payload["scanned_domains"]
    lines = [f"ha-integration-health findings — {date_str}"]
    if not degraded:
        lines.append(f"No actionable findings. ({scanned} domains scanned)")
    else:
        lines.append(f"Degraded domains: {len(degraded)}")
        for entry in degraded:
            pct = round(entry["ratio"] * 100, 1)
            lines.append(f"- {entry['domain']}: {entry['unavailable']}/{entry['total']} entities unavailable ({pct}%)")
    return "\n".join(lines)
