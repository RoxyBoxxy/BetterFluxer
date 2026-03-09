![BetterFluxer](https://github.com/RoxyBoxxy/BetterFluxer/blob/main/nw/assets/betterfluxertrans.png?raw=true)

BetterFluxer is a BetterDiscord-style runtime + injector for Fluxer desktop.

Main features:

- Plugin lifecycle (`start`, `stop`, `reload`, enable/disable)
- Safe patching API (`before`, `after`, `instead`, `unpatchAll`)
- Per-plugin persistent storage
- Injected settings UI inside Fluxer settings panel
- Dynamic plugin settings integration (`getSettingsSchema` + `setSettingValue`) with live apply
- Plugin store support (remote index + install/remove)

Docs index: [`docs/README.md`](./docs/README.md)

## Development

Install and test:

```bash
npm install
npm test
```

Run injector GUI (NW.js):

```bash
npm start
```

## Build

Build injector packages:

```bash
npm run dist:win
npm run dist:win:onefile
npm run dist:linux
```

Bridge builds:

```bash
npm run dist:bridge:win
npm run dist:bridge:msi
npm run dist:bridge:linux
```

## Inject / Uninject (CLI)

Inject:

```bash
npm run inject
```

Inject specific app/version:

```bash
npm run inject -- --version=0.0.8
npm run inject -- --app-path="C:\Users\<USERNAME>\AppData\Local\fluxer_app\app-0.0.8"
```

Dry run:

```bash
npm run inject -- --app-path=".\app_do_not_edit" --dry-run
```

Uninject:

```bash
npm run uninject -- --app-path="C:\Users\<USERNAME>\AppData\Local\fluxer_app\app-0.0.8"
```

Default install roots auto-detected by OS:

- Windows: `%USERPROFILE%\AppData\Local\fluxer_app`
- Linux: `~/.fluxer/fluxer`, `$XDG_DATA_HOME/fluxer_app`, `$XDG_CONFIG_HOME/fluxer_app`, `~/.config/Fluxer`
- macOS: `~/Library/Application Support/fluxer_app`

## What injection modifies

- `resources/app.asar.unpacked/src-electron/dist/preload/index.js`
  - backup: `index.js.betterfluxer.bak`
- `resources/app.asar.unpacked/betterfluxer/`

If Fluxer only has packed `app.asar` without `app.asar.unpacked` preload, injection is not supported.

## Repo layout

- `nw/`: Injector GUI app (NW.js)
- `bridge-nw/`: Bridge app and local bridge script
- `scripts/lib/fluxer-injector-utils.js`: Core patch/inject logic
- `src/`: Runtime core used by injected BetterFluxer
- `MyPlugins/`, `plugins/`, and/or `nw/plugins/`: Plugin sources loaded by injector/runtime
