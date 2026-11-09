from pathlib import Path

import pytest

from scranton_pipeline.config import load_config


@pytest.mark.parametrize("path", sorted(Path("examples").glob("config.*.json")))
def test_example_config(path):
    cfg = load_config(path)
    assert cfg.models.planner.provider == ("command" if path.name == "config.command.json" else "openai_compatible")
