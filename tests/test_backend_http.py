"""Drive every backend route over real HTTP semantics.

WARNING: this exercises the real config.yaml round-trip, so it temporarily
writes provider_routing into your Hermes config. The file is snapshotted first
and restored byte-identically in a `finally` block; the last line printed tells
you whether the restore was exact.

    PY=$(ls -d ~/.hermes/installs/*/environments/*/venv/bin/python3 | head -1)
    $PY tests/test_backend_http.py

The interpreter matters: the Hermes install venv has fastapi/yaml, the bare
~/.hermes/tools/python-*/bin/python3 does not.
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

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

PLUGIN_ID = "openrouter-provider-picker"
_api_file = REPO / "dashboard" / "plugin_api.py"
spec = importlib.util.spec_from_file_location("orpp_api", _api_file)
api = importlib.util.module_from_spec(spec)
sys.modules["orpp_api"] = api
spec.loader.exec_module(api)

app = FastAPI()
app.include_router(api.router, prefix=f"/api/plugins/{PLUGIN_ID}")
client = TestClient(app)
BASE = f"/api/plugins/{PLUGIN_ID}"

cfg = Path(api._config_path())
backup = cfg.read_text()


def show(label, response, keys=None):
    try:
        body = response.json()
    except Exception:
        body = response.text[:200]
    if keys and isinstance(body, dict):
        body = {k: body[k] for k in keys if k in body}
    print(f"[{response.status_code}] {label}: {json.dumps(body)[:420]}")


try:
    show("GET /health", client.get(f"{BASE}/health"))
    show("GET /state", client.get(f"{BASE}/state"))

    show("GET /models?q=claude fable", client.get(f"{BASE}/models", params={"q": "claude fable", "limit": 3}),
         ["ok", "total"])

    r = client.get(f"{BASE}/providers", params={"model": "anthropic/claude-fable-5.2"})
    body = r.json()
    print(f"[{r.status_code}] GET /providers -> {len(body.get('providers', []))} providers:",
          [p["slug"] for p in body.get("providers", [])])

    show("GET /providers (bogus model)", client.get(f"{BASE}/providers", params={"model": "not/a-real-model-xyz"}),
         ["ok", "error"])

    show("PUT /routing (normalises slugs + sort)",
         client.put(f"{BASE}/routing", json={"model": "anthropic/claude-fable-5.2",
                                             "entry": {"only": ["Anthropic", " google-vertex "], "sort": "latency"}}),
         ["ok", "model", "entry", "models"])

    show("PUT /routing (dotted model id)",
         client.put(f"{BASE}/routing", json={"model": "openai/gpt-6-astra", "entry": {"only": ["openai"]}}),
         ["ok", "models"])

    show("PUT /routing (invalid sort -> rejected, nothing written)",
         client.put(f"{BASE}/routing", json={"model": "x/y", "entry": {"sort": "cheapest"}}), ["ok", "error"])

    show("PUT /flat",
         client.put(f"{BASE}/flat", json={"flat": {"sort": "throughput", "data_collection": "deny",
                                                   "require_parameters": True}}), ["ok", "flat"])

    show("GET /state (after writes)", client.get(f"{BASE}/state"), ["flat", "models"])

    print("\n--- config.yaml as written ---")
    lines = cfg.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("provider_routing:"))
    print("\n".join(lines[start:start + 14]))

    show("DELETE /routing", client.delete(f"{BASE}/routing", params={"model": "openai/gpt-6-astra"}), ["ok", "models"])
    show("DELETE /routing (last)", client.delete(f"{BASE}/routing", params={"model": "anthropic/claude-fable-5.2"}),
         ["ok", "models", "flat"])

    r = client.put(f"{BASE}/flat", json={"flat": {}})
    show("PUT /flat (clear all)", r, ["ok", "flat", "models"])
    print("\nprovider_routing block gone after a full clear:",
          not any(line.startswith("provider_routing:") for line in cfg.read_text().splitlines()))

    show("PUT /routing (no payload)", client.put(f"{BASE}/routing", json={}), ["ok", "error"])
    show("PUT /flat (no payload)", client.put(f"{BASE}/flat", json={}), ["ok", "error"])
finally:
    cfg.write_text(backup)
    print("\nconfig.yaml restored byte-identical:", cfg.read_text() == backup)
