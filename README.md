# BetterFluxer

BetterFluxer is a BetterDiscord-style runtime for Fluxer. It provides:

- Plugin discovery and lifecycle (`start`, `stop`, `reload`)
- Safe monkey patching API (`before`, `after`, `instead`, `unpatchAll`)
- Per-plugin persistent JSON storage
- Electron preload integration pattern
- Docs: see [`docs/README.md`](/c:/Users/Rox/Documents/BetterFluxer/docs/README.md)

## Quick start

```bash
npm install
npm test
npm start
```

`npm start` loads plugins from `./plugins`.

## Electron injector app

This repo now includes a full Electron launcher that loads Fluxer and injects BetterFluxer.

1. Install dependencies:

```bash
npm install
```

2. Start the injector app:

```bash
npm run electron:start
```

3. Optional: point to a specific Fluxer client URL:

```bash
npm run electron:start -- --url=https://your-fluxer-client-url
```

You can also set:

- `FLUXER_CLIENT_URL`: client URL override
- `BETTERFLUXER_HOME`: custom runtime root (contains `plugins/` and `data/`)

Main Electron files:

- `electron/main.js`
- `electron/preload.js`
- `electron/fluxer.config.example.json`

## Inject into installed Fluxer desktop app

If you want BetterFluxer injected into the real Fluxer installation (instead of using the custom launcher), use the injector CLI.

GUI option (recommended):

```bash
npm run electron:gui
```

## Build Windows EXE

Package the Injector GUI into Windows distributables:

```bash
npm install
npm run dist:win
```

Output is written to `dist/` as a packaged app folder containing:

- `BetterFluxerInjector.exe`

Useful variants:

```bash
npm run dist:win:builder
npm run dist:win:nsis
npm run dist:win:portable
npm run dist:dir
```

Note: `dist:win:builder` (electron-builder) may require elevated privileges or Windows Developer Mode on some systems due symlink extraction used by signing tools. If that fails, use `dist:win` (packager), which still gives you a working `.exe`.

On Linux, the launcher applies GTK/X11-safe defaults automatically. If needed, you can still override with your own env vars/flags.
On Linux, the injector also inspects the running Fluxer process (`/proc`) to detect PID, AppImage path, and candidate app path.
If Fluxer runs from a mounted AppImage (`/tmp/.mount_*`), that path is typically read-only and cannot be patched persistently.
When detected, the injector can install/extract the AppImage into `~/.fluxer` and create a desktop entry at `~/.local/share/applications/fluxer.desktop`.
On Linux, the injector also has an `Install Latest Fluxer (Linux)` button that downloads from `https://api.fluxer.app/dl/desktop/stable/linux/x64/latest/appimage` and installs to `~/.fluxer/fluxer` (auto-set as app path).
If Linux install-root auto-detection fails, the injector falls back to `~/.fluxer/fluxer`.

The GUI includes:

- install/version detection
- injection status panel
- built-in guide
- `Close Fluxer` button
- `Inject` / `Uninject` actions
- BetterFluxer settings entry injection (sidebar category + plugin toggles/settings panel)

Default install root it searches:

- `C:\Users\<you>\AppData\Local\fluxer_app`
- `~/.local/share/fluxer_app` (Linux)
- `~/.config/fluxer_app` (Linux fallback)
- Auto-selects newest `app-x.y.z` folder unless you pass `--version`.
- If your layout is different, use `--app-path` to point directly at the Fluxer app folder.

Inject:

```bash
npm run inject
```

Inject specific version:

```bash
npm run inject -- --version=0.0.8
```

Inject specific app folder directly:

```bash
npm run inject -- --app-path="C:\Users\Rox\AppData\Local\fluxer_app\app-0.0.8"
```

Dry-run (no file changes):

```bash
npm run inject -- --app-path=".\app_do_not_edit" --dry-run
```

Remove injection:

```bash
npm run uninject -- --app-path="C:\Users\Rox\AppData\Local\fluxer_app\app-0.0.8"
```

What gets modified:

- `resources\app.asar.unpacked\src-electron\dist\preload\index.js`
: backup file is created once at `index.js.betterfluxer.bak`
- `resources\app.asar.unpacked\betterfluxer\` (runtime + plugins)

Important:

- Fluxer should be closed before file patching.
- In the GUI, keep `Close Fluxer before inject/uninject` enabled (Windows/Linux/macOS if supported).
- In CLI mode, close Fluxer first manually.

## Structure

- `src/betterfluxer.js`: Runtime entry point
- `src/core/plugin-manager.js`: Loads/unloads/reloads plugins
- `src/core/patcher.js`: BetterDiscord-like patching utility
- `src/core/plugin-storage.js`: Per-plugin JSON storage
- `src/integration/electron-preload.example.js`: Example Electron preload wiring
- `plugins/HelloFluxer`: Example plugin
- `plugins/InjectedBadge`: Visual injection check plugin

## Plugin format

Create a folder inside `plugins/` with a `manifest.json` and `index.js`.

`manifest.json`:

```json
{
  "name": "MyPlugin",
  "version": "1.0.0",
  "description": "My Fluxer plugin",
  "author": "You",
  "main": "index.js"
}
```

`index.js`:

```js
module.exports = class MyPlugin {
  constructor(api) {
    this.api = api;
  }

  start() {
    this.api.logger.info("Plugin started");
    this.api.storage.set("enabledAt", Date.now());
  }

  stop() {
    this.api.patcher.unpatchAll();
    this.api.logger.info("Plugin stopped");
  }
};
```

## Plugin API

Each plugin receives `api` in its constructor:

- `api.logger`: scoped logger (`debug/info/warn/error`)
- `api.storage`: persistent key/value
- `api.patcher`:
  - `before(target, method, callback)`
  - `after(target, method, callback)`
  - `instead(target, method, callback)`
  - `unpatchAll()`
- `api.app`: app context passed from Fluxer

## Integrating with Fluxer (Electron)

1. Copy and adapt [`src/integration/electron-preload.example.js`](/c:/Users/Rox/Documents/BetterFluxer/src/integration/electron-preload.example.js).
2. In Fluxer, set BrowserWindow preload to your adapted preload file.
3. Pass Fluxer internals through `appContext` so plugins can patch app functions/components.
4. Package a writable runtime folder (example: `<resources>/betterfluxer`) containing `plugins/` and `data/`.

## Next extensions

- Plugin enable/disable state persisted in settings
- Theme/CSS manager similar to BetterDiscord themes
- Signed plugin repository + update checks
- In-app settings UI for plugin controls
