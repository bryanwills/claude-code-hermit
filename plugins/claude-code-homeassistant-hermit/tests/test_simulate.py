from ha_agent_lab.policy import Severity
from ha_agent_lab.simulate import evaluate_yaml_policy, simulate_artifact
from helpers import write_artifact

ARTIFACT_YAML = """
alias: Test
actions:
  - service: light.turn_on
    target:
      entity_id: light.kitchen_counter
  - service: cover.open_cover
    target:
      entity_id: cover.garage_door
""".strip()


ALARM_YAML = """
alias: Disarm
actions:
  - service: alarm_control_panel.alarm_disarm
    target:
      entity_id: alarm_control_panel.home
""".strip()

LOCK_YAML = """
alias: Unlock
actions:
  - service: lock.unlock
    target:
      entity_id: lock.front_door
""".strip()


def test_simulation_reports_missing_and_sensitive_entities(make_ha_root) -> None:
    root = make_ha_root(inventory={
        "entity_index": {
            "light.kitchen_counter": {"entity_id": "light.kitchen_counter", "state": "off"},
        }
    })
    artifact = write_artifact(root, ARTIFACT_YAML, name="artifact.yaml")

    result = simulate_artifact(root, artifact)

    assert not result.is_valid
    assert "cover.garage_door" in result.missing_entities
    assert any("cover.garage_door" in reason for reason in result.blocked_reasons)


def test_simulation_valid_under_ask_mode_with_sensitive_entity(make_ha_root) -> None:
    root = make_ha_root(inventory={
        "entity_index": {
            "alarm_control_panel.home": {"entity_id": "alarm_control_panel.home", "state": "armed_away"},
        }
    })
    (root / ".claude-code-hermit" / "config.json").write_text('{"ha_safety_mode": "ask"}')
    artifact = write_artifact(root, ALARM_YAML, name="disarm.yaml")

    result = simulate_artifact(root, artifact)

    assert result.is_valid
    assert not result.policy_blocked
    assert any("alarm_control_panel.home" in r for r in result.blocked_reasons)


def test_simulation_invalid_under_strict_mode_with_sensitive_entity(make_ha_root) -> None:
    root = make_ha_root(inventory={
        "entity_index": {
            "lock.front_door": {"entity_id": "lock.front_door", "state": "locked"},
        }
    })
    artifact = write_artifact(root, LOCK_YAML, name="unlock.yaml")

    result = simulate_artifact(root, artifact)

    assert not result.is_valid
    assert result.policy_blocked


def test_evaluate_yaml_policy_honors_project_safety_mode(make_ha_config) -> None:
    root = make_ha_config("ask")
    artifact = write_artifact(root, ALARM_YAML, name="disarm.yaml")

    _, _, decision = evaluate_yaml_policy(artifact, root=root)

    assert not decision.blocked
    assert decision.severity == Severity.ASK
