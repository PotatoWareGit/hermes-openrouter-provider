"""OpenRouter per-model provider routing — backend for the desktop plugin UI.

Mounted at ``/api/plugins/openrouter-provider-picker/``. Reads and writes the
``provider_routing`` block of the active profile's ``config.yaml`` — the same
keys Hermes' own provider routing reads at request time
(``agent.chat_completion_helpers._provider_preferences_for_agent``):

    provider_routing:
      sort: price
      only: [anthropic]
      ignore: [together]
      order: [anthropic, google]
      require_parameters: true
      data_collection: deny
      models:
        "openai/gpt-6-astra": {only: [openai]}      # per-model overlay
        "anthropic/claude-fable-5.1": {only: [anthropic], sort: throughput}

Why a backend at all: a desktop plugin cannot write Hermes' own config
(``ctx.files`` refuses it, and the ``config.set`` JSON-RPC allow-list has no
``provider_routing`` key). ``hermes config set`` cannot set these either —
model ids contain dots, which it reads as path separators. So the write goes
through the same read → mutate → ``atomic_config_replace`` round-trip the
gateway's own ``config.set`` uses, with the model id kept as a single literal
YAML key.

Every handler is defensive and answers ``{"ok": false, "error": ...}`` with
HTTP 200 — a plugin handler must never raise out to the client.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Optional

from fastapi import APIRouter, Body, Query

log = logging.getLogger(__name__)

router = APIRouter()

OPENROUTER_API = "https://openrouter.ai/api/v1"
HTTP_TIMEOUT = 25.0
USER_AGENT = "hermes-openrouter-provider-picker/1.0"

SORTS = ("price", "throughput", "latency")
LIST_KEYS = ("only", "ignore", "order")
DATA_COLLECTION_VALUES = ("allow", "deny")

_MODELS_TTL = 900.0
_PROVIDERS_TTL = 3600.0
_ENDPOINTS_TTL = 900.0

_cache_lock = threading.Lock()
_cache: dict[Any, tuple[float, Any]] = {}


# ── OpenRouter catalog helpers ───────────────────────────────────────────────

def _fetch_json(url: str) -> Any:
    req = urllib.request.Request(
        url, headers={"Accept": "application/json", "User-Agent": USER_AGENT}
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _cached(key: Any, ttl: float, loader: Callable[[], Any]) -> Any:
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None and now - hit[0] < ttl:
            return hit[1]
    data = loader()
    with _cache_lock:
        _cache[key] = (time.time(), data)
    return data


def _rows(raw: Any) -> list:
    if isinstance(raw, dict):
        raw = raw.get("data")
    return raw if isinstance(raw, list) else []


def _model_catalog() -> list[dict[str, Any]]:
    """``[{id, name, context_length}]`` for every model OpenRouter serves."""

    def load() -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for row in _rows(_fetch_json(f"{OPENROUTER_API}/models")):
            mid = row.get("id") if isinstance(row, dict) else None
            if isinstance(mid, str) and mid:
                out.append({
                    "id": mid,
                    "name": row.get("name") or mid,
                    "context_length": row.get("context_length"),
                })
        out.sort(key=lambda r: r["id"])
        return out

    return _cached("models", _MODELS_TTL, load)


def _provider_display_names() -> dict[str, str]:
    """slug -> human name, from OpenRouter's public provider directory."""

    def load() -> dict[str, str]:
        names: dict[str, str] = {}
        for row in _rows(_fetch_json(f"{OPENROUTER_API}/providers")):
            slug = row.get("slug") if isinstance(row, dict) else None
            if isinstance(slug, str) and slug:
                names[slug] = row.get("name") or slug
        return names

    return _cached("providers", _PROVIDERS_TTL, load)


def _endpoints(model: str) -> dict[str, Any]:
    """Raw ``/models/<id>/endpoints`` document for one model (public, no auth)."""

    def load() -> dict[str, Any]:
        quoted = urllib.parse.quote(model, safe="/:@.")
        raw = _fetch_json(f"{OPENROUTER_API}/models/{quoted}/endpoints")
        data = raw.get("data") if isinstance(raw, dict) else raw
        return data if isinstance(data, dict) else {}

    return _cached(("endpoints", model), _ENDPOINTS_TTL, load)


def _slug_of(endpoint: dict[str, Any]) -> str:
    """Routing slug for one endpoint.

    OpenRouter's endpoint ``tag`` is ``<slug>/<quant>/<tier>`` and its first
    segment is exactly the slug ``provider.only`` / ``ignore`` / ``order``
    take (``anthropic/fast`` -> ``anthropic``, ``google-vertex/global`` ->
    ``google-vertex``). Fall back to the lower-cased display name.
    """
    tag = endpoint.get("tag")
    if isinstance(tag, str) and tag.strip():
        head = tag.split("/", 1)[0].strip()
        if head:
            return head
    name = endpoint.get("provider_name")
    if isinstance(name, str) and name.strip():
        return name.strip().lower()
    return ""


