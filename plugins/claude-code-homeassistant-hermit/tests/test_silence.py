import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from ha_agent_lab.silence import _days_since, _parse_iso, compute_silence_summary


NOW = datetime(2026, 5, 14, 12, 0, 0, tzinfo=UTC)


def _entity(entity_id: str, state: str = "on", last_changed: str | None = None, attrs: dict | None = None) -> dict:
    domain = entity_id.split(".", 1)[0]
    lc = last_changed or "2026-05-14T12:00:00+00:00"
    return {entity_id: {"state": state, "last_changed": lc, "attributes": attrs or {}}}


def _normalized(entity_index: dict, unavailable: list[str] | None = None) -> dict:
    return {"entity_index": entity_index, "unavailable_entities": unavailable or []}


def _root_with_artifact(tmp_path: Path, degraded_domains: list[str]) -> Path:
    state = tmp_path / ".claude-code-hermit" / "state"
    state.mkdir(parents=True)
    artifact = {"degraded_entity_domains": [{"domain": d} for d in degraded_domains]}
    (state / "integration-health-degraded-domains.json").write_text(json.dumps(artifact), encoding="utf-8")
    return tmp_path


# --- _parse_iso ---

def test_parse_iso_handles_z_suffix():
    dt = _parse_iso("2026-05-14T12:00:00Z")
    assert dt is not None
    assert dt.utcoffset().total_seconds() == 0


def test_parse_iso_returns_none_on_malformed():
    assert _parse_iso("not-a-date") is None
    assert _parse_iso(None) is None
    assert _parse_iso("") is None


# --- _days_since ---

def test_days_since_returns_none_when_then_is_none():
    assert _days_since(NOW, None) is None


def test_days_since_computes_integer_days():
    then = NOW - timedelta(days=3, hours=6)
    assert _days_since(NOW, then) == 3


# --- dead automations ---

def test_dead_automation_when_enabled_and_last_triggered_older_than_threshold(tmp_path):
    old = (NOW - timedelta(days=45)).isoformat()
    idx = _entity("automation.lights", state="on", last_changed=old, attrs={"last_triggered": old})
    result = compute_silence_summary(_normalized(idx), tmp_path, now=NOW)
    assert any(e["entity_id"] == "automation.lights" for e in result["dead_automations"])


def test_dead_automation_when_enabled_and_last_triggered_null(tmp_path):
    idx = _entity("automation.lights", state="on", attrs={"last_triggered": None})
    result = compute_silence_summary(_normalized(idx), tmp_path, now=NOW)
    dead = result["dead_automations"]
    assert len(dead) == 1
    assert dead[0]["never_fired"] is True
    assert dead[0]["days_silent"] is None


def test_disabled_automation_dropped_silently_not_dead(tmp_path):
    idx = _entity("automation.lights", state="off", attrs={"last_triggered": None})
    result = compute_silence_summary(_normalized(idx), tmp_path, now=NOW)
    assert result["dead_automations"] == []


def test_recently_triggered_automation_not_dead(tmp_path):
    recent = (NOW - timedelta(days=2)).isoformat()
    idx = _entity("automation.lights", state="on", attrs={"last_triggered": recent})
    result = compute_silence_summary(_normalized(idx), tmp_path, now=NOW)
    assert result["dead_automations"] == []


# --- silent event sensors ---

def test_silent_event_sensor_detects_motion_device_class(tmp_path):
    old = (NOW - timedelta(days=14)).isoformat()
    idx = _entity("binary_sensor.front_door", state="off", last_changed=old, attrs={"device_class": "door"})
    result = compute_silence_summary(_normalized(idx), tmp_path, now=NOW)
    sensors = result["silent_event_sensors"]
    assert len(sensors) == 1
    assert sensors[0]["device_class"] == "door"


def test_silent_event_sensor_ignores_battery_device_class(tmp_path):
    old = (NOW - timedelta(days=14)).isoformat()
    idx = _entity("binary_sensor.sensor_battery", state="off", last_changed=old, attrs={"device_class": "battery"})
    result = compute_silence_summary(_normalized(idx), tmp_path, now=NOW)
    assert result["silent_event_sensors"] == []


def test_recently_changed_event_sensor_not_silent(tmp_path):
    recent = (NOW - timedelta(days=1)).isoformat()
    idx = _entity("binary_sensor.motion", state="off", last_changed=recent, attrs={"device_class": "motion"})
    result = compute_silence_summary(_normalized(idx), tmp_path, now=NOW)
    assert result["silent_event_sensors"] == []


# --- inactive candidates ---

def test_inactive_candidates_routed_to_per_domain_bucket_only(tmp_path):
    old = (NOW - timedelta(days=31)).isoformat()
    idx = _entity("light.guest_room", state="off", last_changed=old)
    result = compute_silence_summary(_normalized(idx), tmp_path, now=NOW)
    assert result["silent_event_sensors"] == []
    assert result["dead_automations"] == []
    assert len(result["inactive_candidates_by_domain"]["light"]) == 1


# --- long unavailable / suppression ---

def test_long_unavailable_skips_domains_listed_in_state_artifact(tmp_path):
    old = (NOW - timedelta(days=9)).isoformat()
    idx = {"sensor.outdoor_temp": {"state": "unavailable", "last_changed": old, "attributes": {}}}
    root = _root_with_artifact(tmp_path, ["sensor"])
    result = compute_silence_summary(_normalized(idx, ["sensor.outdoor_temp"]), root, now=NOW)
    assert result["long_unavailable"] == []
    assert "sensor" in result["suppressed_entity_domains"]


def test_long_unavailable_unfiltered_when_state_artifact_missing(tmp_path):
    old = (NOW - timedelta(days=9)).isoformat()
    idx = {"sensor.outdoor_temp": {"state": "unavailable", "last_changed": old, "attributes": {}}}
    result = compute_silence_summary(_normalized(idx, ["sensor.outdoor_temp"]), tmp_path, now=NOW)
    assert len(result["long_unavailable"]) == 1
    assert result["suppressed_entity_domains"] == []


def test_long_unavailable_only_includes_entities_past_threshold(tmp_path):
    recent = (NOW - timedelta(days=2)).isoformat()
    idx = {"sensor.temp": {"state": "unavailable", "last_changed": recent, "attributes": {}}}
    result = compute_silence_summary(_normalized(idx, ["sensor.temp"]), tmp_path, now=NOW)
    assert result["long_unavailable"] == []


# --- sort order ---

def test_silence_summary_deterministic_sort_order(tmp_path):
    old_a = (NOW - timedelta(days=45)).isoformat()
    old_b = (NOW - timedelta(days=10)).isoformat()
    idx = {
        **_entity("automation.b", state="on", last_changed=old_b, attrs={"last_triggered": old_b}),
        **_entity("automation.a", state="on", last_changed=old_a, attrs={"last_triggered": old_a}),
    }
    result1 = compute_silence_summary(_normalized(idx), tmp_path, now=NOW)
    result2 = compute_silence_summary(_normalized(idx), tmp_path, now=NOW)
    assert result1["dead_automations"] == result2["dead_automations"]
    assert result1["dead_automations"][0]["entity_id"] == "automation.a"
