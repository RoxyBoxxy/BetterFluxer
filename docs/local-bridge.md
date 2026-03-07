# Local Bridge

Runs a localhost-only companion service for plugins to fetch remote data safely.

## Start

```bash
npm run bridge:start
```

Server:

- Host: `127.0.0.1`
- Port: `21864` (override with `BF_BRIDGE_PORT`)

## Windows Startup / Hidden Mode

Install startup (Windows only):

```bash
npm run bridge:startup:install
```

Remove startup:

```bash
npm run bridge:startup:remove
```

The startup entry launches bridge hidden using a Startup-folder VBS launcher.
For packaged EXE builds, startup install copies bridge to:

`%APPDATA%\BetterFluxer\bridge\BetterFluxerBridge.exe`

Manual hidden run:

```bash
node bridge/index.js --hidden
```

On first start it generates a token in:

`%APPDATA%\BetterFluxer\data\bridge-token.txt`

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

Removed. Bridge no longer uses Windows media APIs.
Use `GET /now-playing` (Discord RPC + Tuna sources).

### `GET /now-playing`

Universal now-playing endpoint with platform adapters:

- Windows: installed/running app detection + Tuna JSON
- Linux: MPRIS via `playerctl`
- macOS: AppleScript (`Spotify`/`Music`)
- Discord RPC pipes: captures `SET_ACTIVITY`/`CLEAR_ACTIVITY` from apps connecting to `discord-ipc-*` (when bridge can bind those pipes)
  - Game activities (`type: 0`) are tagged as `kind: "game"` for BetterFluxer status formatting.
- Optional master relay over WebSocket (`BF_MASTER_WS_URL`)
- Optional bridge-to-bridge P2P gossip (`BF_P2P_ENABLED=1`)

Windows fallback:

- If GSMTC fails with `Class not registered`, bridge falls back to Tuna JSON file source.
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
- `master status`
- `p2p status`
- `tuna path`

`p2p status` now shows:

- connected peers count
- per-peer bytes in/out
- total bytes in/out
- rolling 1-minute average bandwidth (B/s in/out)

## P2P Bridge Mesh (TCP Gossip)

Enable:

`BF_P2P_ENABLED=1`

Optional settings:

- `BF_P2P_HOST` (default `0.0.0.0`)
- `BF_P2P_PORT` (default `21911`)
- `BF_P2P_PEERS` (comma list, e.g. `10.0.0.2:21911,10.0.0.3:21911`)
- `BF_P2P_ANNOUNCE_HOST` (public/reachable host or IP announced to peers)
- `BF_P2P_GOSSIP_TTL_SEC` (default `30`)
- `BF_MASTER_USER_ID` / `BF_USER_ID` (optional filter for activity user)

Notes:

- This is direct TCP peer gossip, no central server required.
- NAT/firewall still applies; for internet peers, use reachable IP/port forwarding.

## libp2p Mesh (Bootstrap + Relay)

Enable:

`BF_LIBP2P_ENABLED=1`

Settings:

- `BF_LIBP2P_HOST` (default `0.0.0.0`)
- `BF_LIBP2P_PORT` (default `21921`)
- `BF_LIBP2P_TOPIC` (default `betterfluxer/activity/1`)
- `BF_LIBP2P_BOOTSTRAP` (comma-separated libp2p multiaddrs)
- `BF_LIBP2P_RELAYS` (comma-separated relay multiaddrs)
- `BF_MASTER_USER_ID` / `BF_USER_ID` (optional activity user filter)

Console:

- `libp2p status` for connectivity and traffic counters.

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