def _pricing_of(endpoint: dict[str, Any]) -> Optional[dict[str, Any]]:
    pricing = endpoint.get("pricing")
    if not isinstance(pricing, dict):
        return None
    out: dict[str, Any] = {}
    for key in ("prompt", "completion"):
        try:
            value = float(pricing.get(key))
        except (TypeError, ValueError):
            continue
        out[key] = value
    return out or None


def providers_for_model(model: str) -> dict[str, Any]:
    """Group a model's endpoints by provider slug, priced and deduped."""
    document = _endpoints(model)
    names = {}
    try:
        names = _provider_display_names()
    except Exception:
        pass

    grouped: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for endpoint in document.get("endpoints") or []:
        if not isinstance(endpoint, dict):
            continue
        slug = _slug_of(endpoint)
        if not slug:
            continue
        row = grouped.get(slug)
        if row is None:
            row = {
                "slug": slug,
                "name": names.get(slug) or endpoint.get("provider_name") or slug,
                "context_length": None,
                "endpoints": [],
            }
            grouped[slug] = row
            order.append(slug)
        ctx_len = endpoint.get("context_length")
        if isinstance(ctx_len, int) and (row["context_length"] is None or ctx_len < row["context_length"]):
            row["context_length"] = ctx_len
        row["endpoints"].append({
            "tag": endpoint.get("tag") or "",
            "context_length": ctx_len,
            "quantization": endpoint.get("quantization"),
            "service_tier": endpoint.get("service_tier"),
            "pricing": _pricing_of(endpoint),
            "status": endpoint.get("status"),
            "uptime_last_30m": endpoint.get("uptime_last_30m"),
        })

    providers = [grouped[slug] for slug in order]
    for row in providers:
        prices = [
            e["pricing"]["prompt"]
            for e in row["endpoints"]
            if isinstance(e.get("pricing"), dict) and "prompt" in e["pricing"]
        ]
        row["min_prompt_price"] = min(prices) if prices else None

    return {
        "model": model,
        "model_name": document.get("name") or model,
        "providers": providers,
    }


# ── config.yaml round-trip ───────────────────────────────────────────────────

def _config_path():
    from hermes_cli.config import get_config_path

    return get_config_path()


def _read_raw() -> dict[str, Any]:
    from hermes_cli.config import read_user_config_raw

    doc = read_user_config_raw()
    return doc if isinstance(doc, dict) else {}


def _write_raw(doc: dict[str, Any]) -> None:
    """Same primitive the gateway's own ``config.set`` saves through:

    read raw -> mutate -> comment-preserving atomic replace."""
    from hermes_cli.config import atomic_config_replace, get_config_path

    atomic_config_replace(get_config_path(), doc)


def _routing_block(doc: dict[str, Any]) -> dict[str, Any]:
    block = doc.get("provider_routing")
    return block if isinstance(block, dict) else {}


def _clean_list(value: Any, key: str) -> Optional[list[str]]:
    if value in (None, "", []):
        return None
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        raise ValueError(f"{key} must be a list of provider slugs")
    seen: list[str] = []
    for item in value:
        if not isinstance(item, (str, int)):
            raise ValueError(f"{key} must contain provider slugs")
        slug = str(item).strip().lower()
        if slug and slug not in seen:
            seen.append(slug)
    return seen or None


def clean_entry(raw: Any) -> dict[str, Any]:
    """Validate one routing entry, keeping only recognized keys."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("routing entry must be an object")
    out: dict[str, Any] = {}
    for key, value in raw.items():
        if key in LIST_KEYS:
            cleaned = _clean_list(value, key)
            if cleaned:
                out[key] = cleaned
        elif key == "sort":
            if value in (None, "", "none", "inherit"):
                continue
            value = str(value).strip().lower()
            if value not in SORTS:
                raise ValueError(f"sort must be one of {', '.join(SORTS)}")
            out[key] = value
        elif key == "require_parameters":
            if value in (None, False, "", "false", "0"):
                continue
            out[key] = True
        elif key == "data_collection":
            if value in (None, "", "inherit"):
                continue
            value = str(value).strip().lower()
            if value not in DATA_COLLECTION_VALUES:
                raise ValueError("data_collection must be 'allow' or 'deny'")
            out[key] = value
        else:
            raise ValueError(f"unknown provider-routing key: {key}")
    return out


def _state() -> dict[str, Any]:
    doc = _read_raw()
    block = _routing_block(doc)
    flat = {key: block[key] for key in (*LIST_KEYS, "sort", "require_parameters", "data_collection") if key in block}
    models = block.get("models")
    models = {str(k): v for k, v in models.items() if isinstance(v, dict)} if isinstance(models, dict) else {}
    return {
        "flat": flat,
        "models": models,
        "sorts": list(SORTS),
        "config_path": str(_config_path()),
    }


# ── routes ───────────────────────────────────────────────────────────────────

def _fail(message: str, *, status: int = 200, **extra: Any) -> dict[str, Any]:
    return {"ok": False, "error": message, **extra}


@router.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "plugin": "openrouter-provider-picker", "version": "1.0.0"}


@router.get("/state")
async def get_state() -> dict[str, Any]:
    """Current ``provider_routing`` block: flat defaults + per-model overlays."""
    try:
        return {"ok": True, **_state()}
    except Exception as exc:  # never raise out of a plugin handler
        log.warning("openrouter-provider-picker: state read failed: %s", exc)
        return _fail(f"could not read config.yaml: {exc}")


@router.get("/models")
async def list_models(
    q: str = Query("", description="substring filter over model id and name"),
    limit: int = Query(60, ge=1, le=500),
) -> dict[str, Any]:
    """OpenRouter's public model catalog, optionally filtered."""
    try:
        catalog = _model_catalog()
    except urllib.error.HTTPError as exc:
        return _fail(f"OpenRouter catalog error: HTTP {exc.code}")
    except Exception as exc:
        return _fail(f"OpenRouter catalog unreachable: {exc}")

    needle = q.strip().lower()
    if needle:
        terms = [t for t in needle.split() if t]
        catalog = [
            row for row in catalog
            if all(t in row["id"].lower() or t in row["name"].lower() for t in terms)
        ]
    return {"ok": True, "total": len(catalog), "models": catalog[:limit]}


