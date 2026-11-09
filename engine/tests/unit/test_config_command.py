import pytest
from pydantic import ValidationError

from scranton_pipeline.config import ModelConfig


def test_command_config_roundtrip():
    cfg = ModelConfig(provider="command", model="demo", command=["python", "bridge.py"])
    assert ModelConfig.model_validate(cfg.model_dump()) == cfg
    for cfg in (ModelConfig(model="demo"), ModelConfig(provider="scripted", script_path="demo.json")):
        assert ModelConfig.model_validate(cfg.model_dump()) == cfg


@pytest.mark.parametrize("fields", [
    {}, {"command": []}, {"command": [""]}, {"command": ["x\0"]},
    {"command": ["x"] * 33}, {"command": ["x"], "structured_output": "json_schema"},
    {"command": ["x"], "structured_output": "function_calling"},
    {"command": ["x"], "script_path": "script.json"},
])
def test_invalid_command_config(fields):
    with pytest.raises(ValidationError):
        ModelConfig(provider="command", **fields)


@pytest.mark.parametrize("provider", ["scripted", "openai_compatible"])
@pytest.mark.parametrize("command", [[], ["python"]])
def test_command_forbidden_for_other_providers(provider, command):
    with pytest.raises(ValidationError):
        ModelConfig(provider=provider, model="demo", script_path="x" if provider == "scripted" else "", command=command)
