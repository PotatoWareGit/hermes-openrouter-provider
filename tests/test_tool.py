"""Exercise the agent-side tool through the plugin's real register() path.

Same config.yaml caveat as test_backend_http.py: it snapshots and restores.

    PY=$(ls -d ~/.hermes/installs/*/environments/*/venv/bin/python3 | head -1)
    $PY tests/test_tool.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
AGENT_DIR = Path(os.environ.get("HERMES_AGENT_DIR", Path.home() / ".hermes" / "hermes-agent"))
HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))

sys.path.insert(0, str(AGENT_DIR))
os.environ.setdefault("HERMES_HOME", str(HERMES_HOME))

spec = importlib.util.spec_from_file_location("hermes_plugin_openrouter_provider_picker", REPO / "__init__.py")
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

captured: dict = {}


class Ctx:
    """Stand-in for the plugin context: captures the tool registration."""

    def register_tool(self, **kwargs):
        captured.update(kwargs)


from hermes_cli.config import get_config_path  # noqa: E402

config_file = get_config_path()
backup = config_file.read_text()

try:
    mod.register(Ctx())
    assert captured.get("name") == "openrouter_provider_routing", captured.get("name")
    print("registered tool:", captured["name"], "| toolset:", captured["toolset"])
    print("schema is JSON-serialisable:", bool(json.dumps(captured["schema"])))
    handler = captured["handler"]

    def call(label, **kwargs):
        out = json.loads(handler(**kwargs))
        print(f"\n--- {label} -> ok={out.get('ok')}")
        if out.get("ok"):
            for key in ("models", "flat"):
                if out.get(key) is not None:
                    print(f"    {key}:", json.dumps(out[key]))
            if out.get("providers") is not None:
                print("    providers:", [p["slug"] for p in out["providers"]])
        else:
            print("    error:", out.get("error"))
        return out

    call("list (empty)", action="list")
    call("providers for a real model", action="providers", model="openai/gpt-6-astra")
    call("set only=[OpenAI] (slug normalised)", action="set", model="openai/gpt-6-astra", only=["OpenAI", " openai "])
    call("set sort+data_collection", action="set", model="openai/gpt-6-astra", sort="THROUGHPUT", data_collection="deny")
    call("list (after set)", action="list")
    call("set flat defaults", action="set", apply_to="flat", sort="price", require_parameters=True)
    call("list (flat + model)", action="list")
    call("bad sort rejected", action="set", model="x/y", sort="cheapest")
    call("no-op set rejected", action="set", model="x/y")
    call("set without model rejected", action="set", only=["openai"])
    call("unknown action", action="explode")
    call("clear one model", action="clear", model="openai/gpt-6-astra")
    call("clear the flat defaults", action="clear", apply_to="flat")
    call("list (all clear)", action="list")

    print("\nprovider_routing block gone after a full clear:",
          not any(line.startswith("provider_routing:") for line in config_file.read_text().splitlines()))
finally:
    config_file.write_text(backup)
    print("\nconfig.yaml restored byte-identical:", config_file.read_text() == backup)