@router.get("/providers")
async def list_providers(model: str = Query(..., min_length=1)) -> dict[str, Any]:
    """Upstream providers serving *model*, with their endpoints and pricing."""
    try:
        payload = providers_for_model(model.strip())
    except urllib.error.HTTPError as exc:
        return _fail(f"OpenRouter has no endpoints for {model} (HTTP {exc.code})")
    except Exception as exc:
        return _fail(f"could not load endpoints for {model}: {exc}")
    try:
        pinned = _routing_block(_read_raw()).get("models")
        entry = pinned.get(model.strip()) if isinstance(pinned, dict) else None
    except Exception:
        entry = None
    return {"ok": True, "entry": entry if isinstance(entry, dict) else {}, **payload}


@router.post("/refresh")
async def refresh_catalog() -> dict[str, Any]:
    """Drop the in-process OpenRouter caches."""
    with _cache_lock:
        _cache.clear()
    return {"ok": True}


@router.put("/routing")
async def set_model_routing(payload: dict = Body(...)) -> dict[str, Any]:
    """Write (or clear) the ``provider_routing.models.<model>`` overlay.

    An entry that validates to nothing deletes the key, so "inherits the
    defaults" is expressed by absence rather than an empty mapping.
    """
    model = str(payload.get("model") or "").strip()
    if not model:
        return _fail("model is required")
    try:
        entry = clean_entry(payload.get("entry"))
    except ValueError as exc:
        return _fail(str(exc))

    try:
        doc = _read_raw()
        block = doc.get("provider_routing")
        if not isinstance(block, dict):
            block = {}
        models = block.get("models")
        if not isinstance(models, dict):
            models = {}
        if entry:
            models[model] = entry
        else:
            models.pop(model, None)
        if models:
            block["models"] = models
        else:
            block.pop("models", None)
        if block:
            doc["provider_routing"] = block
        else:
            doc.pop("provider_routing", None)
        _write_raw(doc)
    except Exception as exc:
        log.warning("openrouter-provider-picker: routing write failed: %s", exc)
        return _fail(f"could not write config.yaml: {exc}")

    log.info("openrouter-provider-picker: provider_routing.models.%s = %r", model, entry)
    return {"ok": True, "model": model, "entry": entry, **_state()}


@router.delete("/routing")
async def delete_model_routing(model: str = Query(..., min_length=1)) -> dict[str, Any]:
    """Remove one model's overlay."""
    return await set_model_routing({"model": model, "entry": {}})


@router.put("/flat")
async def set_flat_routing(payload: dict = Body(...)) -> dict[str, Any]:
    """Replace the flat defaults.

    Recognized keys are the six routing knobs; a value of ``None``/empty
    removes that key so it falls back to OpenRouter's own default routing.
    """
    raw = payload.get("flat")
    if raw is None:
        raw = payload
    if not isinstance(raw, dict):
        return _fail("flat must be an object")
    try:
        cleaned = clean_entry(raw)
    except ValueError as exc:
        return _fail(str(exc))

    try:
        doc = _read_raw()
        block = doc.get("provider_routing")
        if not isinstance(block, dict):
            block = {}
        models = block.get("models")
        for key in (*LIST_KEYS, "sort", "require_parameters", "data_collection"):
            block.pop(key, None)
        block.update(cleaned)
        if isinstance(models, dict) and models:
            block["models"] = models
        else:
            block.pop("models", None)
        if block:
            doc["provider_routing"] = block
        else:
            doc.pop("provider_routing", None)
        _write_raw(doc)
    except Exception as exc:
        log.warning("openrouter-provider-picker: flat write failed: %s", exc)
        return _fail(f"could not write config.yaml: {exc}")

    log.info("openrouter-provider-picker: flat provider_routing = %r", cleaned)
    return {"ok": True, "flat": cleaned, **_state()}
