// Shared mutable registry so the SDK stub can serve the strings the plugin
// registers through ctx.i18n.register().
export const registry = {
  bundles: {},
  navigations: [],
  haptics: 0
}
