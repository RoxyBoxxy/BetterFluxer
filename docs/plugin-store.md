# Plugin Store

BetterFluxer Plugins tab includes a **Store** button.

Default index URL:

`https://raw.githubusercontent.com/RoxyBoxxy/BetterFluxer/refs/heads/main/plugins.json`

Expected JSON:

```json
{
  "plugins": [
    {
      "id": "test-plugin",
      "manifest": "https://raw.githubusercontent.com/RoxyBoxxy/BetterFluxer/main/plugins/test/manifest.json"
    }
  ]
}
```

Expected manifest shape:

```json
{
  "name": "Test Plugin",
  "id": "test-plugin",
  "version": "1.0.0",
  "creator": "Roxy",
  "description": "A simple plugin that logs a test string",
  "main": "plugin.js",
  "apiVersion": 1
}
```

## Behavior

- `Store` opens remote plugin list.
- `Refresh` refetches the index JSON.
- `Install` downloads plugin code and installs immediately.
- Installed store plugins are persisted and auto-loaded on restart.
- Store downloads use desktop-side fetch first, then proxy/direct fallbacks depending on client environment.

## Debug bridge methods

```js
await window.betterFluxerDebug.loadStoreIndex();
window.betterFluxerDebug.getStoreItems();
await window.betterFluxerDebug.installStorePlugin({
  id: "test-plugin",
  manifest: "https://raw.githubusercontent.com/RoxyBoxxy/BetterFluxer/main/plugins/test/manifest.json"
});
```
