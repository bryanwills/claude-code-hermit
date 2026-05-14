"""Tests that refresh-context paths attach silence_summary to the normalized snapshot."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from ha_agent_lab.cli import main


def _mock_states() -> list[dict]:
    return [
        {"entity_id": "light.living_room", "state": "off", "attributes": {}, "last_changed": "2026-05-14T10:00:00+00:00", "last_updated": "2026-05-14T10:00:00+00:00"},
    ]


def _mock_ha_payloads() -> tuple:
    return (
        {"message": "API running."},
        {"location_name": "Home"},
        ["homeassistant"],
        [{"domain": "light", "services": {"turn_on": {}, "turn_off": {}}}],
        _mock_states(),
    )


def test_refresh_context_writes_silence_summary(make_mock_config, capsys) -> None:
    cfg = make_mock_config()

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.base_url_source = "single"
        instance.get.side_effect = list(_mock_ha_payloads())
        result = main(["ha", "refresh-context"])

    assert result == 0
    normalized_path = cfg.root / ".claude-code-hermit" / "raw" / "snapshot-ha-normalized-latest.json"
    assert normalized_path.exists()
    normalized = json.loads(normalized_path.read_text())
    assert "silence_summary" in normalized
    ss = normalized["silence_summary"]
    assert "computed_at" in ss
    assert "dead_automations" in ss
    assert "silent_event_sensors" in ss


def test_refresh_context_incremental_writes_silence_summary_on_no_diff_run(make_mock_config, capsys) -> None:
    cfg = make_mock_config()

    # Seed a baseline snapshot
    raw = cfg.root / ".claude-code-hermit" / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    baseline = {
        "entity_index": {"light.living_room": {"state": "off", "last_changed": "2026-05-14T10:00:00+00:00", "attributes": {}}},
        "service_index": {},
        "components": [],
        "unavailable_entities": [],
    }
    (raw / "snapshot-ha-normalized-latest.json").write_text(json.dumps(baseline), encoding="utf-8")

    with patch("ha_agent_lab.cli.load_config", return_value=cfg), \
         patch("ha_agent_lab.cli.HomeAssistantClient") as MockClient:
        instance = MockClient.return_value
        instance.base_url_source = "single"
        # Return the same states — no diff
        instance.get.return_value = _mock_states()
        result = main(["ha", "refresh-context", "--incremental"])

    assert result == 0
    normalized = json.loads((raw / "snapshot-ha-normalized-latest.json").read_text())
    assert "silence_summary" in normalized
    assert "computed_at" in normalized["silence_summary"]
