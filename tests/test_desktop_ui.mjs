/**
 * Render and drive the REAL desktop/plugin.js in jsdom.
 *
 * The plugin's only importable dependency, `@hermes/plugin-sdk`, is swapped for
 * ./sdk-stub.mjs (same named exports, plain DOM) so the component tree, the
 * jsx() shapes, the effect wiring and every request body the UI sends can be
 * asserted without the Electron app. It catches the things a lint pass cannot:
 * identifiers used in jsx() but never imported, unstable props in useEffect
 * deps, and payload drift between the UI and the backend.
 *
 *   cd tests && npm install && node test_desktop_ui.mjs
 *
 * Nothing here touches the real config: the backend is faked.
 */

import { JSDOM } from 'jsdom'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '..')
const PLUGIN = path.join(REPO, 'desktop', 'plugin.js')

if (!fs.existsSync(path.join(HERE, 'node_modules'))) {
  console.error('Run `npm install` in tests/ first (needs jsdom, react, @testing-library/react).')
  process.exit(2)
}

// -- jsdom ------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.HTMLInputElement = dom.window.HTMLInputElement
globalThis.Element = dom.window.Element
globalThis.Event = dom.window.Event
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.KeyboardEvent = dom.window.KeyboardEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)

const React = (await import('react')).default
const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react')
const { registry } = await import('./registry.mjs')

// -- fake backend ------------------------------------------------------------

const FLAT = { sort: 'price' }
const PINS = { 'openai/gpt-6-astra': { only: ['openai'], sort: 'throughput' } }
const MODELS = [
  { id: 'anthropic/claude-fable-5.2', name: 'Anthropic: Claude Fable 5.2' },
  { id: 'openai/gpt-6-astra', name: 'OpenAI: GPT-6 Astra' }
]
const PROVIDERS = [
  { slug: 'google-vertex', name: 'Google', context_length: 1000000, min_prompt_price: 0.000008, endpoints: [{}] },
  { slug: 'amazon-bedrock', name: 'Amazon Bedrock', context_length: 1000000, min_prompt_price: 0.000008, endpoints: [{}] },
  { slug: 'anthropic', name: 'Anthropic', context_length: 1000000, min_prompt_price: 0.000008, endpoints: [{}, {}] }
]

const calls = []
const snapshot = () => ({
  ok: true,
  flat: { ...FLAT },
  models: JSON.parse(JSON.stringify(PINS)),
  sorts: ['price', 'throughput', 'latency'],
  config_path: '/tmp/config.yaml'
})

const rest = async (url, opts = {}) => {
  const method = opts.method || 'GET'
  calls.push({ method, url, body: opts.body })
  const query = (key) => decodeURIComponent(new URLSearchParams(url.split('?')[1]).get(key))
  if (url === '/state') return snapshot()
  if (url.startsWith('/models')) return { ok: true, total: MODELS.length, models: MODELS }
  if (url.startsWith('/providers')) {
    const model = query('model')
    return { ok: true, model, entry: PINS[model] || {}, providers: PROVIDERS }
  }
  if (url.startsWith('/routing') && method === 'PUT') {
    if (opts.body?.entry && Object.keys(opts.body.entry).length) PINS[opts.body.model] = opts.body.entry
    else delete PINS[opts.body?.model]
    return { ok: true, ...snapshot() }
  }
  if (url.startsWith('/routing') && method === 'DELETE') {
    delete PINS[query('model')]
    return { ok: true, ...snapshot() }
  }
  if (url === '/flat' && method === 'PUT') {
    for (const key of Object.keys(FLAT)) delete FLAT[key]
    Object.assign(FLAT, opts.body.flat)
    return { ok: true, ...snapshot() }
  }
  if (url === '/refresh') return { ok: true }
  throw new Error(`harness: unexpected request ${method} ${url}`)
}

// -- load the real plugin ----------------------------------------------------

