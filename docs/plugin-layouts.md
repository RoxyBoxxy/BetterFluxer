# Plugin Layouts

BetterFluxer supports multiple plugin export styles.

## 1) Class plugin (constructor API)

```js
module.exports = class MyPlugin {
  constructor(api) {
    this.api = api;
  }

  start(ctx) {}
  stop(ctx) {}
};
```

## 2) Object plugin (CommonJS)

```js
module.exports = {
  name: "My Plugin",
  version: "1.0.0",
  start(ctx) {},
  stop(ctx) {}
};
```

## 3) Object plugin (ESM-style default export)

```js
export default {
  name: "My Plugin",
  version: "1.0.0",
  start(ctx) {},
  stop(ctx) {}
};
```

`ctx` receives the BetterFluxer API (`logger`, `storage`, `patcher`, `settings`, `ui`, `classes`, `app`).

## Dynamic Settings (Recommended)

Plugins can expose settings in BetterFluxer settings UI by implementing:

- `getSettingsSchema()`
- `setSettingValue(key, value)`

See full guide: [Plugin Settings Integration](./plugin-settings.md)
