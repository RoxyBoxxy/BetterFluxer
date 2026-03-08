# Plugin Settings Integration

BetterFluxer can render plugin-defined settings directly inside the built-in **Better Fluxer > Settings** panel.

This supports live updates without reinjecting or switching chats.

## Supported plugin methods

Implement these in your plugin class/object:

```js
getSettingsSchema() {
  return {
    title: "My Plugin",
    description: "Optional description",
    controls: [
      // range
      { key: "size", type: "range", label: "Size", min: 1, max: 10, step: 1, value: 4, suffix: "x" },
      // boolean
      { key: "enabled", type: "boolean", label: "Enabled", value: true },
      // text (fallback type)
      { key: "tag", type: "text", label: "Tag", value: "default" }
    ]
  };
}

setSettingValue(key, value) {
  // update in-memory
  // persist using this.api.storage.set(...)
  // re-apply changes immediately
  return { ok: true };
}
```

## Control types

- `range`
  - uses slider UI
  - fields: `min`, `max`, `step`, `value`, optional `suffix`
- `boolean`
  - uses checkbox/toggle UI
  - fields: `value`
- `text` (or unknown type)
  - uses text input UI
  - fields: `value`

## Live update behavior

When a control changes, BetterFluxer will:

1. Call `setSettingValue(key, value)`
2. Try optional plugin hooks (if implemented):
   - `onSettingChanged(key, value, result)`
   - `refresh()`
   - `processDocument(document)`
3. Emit runtime/browser events:
   - runtime: `plugin:setting:changed`
   - window: `betterfluxer:plugin-setting-changed`

## Persistence recommendation

Use per-plugin storage:

```js
// load
const value = this.api.storage.get("myKey", defaultValue);
// save
this.api.storage.set("myKey", value);
```

Load persisted values in `start()` (or a `loadConfig()` helper), and return those current values from `getSettingsSchema()`.

## Where this works

- `MyPlugins/*`
- `nw/plugins/*`

Any enabled plugin that exposes `getSettingsSchema()` appears automatically in BetterFluxer settings.
