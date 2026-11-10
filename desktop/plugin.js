/**
 * OpenRouter per-model provider routing — desktop UI.
 *
 * Adds Settings ▸ Plugins ▸ Provider Routing and a status-bar chip showing how
 * many models carry a pin. Reads and writes through the package's
 * `dashboard/plugin_api.py` (`ctx.rest`), which owns the config.yaml
 * round-trip and the OpenRouter catalog.
 *
 * Plain ESM, loaded uncompiled — UI is jsx() calls, not JSX syntax.
 * Only these imports resolve: @hermes/plugin-sdk, react, react/jsx-runtime.
 */

import {
  Badge, Button, EmptyState, ErrorState, GlyphSpinner, Separator, Switch,
  SearchField, SegmentedControl, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Tip, cn, haptic, host, icons, pluginSettingsHref, usePluginI18n, useQuery, useQueryClient
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'openrouter-provider-picker'

const EN = {
  title: 'Provider Routing',
  subtitle: 'Choose which upstream providers serve each OpenRouter model.',
  docs: 'How routing works',
  flatTitle: 'Defaults for every model',
  flatHint: 'Left on “OpenRouter default”, routing stays the aggregator’s own choice.',
  flatTiming: 'Flat defaults apply from your next session — a running chat keeps the routing it started with. Per-model pins apply immediately.',
  sort: 'Rank providers by',
  sortDefault: 'OpenRouter default',
  sortPrice: 'Price',
  sortThroughput: 'Throughput',
  sortLatency: 'Latency',
  dataCollection: 'Data collection',
  dataDefault: 'OpenRouter default',
  dataAllow: 'Allow',
  dataDeny: 'Deny',
  requireParameters: 'Only providers that support every request parameter',
  save: 'Save defaults',
  saved: 'Saved',
  reset: 'Clear defaults',
  pinsTitle: 'Per-model pins',
  pinsHint: 'A pin overrides the defaults for one model only. Models without a pin inherit them.',
  pickModel: 'Find a model…',
  pickHint: 'Search OpenRouter’s catalog by id or name, then pick the providers.',
  noMatches: 'No models match that search.',
  noPins: 'No models pinned yet.',
  pinnedCount: (n) => `${n} pinned`,
  providersTitle: 'Providers serving this model',
  providersLoading: 'Loading providers…',
  providersEmpty: 'OpenRouter reported no endpoints for this model.',
  modeOnly: 'Only these',
  modeIgnore: 'Ignore these',
  modeHint: '“Only these” is a whitelist; “Ignore these” is a blacklist. With neither picked, the model inherits the defaults.',
  modelSortHint: 'Ranking for this model',
  inherit: 'Inherit',
  savePin: 'Save pin',
  clearPin: 'Remove pin',
  remove: 'Remove',
  loading: 'Loading routing…',
  loadFailed: 'Could not read provider routing.',
  retry: 'Retry',
  configPath: 'Written to',
  refresh: 'Refresh OpenRouter catalog',
  inUse: 'pinned',
  ctx: 'context',
  perMillion: '/M in',
  writeFailed: 'Could not save to config.yaml.'
}

const LOCALES = { en: EN }

// Disk plugins are not scanned by Tailwind: keep bespoke layout here, and use
// theme variables for every colour.
const CSS = `
.orpp-page{display:flex;flex-direction:column;gap:18px;max-width:46rem;padding:20px 22px 40px;font-size:13px}
.orpp-head{display:flex;flex-direction:column;gap:3px}
.orpp-title{font-size:15px;font-weight:600}
.orpp-sub{color:var(--ui-text-tertiary)}
.orpp-card{border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.orpp-card-title{font-weight:600}
.orpp-hint{color:var(--ui-text-tertiary);line-height:1.5}
.orpp-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.orpp-row-label{display:flex;flex-direction:column;gap:2px;min-width:0}
.orpp-actions{display:flex;align-items:center;gap:10px}
.orpp-error{color:var(--ui-text-primary)}
.orpp-list{max-height:15rem;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--ui-stroke-tertiary);border-radius:5px;padding:3px}
.orpp-prov{display:flex;align-items:center;gap:9px;width:100%;padding:5px 7px;border-radius:4px;text-align:left;cursor:pointer;background:transparent;border:0;font:inherit;color:inherit}
.orpp-prov:hover{background:var(--chrome-action-hover)}
.orpp-mark{display:grid;place-items:center;width:14px;height:14px;flex-shrink:0;border-radius:3px;border:1px solid var(--ui-stroke-secondary);color:var(--ui-text-primary)}
.orpp-mark[data-on=true]{background:var(--ui-accent);border-color:var(--ui-accent);color:var(--ui-accent-foreground,var(--dt-background))}
.orpp-prov-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orpp-prov-meta{display:flex;align-items:center;gap:8px;color:var(--ui-text-quaternary);font-size:11px;flex-shrink:0}
.orpp-pin{display:flex;align-items:center;gap:10px;padding:5px 7px;border-radius:4px}
.orpp-pin:hover{background:var(--chrome-action-hover)}
.orpp-pin-model{flex:1;min-width:0;font-family:var(--font-mono,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.orpp-spinner{display:flex;align-items:center;gap:7px;color:var(--ui-text-tertiary)}
.orpp-empty{color:var(--ui-text-tertiary);padding:8px 7px}
`

// ── helpers ──────────────────────────────────────────────────────────────────

const FLAT_KEYS = ['only', 'ignore', 'order', 'sort', 'require_parameters', 'data_collection']

function makeApi(ctx) {
  return {
    state: () => ctx.rest('/state'),
    models: (q) => ctx.rest(`/models?q=${encodeURIComponent(q)}&limit=80`),
    providers: (model) => ctx.rest(`/providers?model=${encodeURIComponent(model)}`),
    saveModel: (model, entry) => ctx.rest('/routing', { method: 'PUT', body: { model, entry } }),
    clearModel: (model) => ctx.rest(`/routing?model=${encodeURIComponent(model)}`, { method: 'DELETE' }),
    saveFlat: (flat) => ctx.rest('/flat', { method: 'PUT', body: { flat } }),
    refresh: () => ctx.rest('/refresh', { method: 'POST' })
  }
}

function entrySummary(entry) {
  if (!entry || typeof entry !== 'object') return []
  const out = []
  if (Array.isArray(entry.only) && entry.only.length) out.push(`only: ${entry.only.join(', ')}`)
  if (Array.isArray(entry.ignore) && entry.ignore.length) out.push(`ignore: ${entry.ignore.join(', ')}`)
  if (Array.isArray(entry.order) && entry.order.length) out.push(`order: ${entry.order.join(' → ')}`)
  if (entry.sort) out.push(`sort: ${entry.sort}`)
  if (entry.require_parameters) out.push('require_parameters')
  if (entry.data_collection) out.push(`data: ${entry.data_collection}`)
  return out
}

function priceLabel(perToken) {
  if (typeof perToken !== 'number' || !Number.isFinite(perToken)) return null
  const perMillion = perToken * 1e6
  return perMillion >= 0.01 ? `$${perMillion.toFixed(2)}${EN.perMillion}` : `$${perMillion.toFixed(4)}${EN.perMillion}`
}

function contextLabel(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return null
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K ${EN.ctx}` : `${tokens} ${EN.ctx}`
}

function draftFrom(entry) {
  const e = entry && typeof entry === 'object' ? entry : {}
  const ignore = Array.isArray(e.ignore) && e.ignore.length > 0
  return {
    mode: ignore ? 'ignore' : 'only',
    slugs: (ignore ? e.ignore : e.only) || [],
    sort: e.sort || 'inherit',
    // Preserved verbatim so editing the whitelist never drops an order list.
    order: Array.isArray(e.order) && e.order.length ? e.order : undefined
  }
}

function entryFrom(draft) {
  const entry = {}
  if (draft.slugs.length) entry[draft.mode] = draft.slugs
  if (draft.sort && draft.sort !== 'inherit') entry.sort = draft.sort
  if (draft.order && draft.order.length) entry.order = draft.order
  return entry
}

function sameStringList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function flatFormFrom(flat) {
  const f = flat && typeof flat === 'object' ? flat : {}
  return {
    sort: f.sort || 'default',
    data_collection: f.data_collection || 'default',
    require_parameters: Boolean(f.require_parameters),
    extra: FLAT_KEYS.reduce((acc, key) => {
      if (key in f && !['sort', 'data_collection', 'require_parameters'].includes(key)) acc[key] = f[key]
      return acc
    }, {})
  }
}

function sameFlatForm(a, b) {
  return (
    a.sort === b.sort &&
    a.data_collection === b.data_collection &&
    a.require_parameters === b.require_parameters &&
    sameStringList(a.extra.only || [], b.extra.only || []) &&
    sameStringList(a.extra.ignore || [], b.extra.ignore || []) &&
    sameStringList(a.extra.order || [], b.extra.order || [])
  )
}

function failure(result) {
  return result && result.ok === false ? String(result.error || 'unknown error') : ''
}

// ── pieces ───────────────────────────────────────────────────────────────────

function SortSelect({ value, onChange, inherit }) {
  const t = usePluginI18n(ID)
  const items = inherit
    ? [['inherit', t('inherit')], ['price', t('sortPrice')], ['throughput', t('sortThroughput')], ['latency', t('sortLatency')]]
    : [['default', t('sortDefault')], ['price', t('sortPrice')], ['throughput', t('sortThroughput')], ['latency', t('sortLatency')]]
  return jsxs(Select, {
    value,
    onValueChange: onChange,
    children: [
      jsx(SelectTrigger, { className: 'w-48', children: jsx(SelectValue, {}) }),
      jsx(SelectContent, {
        children: items.map(([id, label]) => jsx(SelectItem, { value: id, children: label }, id))
      })
    ]
  })
}

function DataCollectionSelect({ value, onChange }) {
  const t = usePluginI18n(ID)
  const items = [['default', t('dataDefault')], ['allow', t('dataAllow')], ['deny', t('dataDeny')]]
  return jsxs(Select, {
    value,
    onValueChange: onChange,
    children: [
      jsx(SelectTrigger, { className: 'w-48', children: jsx(SelectValue, {}) }),
      jsx(SelectContent, {
        children: items.map(([id, label]) => jsx(SelectItem, { value: id, children: label }, id))
      })
    ]
  })
}

function InlineError({ children }) {
  return jsx('div', { className: 'orpp-hint orpp-error', role: 'alert', children })
}

function FlatDefaults({ api, flat, onSaved }) {
  const t = usePluginI18n(ID)
  const queryClient = useQueryClient()
  const [form, setForm] = useState(() => flatFormFrom(flat))
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setForm(flatFormFrom(flat))
    setSaved(false)
  }, [flat])

  const dirty = !sameFlatForm(form, flatFormFrom(flat))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const persist = async (next) => {
    setBusy(true)
    setError('')
    try {
      const payload = { ...next.extra }
      if (next.sort !== 'default') payload.sort = next.sort
      if (next.data_collection !== 'default') payload.data_collection = next.data_collection
      if (next.require_parameters) payload.require_parameters = true
      const result = await api.saveFlat(payload)
      const message = failure(result)
      if (message) setError(message)
      else {
        setSaved(true)
        queryClient.invalidateQueries({ queryKey: [ID, 'state'] })
        onSaved?.(result)
      }
    } catch (err) {
      setError(`${t('writeFailed')} ${err?.message || err}`)
    } finally {
      setBusy(false)
    }
  }

  return jsxs('section', {
    className: 'orpp-card',
    children: [
      jsx('div', { className: 'orpp-card-title', children: t('flatTitle') }),
      jsx('div', { className: 'orpp-hint', children: t('flatHint') }),
      jsx('div', { className: 'orpp-hint', children: t('flatTiming') }),
      jsxs('div', {
        className: 'orpp-row',
        children: [
          jsx('div', { className: 'orpp-row-label', children: jsx('span', { children: t('sort') }) }),
          jsx(SortSelect, { value: form.sort, onChange: (sort) => setForm({ ...form, sort }) })
        ]
      }),
      jsxs('div', {
        className: 'orpp-row',
        children: [
          jsx('div', { className: 'orpp-row-label', children: jsx('span', { children: t('dataCollection') }) }),
          jsx(DataCollectionSelect, {
            value: form.data_collection,
            onChange: (data_collection) => setForm({ ...form, data_collection })
          })
        ]
      }),
      jsxs('div', {
        className: 'orpp-row',
        children: [
          jsx('div', {
            className: 'orpp-row-label',
            children: jsx('span', { children: t('requireParameters') })
          }),
          jsx(Switch, {
            checked: form.require_parameters,
            onCheckedChange: (require_parameters) => setForm({ ...form, require_parameters: Boolean(require_parameters) }),
            'aria-label': t('requireParameters')
          })
        ]
      }),
      error ? jsx(InlineError, { children: error }) : null,
      jsxs('div', {
        className: 'orpp-actions',
        children: [
          jsx(Button, {
            size: 'sm',
            loading: busy,
            disabled: !dirty,
            onClick: () => persist(form),
            children: t('save')
          }),
          jsx(Button, {
            variant: 'ghost',
            size: 'sm',
            disabled: busy || !Object.keys(flat || {}).length,
            onClick: () => persist({ sort: 'default', data_collection: 'default', require_parameters: false, extra: {} }),
            children: t('reset')
          }),
          !dirty && saved ? jsx(Badge, { variant: 'success', children: t('saved') }) : null
        ]
      })
    ]
  })
}

function ProviderRow({ provider, checked, onToggle }) {
  const price = priceLabel(provider.min_prompt_price)
  const context = contextLabel(provider.context_length)
  return jsxs('button', {
    type: 'button',
    className: 'orpp-prov',
    'aria-pressed': checked,
    onClick: onToggle,
    children: [
      jsx('span', { className: 'orpp-mark', 'data-on': checked, 'aria-hidden': true, children: checked ? jsx(icons.Check, { className: 'size-2.5' }) : null }),
      jsx('span', { className: 'orpp-prov-name', children: provider.name }),
      jsxs('span', {
        className: 'orpp-prov-meta',
        children: [
          jsx(Badge, { variant: 'outline', size: 'xs', children: provider.slug }),
          context ? jsx('span', { children: context }) : null,
          price ? jsx('span', { children: price }) : null,
          provider.endpoints?.length > 1 ? jsx('span', { children: `${provider.endpoints.length} endpoints` }) : null
        ]
      })
    ]
  })
}

function ModelEditor({ api, model, entry, onSaved }) {
  const t = usePluginI18n(ID)
  const queryClient = useQueryClient()
  const providersQuery = useQuery({
    queryKey: [ID, 'providers', model],
    queryFn: () => api.providers(model),
    enabled: Boolean(model),
    staleTime: 300000,
    retry: 0
  })

  const [draft, setDraft] = useState(() => draftFrom(entry))
  useEffect(() => {
    setDraft(draftFrom(entry))
  }, [model, entry])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const payload = providersQuery.data?.providers || []
  const toggle = (slug) => {
    const has = draft.slugs.includes(slug)
    setDraft({ ...draft, slugs: has ? draft.slugs.filter((s) => s !== slug) : [...draft.slugs, slug] })
  }

  const persist = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api.saveModel(model, entryFrom(draft))
      const message = failure(result)
      if (message) setError(message)
      else {
        queryClient.invalidateQueries({ queryKey: [ID, 'state'] })
        queryClient.invalidateQueries({ queryKey: [ID, 'providers', model] })
        onSaved?.()
      }
    } catch (err) {
      setError(`${t('writeFailed')} ${err?.message || err}`)
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api.clearModel(model)
      const message = failure(result)
      if (message) setError(message)
      else {
        setDraft(draftFrom({}))
        queryClient.invalidateQueries({ queryKey: [ID, 'state'] })
        onSaved?.()
      }
    } catch (err) {
      setError(`${t('writeFailed')} ${err?.message || err}`)
    } finally {
      setBusy(false)
    }
  }

  const pinnedSlugs = draft.slugs
  const shown = useMemo(() => {
    // Pin order in the list: OpenRouter's own availability order.
    return payload
  }, [payload])

  return jsxs('section', {
    className: 'orpp-card',
    children: [
      jsxs('div', {
        className: 'orpp-row',
        children: [
          jsx('div', {
            className: 'orpp-row-label',
            children: jsxs('span', {
              children: [jsx('strong', { children: model }), ' · ', t('providersTitle')]
            })
          }),
          jsx(SegmentedControl, {
            value: draft.mode,
            onChange: (mode) => setDraft({ ...draft, mode }),
            options: [
              { id: 'only', label: t('modeOnly') },
              { id: 'ignore', label: t('modeIgnore') }
            ]
          })
        ]
      }),
      jsx('div', { className: 'orpp-hint', children: t('modeHint') }),

      providersQuery.isLoading
        ? jsxs('div', { className: 'orpp-spinner', children: [jsx(GlyphSpinner, {}), t('providersLoading')] })
        : providersQuery.isError
          ? jsx(InlineError, { children: String(providersQuery.error?.message || providersQuery.error) })
          : shown.length === 0
            ? jsx('div', { className: 'orpp-hint', children: t('providersEmpty') })
            : jsx('div', {
                className: 'orpp-list',
                children: shown.map((provider) =>
                  jsx(
                    ProviderRow,
                    {
                      provider,
                      checked: pinnedSlugs.includes(provider.slug),
                      onToggle: () => toggle(provider.slug)
                    },
                    provider.slug
                  )
                )
              }),

      jsxs('div', {
        className: 'orpp-row',
        children: [
          jsx('div', { className: 'orpp-row-label', children: jsx('span', { children: t('modelSortHint') }) }),
          jsx(SortSelect, {
            value: draft.sort,
            inherit: true,
            onChange: (sort) => setDraft({ ...draft, sort })
          })
        ]
      }),

      error ? jsx(InlineError, { children: error }) : null,

      jsxs('div', {
        className: 'orpp-actions',
        children: [
          jsx(Button, { size: 'sm', loading: busy, onClick: persist, children: t('savePin') }),
          jsx(Button, {
            variant: 'ghost',
            size: 'sm',
            disabled: busy || !entry || Object.keys(entry).length === 0,
            onClick: clear,
            children: t('clearPin')
          }),
          jsxs('span', {
            className: 'orpp-hint',
            children: [t('configPath'), ' ', jsx('code', { children: 'provider_routing.models.' }), model]
          })
        ]
      })
    ]
  })
}

function PinRow({ api, model, entry, onChanged }) {
  const t = usePluginI18n(ID)
  const [busy, setBusy] = useState(false)
  const summary = entrySummary(entry)
  const remove = async () => {
    setBusy(true)
    try {
      await api.clearModel(model)
      onChanged?.()
    } finally {
      setBusy(false)
    }
  }
  return jsxs('div', {
    className: 'orpp-pin',
    children: [
      jsx('span', { className: 'orpp-pin-model', children: model }),
      jsxs('span', {
        className: 'orpp-prov-meta',
        children: summary.map((line, index) => jsx(Badge, { variant: 'muted', size: 'xs', children: line }, index))
      }),
      jsx(Tip, {
        label: t('remove'),
        children: jsx(Button, {
          variant: 'ghost',
          size: 'icon-xs',
          disabled: busy,
          'aria-label': `${t('remove')} ${model}`,
          onClick: remove,
          children: jsx(icons.Trash2, {})
        })
      })
    ]
  })
}

function RoutingPage({ ctx }) {
  const t = usePluginI18n(ID)
  const api = useMemo(() => makeApi(ctx), [ctx])
  const queryClient = useQueryClient()
  const stateQuery = useQuery({
    queryKey: [ID, 'state'],
    queryFn: () => api.state(),
    staleTime: 4000,
    retry: 1
  })

  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [model, setModel] = useState('')

  useEffect(() => {
    const handle = setTimeout(() => setQuery(search.trim()), 300)
    return () => clearTimeout(handle)
  }, [search])

  const modelsQuery = useQuery({
    queryKey: [ID, 'models', query],
    queryFn: () => api.models(query),
    enabled: query.length >= 2,
    staleTime: 600000,
    retry: 0
  })

  const state = stateQuery.data
  const pins = state && typeof state.models === 'object' && state.models ? state.models : {}
  const pinNames = Object.keys(pins).sort()

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [ID, 'state'] })

  if (stateQuery.isLoading) {
    return jsxs('div', { className: 'orpp-page', children: [
      jsxs('div', { className: 'orpp-spinner', children: [jsx(GlyphSpinner, {}), t('loading')] })
    ] })
  }

  if (stateQuery.isError || (state && state.ok === false)) {
    const message = state?.error || String(stateQuery.error?.message || stateQuery.error || '')
    return jsx('div', {
      className: 'orpp-page',
      children: jsx(ErrorState, {
        title: t('loadFailed'),
        description: message,
        children: jsx(Button, { size: 'sm', onClick: () => stateQuery.refetch(), children: t('retry') })
      })
    })
  }

  const results = (modelsQuery.data?.models || []).filter((row) => row && row.id)

  return jsxs('div', {
    className: 'orpp-page',
    children: [
      jsxs('div', {
        className: 'orpp-head',
        children: [
          jsx('div', { className: 'orpp-title', children: t('title') }),
          jsx('div', { className: 'orpp-sub', children: t('subtitle') }),
          jsxs('div', {
            className: 'orpp-hint',
            children: [
              t('configPath'),
              ' ',
              jsx('code', { children: state?.config_path || 'config.yaml' }),
              state?.config_path
                ? jsx(Button, {
                    variant: 'text',
                    size: 'inline',
                    onClick: () => ctx.os.revealPath(`${state.config_path}`),
                    children: ' · reveal'
                  })
                : null
            ]
          })
        ]
      }),

      jsx(FlatDefaults, { api, flat: state?.flat, onSaved: invalidate }),

      jsxs('section', {
        className: 'orpp-card',
        children: [
          jsx('div', { className: 'orpp-card-title', children: t('pinsTitle') }),
          jsx('div', { className: 'orpp-hint', children: t('pinsHint') }),

          jsx(SearchField, {
            placeholder: t('pickModel'),
            value: search,
            onChange: setSearch,
            variant: 'box',
            containerClassName: 'w-full',
            loading: modelsQuery.isFetching,
            'aria-label': t('pickModel')
          }),

          query.length >= 2
            ? modelsQuery.isError
              ? jsx(InlineError, { children: String(modelsQuery.error?.message || modelsQuery.error) })
              : results.length === 0 && !modelsQuery.isFetching
                ? jsx('div', { className: 'orpp-empty', children: t('noMatches') })
                : jsx('div', {
                    className: 'orpp-list',
                    children: results.map((row) =>
                      jsxs('button', {
                        type: 'button',
                        className: 'orpp-prov',
                        'aria-pressed': model === row.id,
                        onClick: () => {
                          haptic('tap')
                          setModel(row.id)
                        },
                        children: [
                          jsx('span', { className: 'orpp-prov-name', children: row.id }),
                          jsxs('span', {
                            className: 'orpp-prov-meta',
                            children: [
                              row.id in pins
                                ? jsx(Badge, { variant: 'default', size: 'xs', children: t('inUse') })
                                : null,
                              jsx('span', { children: row.name })
                            ]
                          })
                        ]
                      }, row.id)
                    )
                  })
            : jsx('div', { className: 'orpp-hint', children: t('pickHint') }),

          model ? jsx(ModelEditor, { api, model, entry: pins[model], onSaved: invalidate }) : null
        ]
      }),

      jsxs('section', {
        className: 'orpp-card',
        children: [
          jsxs('div', {
            className: 'orpp-row',
            children: [
              jsx('div', { className: 'orpp-card-title', children: t('pinnedCount', pinNames.length) }),
              jsx(Button, {
                variant: 'ghost',
                size: 'xs',
                onClick: async () => {
                  await api.refresh()
                  queryClient.invalidateQueries({ queryKey: [ID] })
                },
                children: jsxs('span', {
                  className: 'flex items-center gap-1',
                  children: [jsx(icons.RefreshCw, {}), t('refresh')]
                })
              })
            ]
          }),
          jsx(Separator, {}),
          pinNames.length === 0
            ? jsx(EmptyState, { title: t('noPins') })
            : jsx('div', {
                children: pinNames.map((name) =>
                  jsx(PinRow, { api, model: name, entry: pins[name], onChanged: invalidate }, name)
                )
              })
        ]
      })
    ]
  })
}

function RoutingChip({ ctx }) {
  const t = usePluginI18n(ID)
  const api = useMemo(() => makeApi(ctx), [ctx])
  const stateQuery = useQuery({
    queryKey: [ID, 'state'],
    queryFn: () => api.state(),
    staleTime: 30000,
    refetchInterval: 60000,
    retry: 1
  })
  const pins = stateQuery.data?.models || {}
  const count = Object.keys(pins).length
  return jsx(Tip, {
    label: count ? `${t('title')} — ${t('pinnedCount', count)}` : t('title'),
    children: jsxs('button', {
      type: 'button',
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: () => {
        haptic('tap')
        host.navigate(pluginSettingsHref(ID))
      },
      children: [jsx(icons.Network, { className: 'size-3' }), count ? String(count) : '—']
    })
  })
}

export default {
  id: ID,
  name: 'OpenRouter Provider Routing',
  description: 'Pick which upstream providers serve each OpenRouter model.',
  register(ctx) {
    ctx.i18n.register(LOCALES)

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    ctx.registerSettingsPage?.({
      id: 'routing',
      title: EN.title,
      icon: 'server-process',
      order: 5,
      render: () => jsx(RoutingPage, { ctx })
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 125,
      render: () => jsx(RoutingChip, { ctx })
    })
  }
}
