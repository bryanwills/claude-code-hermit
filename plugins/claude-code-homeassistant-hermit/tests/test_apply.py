from pathlib import Path
from unittest.mock import MagicMock, call

import pytest

from ha_agent_lab.apply import remove_config, validate_and_apply
from ha_agent_lab.ha_api import HomeAssistantError, extract_ha_error_message
from helpers import write_artifact

SAFE_YAML = """
alias: Safe automation
actions:
  - service: light.turn_on
    target:
      entity_id: light.living_room
""".strip()

SAFE_YAML_WITH_ID = """
id: my_automation
alias: Safe automation
actions:
  - service: light.turn_on
    target:
      entity_id: light.living_room
""".strip()

SENSITIVE_YAML = """
alias: Unsafe automation
actions:
  - service: lock.lock
    target:
      entity_id: lock.front_door
""".strip()

SENSITIVE_ALARM_YAML = """
id: disarm_home
alias: Disarm
actions:
  - service: alarm_control_panel.alarm_disarm
    target:
      entity_id: alarm_control_panel.home
""".strip()

SCRIPT_YAML = """
id: my_script
alias: Safe script
sequence:
  - delay: "00:00:01"
""".strip()


@pytest.fixture
def safe_root(make_ha_root):
    return make_ha_root()


# --- existing tests (updated) ---

def test_sensitive_yaml_is_blocked_before_network_call(make_ha_root):
    root = make_ha_root(inventory={
        "entity_index": {
            "lock.front_door": {"entity_id": "lock.front_door", "state": "locked"},
        }
    })
    artifact = write_artifact(root, SENSITIVE_YAML)
    client = MagicMock()

    result = validate_and_apply(root, client, artifact)

    assert not result.ok
    client.post.assert_not_called()


def test_config_check_failure_returns_not_ok(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML)
    client = MagicMock()
    client.post.side_effect = HomeAssistantError("connection refused")

    result = validate_and_apply(safe_root, client, artifact)

    assert not result.ok
    assert not result.reload_attempted


def test_valid_yaml_with_reload_calls_reload(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}
    client.get.return_value = {"alias": "Safe automation"}

    result = validate_and_apply(safe_root, client, artifact, reload_domain="automation")

    assert result.ok
    assert result.reload_attempted
    client.post.assert_any_call("/api/services/automation/reload", {})


def test_invalid_reload_domain_is_blocked(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}

    result = validate_and_apply(safe_root, client, artifact, reload_domain="shell_command")

    assert not result.ok
    assert not result.reload_attempted
    assert result.message == "reload-blocked"


def test_valid_yaml_no_reload(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML)
    client = MagicMock()
    client.post.return_value = True

    result = validate_and_apply(safe_root, client, artifact)

    assert result.ok
    assert not result.reload_attempted
    assert not result.creation_attempted


# --- REST push tests ---

def test_pushes_automation_config_via_rest(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML_WITH_ID)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}
    client.get.return_value = {"alias": "Safe automation"}

    result = validate_and_apply(safe_root, client, artifact, reload_domain="automation")

    assert result.ok
    assert result.creation_attempted
    client.post.assert_any_call(
        "/api/config/automation/config/my_automation",
        {"id": "my_automation", "alias": "Safe automation", "actions": [{"service": "light.turn_on", "target": {"entity_id": "light.living_room"}}]},
    )


def test_pushes_script_config_via_rest(safe_root: Path):
    artifact = write_artifact(safe_root, SCRIPT_YAML)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}
    client.get.return_value = {"alias": "Safe script"}

    result = validate_and_apply(safe_root, client, artifact, reload_domain="script")

    assert result.ok
    assert result.creation_attempted
    client.post.assert_any_call(
        "/api/config/script/config/my_script",
        {"id": "my_script", "alias": "Safe script", "sequence": [{"delay": "00:00:01"}]},
    )


def test_id_extracted_from_yaml_id_field(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML_WITH_ID)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}
    client.get.return_value = {"alias": "Safe automation"}

    result = validate_and_apply(safe_root, client, artifact, reload_domain="automation")

    assert result.config_id == "my_automation"
    assert result.creation_ok


def test_id_generated_from_alias_when_no_id(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}
    client.get.return_value = {"alias": "Safe automation"}

    result = validate_and_apply(safe_root, client, artifact, reload_domain="automation")

    assert result.config_id == "Safe_automation"
    assert "derived from alias" in result.message


def test_id_generated_from_stem_when_no_id_no_alias(safe_root: Path):
    yaml_content = "actions:\n  - service: light.turn_on\n    target:\n      entity_id: light.living_room"
    artifact = write_artifact(safe_root, yaml_content, name="my_rule.yaml")
    client = MagicMock()
    client.post.return_value = {"result": "valid"}
    client.get.return_value = {}

    result = validate_and_apply(safe_root, client, artifact, reload_domain="automation")

    assert result.config_id == "my_rule"
    assert "derived from filename" in result.message


