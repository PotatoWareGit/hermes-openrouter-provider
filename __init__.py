"""openrouter-provider-picker — agent half.

Registers one tool so the agent can inspect and change OpenRouter provider
routing without the desktop UI:

    openrouter_provider_routing(action="list")
    openrouter_provider_routing(action="providers", model="anthropic/claude-fable-5.1")
    openrouter_provider_routing(action="set", model="openai/gpt-6-astra", only=["openai"])
    openrouter_provider_routing(action="clear", model="openai/gpt-6-astra")

The rules live in ``dashboard/plugin_api.py`` (the desktop UI's backend) and are
loaded from there so the two surfaces cannot drift. That module imports FastAPI,
which ships with Hermes' dashboard — if it is unavailable the tool registers
nothing rather than breaking the session.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

_API_FILE = Path(__file__).resolve().parent / "dashboard" / "plugin_api.py"
_api: Any = None


def _backend() -> Any:
    """Load ``dashboard/plugin_api.py`` by path, once per process."""
    global _api
    if _api is not None:
        return _api
    name = "hermes_openrouter_provider_picker_api"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, _API_FILE)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {_API_FILE}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    _api = module
    return module


TOOL_SCHEMA = {
    "name": "openrouter_provider_routing",
    "description": (
        "Read or change OpenRouter provider routing for the active profile. This is the "
        "config.yaml `provider_routing` block that Hermes sends as the OpenRouter "
        "`provider` request field: which upstream providers may serve a model, how they "
        "are ranked, and privacy parameters. `models.<id>` entries override the flat "
        "defaults for one model only (spelling-tolerant).\n"
        "\n"
        "actions:\n"
        "  list      — current flat defaults + every per-model override\n"
        "  providers — which upstream providers serve one model (live from OpenRouter)\n"
        "  set       — write an override for one model; omit a key to leave it inheriting\n"
        "  clear     — delete one model's override\n"
        "A per-model override takes effect on the next request, even in a chat that is already "
        "running: Hermes re-reads the models block per request. Flat defaults are baked into a "
        "session when it is constructed, so they apply from the next new session, not the current "
        "chat. Pass apply_to='flat' only for that wider change."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["list", "providers", "set", "clear"]},
            "model": {
                "type": "string",
                "description": "OpenRouter model id, e.g. 'anthropic/claude-fable-5.1' (set/clear/providers).",
            },
            "only": {"type": "array", "items": {"type": "string"}, "description": "Allowlist of provider slugs."},
            "ignore": {"type": "array", "items": {"type": "string"}, "description": "Denylist of provider slugs."},
            "order": {"type": "array", "items": {"type": "string"}, "description": "Preferred provider slugs, in order."},
            "sort": {"type": "string", "enum": ["price", "throughput", "latency"]},
            "require_parameters": {"type": "boolean"},
            "data_collection": {"type": "string", "enum": ["allow", "deny"]},
            "apply_to": {
                "type": "string",
                "enum": ["model", "flat"],
                "description": "For 'set': 'model' (default) writes models.<id>; 'flat' rewrites the global defaults.",
            },
        },
        "required": ["action"],
    },
}


def _handle(action: str = "", model: str = "", apply_to: str = "model", **kwargs: Any) -> str:
    try:
        api = _backend()
        action = (action or "").strip().lower()
        model = (model or "").strip()

        if action == "list":
            return json.dumps({"ok": True, **api._state()}, indent=2)

        if action == "providers":
            if not model:
                return json.dumps({"ok": False, "error": "model is required"})
            result = api.providers_for_model(model)
            return json.dumps({
                "ok": True,
                "model": model,
                "providers": [
                    {
                        "slug": row["slug"],
                        "name": row["name"],
                        "context_length": row["context_length"],
                        "endpoints": len(row["endpoints"]),
                        "min_prompt_price_per_million": (
                            round(row["min_prompt_price"] * 1e6, 4) if row.get("min_prompt_price") else None
                        ),
                    }
                    for row in result["providers"]
                ],
            }, indent=2)

        if action in ("set", "clear"):
            to_flat = apply_to == "flat"
            if not to_flat and not model:
                return json.dumps({"ok": False, "error": "model is required for a per-model set/clear"})
            if action == "clear":
                entry: dict[str, Any] = {}
            else:
                entry = api.clean_entry({k: v for k, v in kwargs.items() if v is not None})
            if action == "set" and not entry:
                return json.dumps({
                    "ok": False,
                    "error": "nothing to set — pass at least one of only/ignore/order/sort/require_parameters/data_collection",
                })

            doc = api._read_raw()
            block = doc.get("provider_routing")
            if not isinstance(block, dict):
                block = {}
            models = block.get("models")
            if not isinstance(models, dict):
                models = {}

            if to_flat:
                # The flat defaults: a clear drops every routing knob, a set
                # replaces them (an unpassed key returns to OpenRouter's own
                # default routing rather than lingering from the last value).
                for key in (*api.LIST_KEYS, "sort", "require_parameters", "data_collection"):
                    block.pop(key, None)
                block.update(entry)
            elif action == "clear":
                models.pop(model, None)
            else:
                models[model] = entry

            if models:
                block["models"] = models
            else:
                block.pop("models", None)
            if block:
                doc["provider_routing"] = block
            else:
                doc.pop("provider_routing", None)
            api._write_raw(doc)
            logger.info("openrouter-provider-picker: %s %s -> %r", action, model if apply_to == "model" else "flat", entry)
            return json.dumps({"ok": True, "action": action, "model": model, "entry": entry, **api._state()}, indent=2)

        return json.dumps({"ok": False, "error": f"unknown action {action!r}"})
    except ValueError as exc:
        return json.dumps({"ok": False, "error": str(exc)})
    except Exception as exc:  # a tool must never raise into the turn
        logger.warning("openrouter-provider-picker tool failed: %s", exc)
        return json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def register(ctx) -> None:
    """Register the routing tool. No-op if the shared backend cannot be loaded."""
    try:
        _backend()
    except Exception as exc:
        logger.warning("openrouter-provider-picker: backend unavailable, tool not registered: %s", exc)
        return

    def handler(**_kwargs: Any) -> str:
        return _handle(**_kwargs)

    ctx.register_tool(
        name="openrouter_provider_routing",
        toolset="openrouter_provider_routing",
        schema=TOOL_SCHEMA,
        handler=handler,
        description="Read or change OpenRouter per-model provider routing in config.yaml.",
        emoji="🛰️",
    )
    logger.info("openrouter-provider-picker: registered openrouter_provider_routing")
