# Local Bridge

Runs a localhost-only companion service for plugins to fetch remote data safely.

## Start

```bash
npm run bridge:start
```

NW.js Bridge UI:

```bash
npm run bridge:app
```

Server:

- Host: `127.0.0.1`
- Port: `21864` (override with `BF_BRIDGE_PORT`)

## Windows Startup / Hidden Mode

Cross-platform install entrypoint:

```bash
npm run bridge:install
```

Cross-platform uninstall:

```bash
npm run bridge:uninstall
```

Behavior:

- Windows: installs/removes startup launcher (same as startup-install/remove)
- Linux: writes/removes `~/.local/bin/betterfluxer-bridge` and `~/.config/autostart/betterfluxer-bridge.desktop`

Install startup (Windows only):

```bash
npm run bridge:startup:install
```

Remove startup:

```bash
npm run bridge:startup:remove
```

The startup entry launches bridge hidden using the per-user Run registry key (`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`), not VBS.
For packaged EXE builds, startup install copies bridge to:

`%LOCALAPPDATA%\BetterFluxer\bridge\BetterFluxerBridge.exe`

Manual hidden run:

```bash
node bridge-nw/scripts/local-bridge.js --hidden
```

On first start it generates a token in:

`%APPDATA%\BetterFluxer\data\bridge-token.txt` (Windows)

Override base dir:

`BF_HOME_DIR=<custom_path>`

## Auth

Use one of:

- Header `X-BetterFluxer-Token: <token>`
- Header `Authorization: Bearer <token>`

## Endpoints

### `GET /health`

Returns bridge status.

### `GET /fetch?url=<encoded>&type=json|text&ttl=seconds`

Fetches an allowlisted URL and returns JSON payload.

`POST /fetch` is also supported with JSON body:

```json
{
  "url": "https://raw.githubusercontent.com/...",
  "type": "json",
  "ttl": 120
}
```

### `GET /windows/media`

Deprecated/disabled. Returns HTTP `410`.

### `GET /now-playing`

Universal now-playing endpoint with platform adapters:

- Windows: Discord RPC pipe capture + Tuna JSON fallback
- Linux: MPRIS via `playerctl`
- macOS: AppleScript (`Spotify`/`Music`)
- Discord RPC pipes: captures `SET_ACTIVITY`/`CLEAR_ACTIVITY` from apps connecting to `discord-ipc-*` (when bridge can bind those pipes)
  - Game activities (`type: 0`) are tagged as `kind: "game"` for BetterFluxer status formatting.

Windows notes:

- Tuna JSON path defaults to `%APPDATA%\\Tuna\\current.json` (override: `BF_TUNA_JSON_PATH`).

Auth:

- `X-BetterFluxer-Token: <token>`
- `Authorization: Bearer <token>`
- `?token=<token>`

Returns normalized JSON with keys like:

`ok`, `hasSession`, `source`, `title`, `artist`, `albumTitle`, `appId`, `playbackStatus`

## Bridge Console Commands

When bridge runs in a terminal, you can type:

- `help`
- `probe` (one-shot now-playing query)
- `last` (show last captured payload summary)
- `watch on` (poll every ~4s and print output)
- `watch off`
- `watch status`
- `rpc status`
- `tuna path`

## Allowlist

Default allowed domains:

- `raw.githubusercontent.com`
- `api.github.com`
- `githubusercontent.com`
- `web.fluxer.app`
- `*.fluxer.app`
- `*.fluxer.media`

Override with:

`BF_BRIDGE_ALLOWLIST=domain1,domain2,*.example.com`

## Cache

Responses are cached on disk:

`%APPDATA%\BetterFluxer\data\bridge-cache.json`

- default TTL: `120s` (`BF_BRIDGE_DEFAULT_TTL`)
- max TTL cap: `1800s` (`BF_BRIDGE_MAX_TTL`)

## Example

```bash
curl "http://127.0.0.1:21864/health"
```

```bash
curl "http://127.0.0.1:21864/fetch?type=json&url=https%3A%2F%2Fraw.githubusercontent.com%2FRoxyBoxxy%2FBetterFluxer%2Frefs%2Fheads%2Fmain%2Fplugins.json" ^
  -H "X-BetterFluxer-Token: <token>"
```
