// A stand-in for @hermes/plugin-sdk: same named exports, same prop contracts,
// but plain DOM so the plugin can be rendered and driven in jsdom.
import React, { useEffect, useRef, useState } from 'react'

import { registry } from './registry.mjs'

let bumpVersion = 0
const queries = new Set()

export { React }

// -- data layer --------------------------------------------------------------

export function useQueryClient() {
  return {
    invalidateQueries: async () => {
      bumpVersion += 1
      queries.forEach((fn) => fn())
    }
  }
}

export function useQuery({ queryKey, queryFn, enabled = true, refetchInterval }) {
  const key = JSON.stringify(queryKey)
  const [state, setState] = useState({ data: undefined, isLoading: enabled !== false, isFetching: false, isError: false, error: null })
  const [tick, setTick] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const force = () => setTick((n) => n + 1)
    queries.add(force)
    return () => queries.delete(force)
  }, [])

  useEffect(() => {
    if (enabled === false) {
      setState({ data: undefined, isLoading: false, isFetching: false, isError: false, error: null })
      return
    }
    let live = true
    setState((prev) => ({ ...prev, isFetching: true, isLoading: prev.data === undefined }))
    Promise.resolve()
      .then(() => queryFn())
      .then((data) => live && alive.current && setState({ data, isLoading: false, isFetching: false, isError: false, error: null }))
      .catch((error) => live && alive.current && setState({ data: undefined, isLoading: false, isFetching: false, isError: true, error }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tick, bumpVersion])

  return { ...state, refetch: async () => setTick((n) => n + 1) }
}

export const useMutation = () => ({ mutate: () => {}, isPending: false })

export const atom = (value) => {
  const listeners = new Set()
  return {
    get: () => value,
    set: (next) => {
      value = next
      listeners.forEach((fn) => fn(next))
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
}
export const computed = (deps, fn) => {
  const out = atom(fn(...deps.map((d) => d.get())))
  return out
}
export const useValue = (a) => (a && typeof a.get === 'function' ? a.get() : a)

// -- i18n --------------------------------------------------------------------

export function usePluginI18n() {
  return (key, ...args) => {
    const value = registry.bundles.en?.[key]
    if (typeof value === 'function') return value(...args)
    return value === undefined ? key : value
  }
}

export const translateNow = (key) => key

// -- actions -----------------------------------------------------------------

export const haptic = () => {
  registry.haptics += 1
}
export const host = {
  navigate: (path) => registry.navigations.push(path),
  notify: () => {},
  request: async () => ({}),
  onEvent: () => () => {}
}
export const pluginSettingsHref = (id) => `/settings?plugin=${id}`

export const icons = new Proxy(
  { Check: () => React.createElement('i', { 'data-icon': 'check' }), Trash2: () => React.createElement('i', { 'data-icon': 'trash' }), RefreshCw: () => React.createElement('i', { 'data-icon': 'refresh' }), Network: () => React.createElement('i', { 'data-icon': 'network' }) },
  {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'symbol') return undefined
      throw new Error(`plugin used icons.${String(prop)}, which the harness does not define`)
    }
  }
)

// -- ui primitives -----------------------------------------------------------

export const cn = (...parts) => parts.filter(Boolean).join(' ')

export function Button({ children, onClick, disabled, loading, variant, size, asChild, ...rest }) {
  return React.createElement('button', { type: 'button', disabled: disabled || loading, onClick, 'data-variant': variant, 'data-size': size, ...rest }, children)
}

export function Switch({ checked, onCheckedChange, ...rest }) {
  return React.createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': Boolean(checked),
    onClick: () => onCheckedChange(!checked),
    ...rest
  })
}

export const Badge = ({ children, variant, ...rest }) => React.createElement('span', { 'data-badge': variant, ...rest }, children)
export const Separator = () => React.createElement('hr')
export const GlyphSpinner = () => React.createElement('span', { 'data-spinner': 'true' })
export const Tip = ({ children }) => children
export const EmptyState = ({ title, description }) => React.createElement('div', { 'data-empty': title }, title, description || null)
export const ErrorState = ({ title, description, children }) => React.createElement('div', { 'data-error': title }, title, description || null, children || null)
export const RowButton = ({ children, onClick, ...rest }) => React.createElement('button', { type: 'button', onClick, ...rest }, children)

export function SearchField({ value, onChange, placeholder, loading, ...rest }) {
  return React.createElement('input', {
    'aria-label': rest['aria-label'] || placeholder,
    placeholder,
    value,
    onChange: (event) => onChange(event.target.value)
  })
}

export function SegmentedControl({ options, value, onChange }) {
  return React.createElement(
    'div',
    { role: 'group', 'data-segmented': value },
    options.map((option) =>
      React.createElement('button', {
        key: option.id,
        type: 'button',
        'aria-pressed': option.id === value,
        onClick: () => onChange(option.id)
      }, option.label)
    )
  )
}

export const SelectContent = () => null
export const SelectItem = () => null
export const SelectTrigger = () => null
export const SelectValue = () => null

export function Select({ value, onValueChange, children }) {
  const items = []
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (!node || typeof node !== 'object') return
    if (node.type === SelectContent) return walk(node.props.children)
    if (node.type === SelectItem) {
      items.push([node.props.value, node.props.children])
      return
    }
  }
  walk(children)
  return React.createElement(
    'select',
    {
      'data-testid': 'select',
      value,
      onChange: (event) => onValueChange(event.target.value)
    },
    items.map(([id, label]) => React.createElement('option', { key: id, value: id }, label))
  )
}