def test_skip_push_when_no_reload_domain(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML_WITH_ID)
    client = MagicMock()
    client.post.return_value = True

    result = validate_and_apply(safe_root, client, artifact)

    assert result.ok
    assert not result.creation_attempted
    assert result.config_id is None
    # only the check_config POST, not the config-push POST
    client.post.assert_called_once_with("/api/config/core/check_config", {})


def test_verify_ok_sets_creation_ok_true(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML_WITH_ID)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}
    client.get.return_value = {"alias": "Safe automation"}

    result = validate_and_apply(safe_root, client, artifact, reload_domain="automation")

    assert result.creation_ok


def test_verify_failure_keeps_overall_ok_true(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML_WITH_ID)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}
    client.get.side_effect = HomeAssistantError("GET failed")

    result = validate_and_apply(safe_root, client, artifact, reload_domain="automation")

    assert result.ok
    assert result.creation_attempted
    assert not result.creation_ok


def test_403_yaml_mode_falls_back_with_clear_message(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML_WITH_ID)
    client = MagicMock()
    client.post.side_effect = [
        {"result": "valid"},  # check_config succeeds
        HomeAssistantError("Forbidden", status_code=403),  # config push fails
        {"result": "ok"},  # reload succeeds
    ]

    result = validate_and_apply(safe_root, client, artifact, reload_domain="automation")

    assert result.ok
    assert result.creation_attempted
    assert not result.creation_ok
    assert result.reload_attempted
    assert "YAML mode" in result.message


def test_400_invalid_payload_surfaces_ha_message(safe_root: Path):
    artifact = write_artifact(safe_root, SAFE_YAML_WITH_ID)
    client = MagicMock()
    client.post.side_effect = [
        {"result": "valid"},  # check_config
        HomeAssistantError("Bad request", status_code=400, payload='{"message":"Message malformed: required key not provided @ data[\'triggers\']"}'),
    ]

    result = validate_and_apply(safe_root, client, artifact, reload_domain="automation")

    assert not result.ok
    assert result.creation_attempted
    assert not result.creation_ok
    assert "Message malformed" in result.message


# --- remove_config tests ---

def test_remove_automation_ok(safe_root: Path):
    client = MagicMock()
    client.delete.return_value = {"result": "ok"}

    result = remove_config(safe_root, client, "automation", "my_automation")

    assert result.ok
    assert result.message == "ok"
    client.delete.assert_called_once_with("/api/config/automation/config/my_automation")


def test_remove_script_ok(safe_root: Path):
    client = MagicMock()
    client.delete.return_value = {"result": "ok"}

    result = remove_config(safe_root, client, "script", "my_script")

    assert result.ok
    client.delete.assert_called_once_with("/api/config/script/config/my_script")


def test_remove_returns_400_with_resource_not_found(safe_root: Path):
    client = MagicMock()
    client.delete.side_effect = HomeAssistantError(
        "Home Assistant request failed.", status_code=400,
        payload='{"message":"Resource not found"}',
    )

    result = remove_config(safe_root, client, "automation", "nonexistent_id")

    assert not result.ok
    assert result.message == "Resource not found"


def test_remove_invalid_domain(safe_root: Path):
    client = MagicMock()

    result = remove_config(safe_root, client, "shell_command", "my_id")

    assert not result.ok
    assert "not a configurable domain" in result.message
    client.delete.assert_not_called()


# --- extract_ha_error_message tests ---

def test_extract_ha_error_message_pulls_message_field():
    exc = HomeAssistantError("failed", status_code=400, payload='{"message":"Resource not found"}')
    assert extract_ha_error_message(exc) == "Resource not found"


def test_extract_ha_error_message_falls_back_on_non_json():
    exc = HomeAssistantError("plain error", status_code=500, payload="Internal Server Error")
    assert extract_ha_error_message(exc) == str(exc)


def test_extract_ha_error_message_falls_back_on_no_payload():
    exc = HomeAssistantError("connection refused")
    assert extract_ha_error_message(exc) == str(exc)


# --- ask-mode regression tests ---

def test_apply_proceeds_under_ask_mode_with_sensitive_entity(make_ha_root):
    root = make_ha_root(inventory={
        "entity_index": {
            "alarm_control_panel.home": {"entity_id": "alarm_control_panel.home", "state": "armed_away"},
        }
    })
    (root / ".claude-code-hermit" / "config.json").write_text('{"ha_safety_mode": "ask"}')
    artifact = write_artifact(root, SENSITIVE_ALARM_YAML)
    client = MagicMock()
    client.post.return_value = {"result": "valid"}
    client.get.return_value = {"alias": "Disarm"}

    result = validate_and_apply(root, client, artifact, reload_domain="automation")

    assert result.ok
    client.post.assert_any_call("/api/services/automation/reload", {})
