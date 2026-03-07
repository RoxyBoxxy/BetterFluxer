# Core Classes

## `BetterFluxer` (`src/betterfluxer.js`)

- `constructor(options)`
- `start()`
- `stop()`
- `listPlugins()`
- `reloadPlugin(pluginId)`

## `PluginManager` (`src/core/plugin-manager.js`)

- `constructor(options)`
- `startAll()`
- `stopAll()`
- `list()`
- `load(pluginPath)`
- `unload(pluginId)`
- `reload(pluginId)`
- `start(pluginId)`
- `stop(pluginId)`

Plugin loading supports:
- Directory plugins (`manifest.json` + `main`/`index.js`)
- Single-file `.js` plugins in `plugins/`

## `Patcher` (`src/core/patcher.js`)

- `before(namespace, target, method, callback)`
- `after(namespace, target, method, callback)`
- `instead(namespace, target, method, callback)`
- `unpatchAll(namespace)`

LIFO unpatch order is used to properly unwind stacked patches.

## `PluginStorage` (`src/core/plugin-storage.js`)

- JSON-backed key/value store per plugin file
- `get(key, fallback)`
- `set(key, value)`
- `delete(key)`
- `save()`
