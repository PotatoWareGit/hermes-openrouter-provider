# Hermes OpenRouter Provider Routing

A [Hermes Agent](https://github.com/NousResearch/hermes-agent) plugin for picking **which upstream
providers serve each OpenRouter model** — per model, from a desktop UI or from an agent tool.

OpenRouter fronts many upstreams (Anthropic, Google Vertex, Amazon Bedrock, Azure, Together, …).
Its API takes a top-level `provider` object that ranks, whitelists, blacklists or excludes them per
request. Hermes already reads that configuration from `config.yaml`:

```yaml
provider_routing:
  sort: price                      # price | throughput | latency
  only: [anthropic]                # whitelist
  ignore: [together]               # blacklist
  order: [anthropic, google]       # preference order, others remain fallbacks
  require_parameters: true
  data_collection: deny            # allow | deny
  models:
    "openai/gpt-6-astra": {only: [openai]}          # per-model overlay
    "anthropic/claude-fable-5.1": {only: [anthropic], sort: throughput}
```

…but there was no way to *set* the per-model half. Model ids contain dots, so `hermes config set`
reads them as path separators, and the `config.set` RPC has a fixed key allow-list. The official
guidance was literally “edit `config.yaml` directly for these keys”. This plugin closes that gap.

## What it adds

- **Settings ▸ Plugins ▸ Provider Routing** — search OpenRouter's live catalog, tick the upstream
  providers a model may use, choose a per-model sort override, save. Providers are listed with
  their context window and input price per million tokens, grouped by the routing slug.
- **A status-bar chip** showing how many models carry a pin, which opens that page.
- **An agent tool**, `openrouter_provider_routing`, so the same thing works without the UI:

  ```
  openrouter_provider_routing(action="list")
  openrouter_provider_routing(action="providers", model="anthropic/claude-fable-5.1")
  openrouter_provider_routing(action="set", model="openai/gpt-6-astra", only=["openai"])
  openrouter_provider_routing(action="clear", model="openai/gpt-6-astra")
  ```

Changes are written to the active profile's `config.yaml` and apply to the next request. Only what
you set is written: an untouched model inherits the flat defaults, and clearing the last pin removes
the `models` key entirely.

## Install

### From GitHub (unified package)

```bash
hermes plugins install PotatoWareGit/hermes-openrouter-provider
hermes plugins enable hermes-openrouter-provider
```

This installs the agent half (tool + backend). The bundled `desktop/` half is **opt-in**: after
installing, turn it on in **Settings ▸ Plugins** (or Capabilities → Plugins) — otherwise the UI will
not appear. The in-app toggle and the `plugins.enabled` entry are separate gates.

> The desktop app loads the desktop half from `$HERMES_HOME/desktop-plugins/<package>/`, so the
> runtime `id` inside `plugin.js` (`openrouter-provider-picker`) stays what it always was, while the
> folder is named after the repo.

### Manually, as two doors (UI loads immediately)

This is the layout the plugin was developed in. It skips the in-app toggle because a *standalone*
desktop plugin loads enabled by default:

```bash
ID=openrouter-provider-picker
mkdir -p ~/.hermes/plugins/$ID/dashboard ~/.hermes/desktop-plugins/$ID
cp plugin.yaml __init__.py            ~/.hermes/plugins/$ID/
cp dashboard/manifest.json dashboard/plugin_api.py ~/.hermes/plugins/$ID/dashboard/
cp desktop/plugin.js                  ~/.hermes/desktop-plugins/$ID/
hermes plugins enable $ID
```

Then ⌘K → **Reload desktop plugins** if the status-bar chip is not there yet.

The plugin id must match on both sides or the UI's `ctx.rest` calls will miss their backend.

## How it works

```
plugin.yaml                     agent-half manifest (declares the tool)
__init__.py                     register(ctx) -> ctx.register_tool("openrouter_provider_routing", ...)
dashboard/manifest.json         {"name": ..., "api": "plugin_api.py"}
dashboard/plugin_api.py         FastAPI router -> /api/plugins/<id>/...
desktop/plugin.js               desktop UI (plain ESM, loaded uncompiled)
```

The renderer cannot reach `config.yaml` itself: `ctx.files` refuses Hermes' own data directories and
the `config.set` RPC would mangle dotted model ids. So every read and write goes through the plugin's
own backend namespace, which uses the same primitive the gateway's `config.set` saves through:

```python
from hermes_cli.config import atomic_config_replace, get_config_path, read_user_config_raw

doc = read_user_config_raw()                      # the file exactly as written
doc.setdefault("provider_routing", {}).setdefault("models", {})["openai/gpt-6-astra"] = {"only": ["openai"]}
atomic_config_replace(get_config_path(), doc)     # ruamel round-trip: comments preserved,
                                                  # the model id stays ONE literal YAML key
```

### Backend routes

Mounted at `/api/plugins/openrouter-provider-picker/` and reached from the UI with `ctx.rest`:

| Route | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /state` | current flat defaults + every per-model overlay + the config path |
| `GET /models?q=&limit=` | OpenRouter's public model catalog, filtered |
| `GET /providers?model=` | upstream providers for one model, with endpoints and pricing |
| `POST /refresh` | drop the in-process catalog caches |
| `PUT /routing` | write (or, with an empty entry, delete) one `models.<id>` overlay |
| `DELETE /routing?model=` | delete one overlay |
| `PUT /flat` | replace the flat defaults; omitted keys return to OpenRouter's own routing |

Handlers never raise: failures come back as `{"ok": false, "error": "..."}` with HTTP 200. All
OpenRouter calls are unauthenticated public endpoints with short timeouts and an in-process cache —
no API key is needed to browse the catalog.

Note that a bare `curl` of any `/api/*` path returns 401 (the dashboard's auth gate), so a 401 says
nothing about whether the route exists.

## Development

The backend is pure Python with no dependencies beyond what Hermes already ships.

```bash
# the interpreter that has fastapi/yaml is the Hermes install venv, not the bare toolchain python
PY=$(ls -d ~/.hermes/installs/*/environments/*/venv/bin/python3 | head -1)
$PY tests/test_backend_http.py     # all routes over real HTTP semantics
$PY tests/test_tool.py             # the agent-side tool, through its real register() path
```

The UI test renders the **real** `desktop/plugin.js` in jsdom with a stubbed
`@hermes/plugin-sdk`, and drives it with `@testing-library/react` — asserting the exact request
bodies the UI sends:

```bash
cd tests && npm install
node test_desktop_ui.mjs
```

> The two Python tests exercise the real config round-trip, which means they temporarily write to
> your `config.yaml`. Both snapshot the file first and restore it byte-identically in a `finally`
> block, and print whether the restore was exact.

Always finish by asking Hermes to re-read the plugin:

```bash
hermes plugins doctor hermes-openrouter-provider
```

## Publishing it

Three routes, in increasing order of reach. All three need the repo to be **public** first
(Settings ▸ General ▸ Danger Zone ▸ Change visibility).

**1. Direct git install** — works the moment the repo is public, no review, no listing:

```bash
hermes plugins install PotatoWareGit/hermes-openrouter-provider
hermes plugins enable openrouter-provider-picker
```

That is a real, supported install path; people just have to be told the URL.

**2. The plugin catalog** — the actual "publish". Users then find it with `hermes plugins search`
or `hermes plugins browse`, install it by name, and get a page at
`https://hermes-agent.nousresearch.com/docs/plugins/openrouter-provider-picker`. Admission is a
human-reviewed PR against [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent):

1. Fork that repo, add `plugin-catalog/openrouter-provider-picker.yaml` (copy
   [`distribution/catalog-entry.example.yaml`](distribution/catalog-entry.example.yaml)), pinning a
   full 40-character `sha` of this repo.
2. Open the PR with what the plugin does, which surfaces it uses, and the disclosure line — plus a
   screenshot, since it has a UI.
3. Catalog CI clones this repo at the pinned commit and runs `hermes plugins validate --install-deps`.
   It already passes locally (manifest, loadability, declared-vs-actual capabilities, security scan,
   desktop-surface and core-override rules).
4. A maintainer reviews the pinned tree and merges. Later releases are new PRs that bump `sha` and
   `version` together; `hermes plugins update` then moves people to the reviewed commit.

The pin *is* the trust model, so a listed plugin must not self-update (this one doesn't).

**3. PyPI** — only worth it if you want `pip install` as well. Expose an entry point:

```toml
[project.entry-points."hermes_agent.plugins"]
openrouter-provider-picker = "your_package:register"
```

Hermes discovers it but never imports it without the plugin being listed in `plugins.enabled`.

## Scope

OpenRouter only. Nous Portal decides routing centrally per model and rejects caller-supplied
provider preferences, so `provider_routing` is ignored there — Hermes never sends the `provider`
object to Portal.

## License

MIT — see [LICENSE](LICENSE).