const source = fs.readFileSync(PLUGIN, 'utf8')
const rewritten = source.replace("from '@hermes/plugin-sdk'", `from '${pathToFileURL(path.join(HERE, 'sdk-stub.mjs')).href}'`)
if (rewritten === source) throw new Error("plugin.js no longer imports '@hermes/plugin-sdk' — update the harness rewrite")
const moduleFile = path.join(HERE, 'plugin.under-test.mjs')
fs.writeFileSync(moduleFile, rewritten)

const plugin = (await import(pathToFileURL(moduleFile).href)).default

const registrations = []
let settingsPage = null
const ctx = {
  rest,
  i18n: { register: (bundles) => Object.assign(registry.bundles, bundles) },
  onDispose: () => {},
  os: { revealPath: () => {} },
  register: (contribution) => registrations.push(contribution),
  registerSettingsPage: (page) => {
    settingsPage = page
  }
}

const results = []
const check = (label, condition, extra = '') => {
  results.push([label, Boolean(condition), extra])
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${extra && !condition ? `  -> ${extra}` : ''}`)
}

// -- 1. registration ---------------------------------------------------------
plugin.register(ctx)
check('exports the expected id', plugin.id === 'openrouter-provider-picker', plugin.id)
check('registered a Settings ▸ Plugins page', Boolean(settingsPage))
check('settings page titled "Provider Routing"', settingsPage?.title === 'Provider Routing', settingsPage?.title)
check('registered exactly one status-bar chip', registrations.length === 1 && registrations[0].area === 'statusBar.right',
  JSON.stringify(registrations.map((r) => r.area)))
check('registered English strings', Object.keys(registry.bundles.en || {}).length > 20,
  String(Object.keys(registry.bundles.en || {}).length))

// -- 2. render the settings page (the real registered render fn) -------------
const view = render(React.createElement(settingsPage.render))
await waitFor(() => {
  if (!view.container.textContent.includes('Defaults for every model')) throw new Error('page body not painted yet')
})
const text = () => view.container.textContent
check('rendered the page title', text().includes('Provider Routing'))
check('rendered the defaults section', text().includes('Defaults for every model'))
check('rendered the live config path', text().includes('/tmp/config.yaml'))

// -- 3. flat defaults form ---------------------------------------------------
const selects = () => Array.from(view.container.querySelectorAll('select'))
check('defaults card renders its two selects', selects().length >= 2, String(selects().length))
fireEvent.change(selects()[0], { target: { value: 'throughput' } })
fireEvent.change(selects()[1], { target: { value: 'deny' } })

const switches = Array.from(view.container.querySelectorAll('[role="switch"]'))
check('require_parameters switch rendered', switches.length === 1, String(switches.length))
fireEvent.click(switches[0])

const saveDefaults = Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent === 'Save defaults')
check('Save defaults button present', Boolean(saveDefaults))
fireEvent.click(saveDefaults)
await waitFor(() => {
  if (!calls.some((c) => c.method === 'PUT' && c.url === '/flat')) throw new Error('no PUT /flat yet')
})
const flatCall = calls.find((c) => c.method === 'PUT' && c.url === '/flat')
check('Save defaults PUT exactly the edited flat routing',
  JSON.stringify(flatCall.body) === JSON.stringify({ flat: { sort: 'throughput', data_collection: 'deny', require_parameters: true } }),
  JSON.stringify(flatCall.body))

// -- 4. model search + provider selection -----------------------------------
const search = view.container.querySelector('input')
check('model search field rendered', Boolean(search))
fireEvent.change(search, { target: { value: 'claude' } })
await waitFor(() => {
  if (!text().includes('anthropic/claude-fable-5.2')) throw new Error('model results not shown')
})
check('search listed matching models', text().includes('anthropic/claude-fable-5.2') && text().includes('openai/gpt-6-astra'))
check('search hit the catalog endpoint', calls.some((c) => c.url.startsWith('/models?q=claude')))

const modelRow = Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent.includes('anthropic/claude-fable-5.2'))
fireEvent.click(modelRow)
await waitFor(() => {
  if (!text().includes('Providers serving this model')) throw new Error('editor not open')
})
check('opened the provider editor for the picked model', text().includes('Providers serving this model'))
check('fetched providers for that model', calls.some((c) => c.url.includes('/providers?model=anthropic%2Fclaude-fable-5.2')))
await waitFor(() => {
  if (!text().includes('Google')) throw new Error('provider rows not painted')
})
check('listed upstream providers', ['Google', 'Amazon Bedrock', 'Anthropic'].every((n) => text().includes(n)))
check('showed the routing slug badge', text().includes('google-vertex'))
check('showed the input price per million tokens', text().includes('$8.00/M in'), text().match(/\$[\d.]+\/M in/)?.[0] || 'none')

const providerRow = Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent.includes('google-vertex'))
fireEvent.click(providerRow)
await waitFor(() => {
  if (!Array.from(view.container.querySelectorAll('.orpp-mark')).some((m) => m.getAttribute('data-on') === 'true')) {
    throw new Error('no mark toggled')
  }
})
check('clicking a provider checks its mark',
  Array.from(view.container.querySelectorAll('.orpp-mark')).filter((m) => m.getAttribute('data-on') === 'true').length === 1)

fireEvent.change(selects()[selects().length - 1], { target: { value: 'latency' } })

fireEvent.click(Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent === 'Save pin'))
await waitFor(() => {
  if (!calls.some((c) => c.method === 'PUT' && c.url === '/routing')) throw new Error('no PUT /routing yet')
})
const pinCall = calls.find((c) => c.method === 'PUT' && c.url === '/routing')
check('Save pin PUT the whitelist + per-model sort override',
  JSON.stringify(pinCall.body) === JSON.stringify({ model: 'anthropic/claude-fable-5.2', entry: { only: ['google-vertex'], sort: 'latency' } }),
  JSON.stringify(pinCall.body))

// -- 5. blacklist mode + pinned list ---------------------------------------
fireEvent.click(Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent === 'Ignore these'))
check('switched to blacklist mode', view.container.querySelector('[data-segmented]')?.getAttribute('data-segmented') === 'ignore')

await waitFor(() => {
  if (!text().includes('pinned')) throw new Error('pinned count not shown')
})
check('pinned list counts both pins (fixture + the one just saved)', text().includes('2 pinned'),
  text().match(/\d+ pinned/)?.[0] || 'none')
check('pinned list renders the pre-existing pin and its summary',
  text().includes('openai/gpt-6-astra') && text().includes('only: openai'))

const removeButton = Array.from(view.container.querySelectorAll('button'))
  .find((b) => b.getAttribute('aria-label')?.startsWith('Remove openai/gpt-6-astra'))
check('pinned row has a remove action', Boolean(removeButton))
fireEvent.click(removeButton)
await waitFor(() => {
  if (!calls.some((c) => c.method === 'DELETE')) throw new Error('no DELETE yet')
})
check('removing a pin deleted the overlay',
  calls.find((c) => c.method === 'DELETE').url === '/routing?model=openai%2Fgpt-6-astra',
  calls.find((c) => c.method === 'DELETE').url)

cleanup()

// -- 6. status-bar chip -----------------------------------------------------
const chip = render(React.createElement(registrations[0].render))
await waitFor(() => {
  if (!chip.container.querySelector('button')) throw new Error('chip not painted')
})
check('chip paints a count', chip.container.textContent.trim().length > 0, chip.container.textContent)
fireEvent.click(chip.container.querySelector('button'))
check('chip navigates to its settings page',
  registry.navigations.includes('/settings?plugin=openrouter-provider-picker'), JSON.stringify(registry.navigations))
check('chip fired a haptic tap', registry.haptics >= 1)

// -- summary -----------------------------------------------------------------
const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed  (${calls.length} backend calls)`)
if (failed.length) {
  console.log('FAILED:')
  failed.forEach(([label, , extra]) => console.log(` - ${label}${extra ? ` (${extra})` : ''}`))
}
process.exit(failed.length ? 1 : 0)
