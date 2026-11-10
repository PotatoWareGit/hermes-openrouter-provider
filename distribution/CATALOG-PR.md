# Catalog PR — copy/paste reference

**Branch:** `add-openrouter-provider-picker`
**File added:** `plugin-catalog/openrouter-provider-picker.yaml`
**Entry name:** `openrouter-provider-picker` · **Pin:** `a4b57418793b8a4f7fc2200a2d0779ebdca8ae1d` · **Version:** 1.0.0

---

## PR title

```
Add openrouter-provider-picker to the catalog
```

## PR body

### What it does

Sets which upstream providers serve each OpenRouter model. Hermes already reads
`provider_routing` / `provider_routing.models.<id>` and sends it as OpenRouter's `provider`
request field, but had no way to write the per-model half: model ids contain dots, so
`hermes config set` reads them as path separators, and the `config.set` RPC has a fixed
allow-list. The documented advice was to edit `config.yaml` by hand.

This plugin adds:

- a desktop UI (Settings ▸ Plugins ▸ Provider Routing) that searches OpenRouter's live model
  catalog, lists the real upstream providers for the chosen model with context window and
  input price per million tokens, and writes an allowlist, a denylist or a per-model sort
  override;
- a status-bar chip showing how many models are pinned, deep-linking to that page;
- one agent tool, `openrouter_provider_routing` (`list` / `providers` / `set` / `clear`),
  sharing the backend's validation.

### Surfaces used

- Desktop plugin SDK: `ctx.registerSettingsPage`, a `statusBar.right` contribution,
  `ctx.rest`, `ctx.i18n`, `ctx.os.revealPath`. No DOM reaching, no `window.hermesDesktop`,
  no `eval`, no `import()` beyond `@hermes/plugin-sdk` / `react`.
- `ctx.register_tool` for the single tool.
- A `dashboard/plugin_api.py` FastAPI router mounted at `/api/plugins/<id>/`.
- Config access through `hermes_cli.config.read_user_config_raw` / `atomic_config_replace`
  (the same round-trip the gateway's own `config.set` saves through), so ruamel comments
  survive and a dotted model id stays one literal YAML key.

### Disclosure

- **Network:** calls the public, unauthenticated `openrouter.ai` API (`/api/v1/models` and
  `/api/v1/models/<id>/endpoints`) to build the model and provider lists. Responses are
  cached in-process (15 min for models/endpoints, 60 min for provider names), refreshed on
  demand. No other third party, no telemetry, no usage reporting, no self-update.
- **Local writes:** reads and rewrites the active profile's `config.yaml` — only the
  `provider_routing` block, via the comment-preserving atomic replace.
- **Credentials:** none. It needs no API key, stores none, and reads no credential store.
- **Scope:** OpenRouter only. Nous Portal ignores caller-supplied routing, so the plugin is
  inert there.

### Validation

`hermes plugins validate <checkout> --install-deps` at the pinned SHA:

```
✓ manifest, manifest fields, requires_hermes '>=0.23.0', config schema, requires_env, oauth
✓ loadable — entry: __init__.py, desktop/plugin.js
✓ python dependencies — none declared
✓ capability probe, declared tools/hooks/middleware — match registrations
✓ built-in tool collisions — none
✓ security scan — safe
✓ no core override
✓ desktop surface — stays inside the plugin SDK surface
Validation passed.
```

Install path verified end-to-end from the public repo in a throwaway `HERMES_HOME`:
clone → checkout at the pin → `plugins doctor` OK, 1 tool registered.
