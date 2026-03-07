# Injector CLI

## Inject

```bash
npm run inject -- --app-path="C:\Users\<USERNAME>\AppData\Local\fluxer_app\app-0.0.8"
```

Options:

- `--app-path=<path>` explicit Fluxer app version folder
- `--install-root=<path>` install root containing `app-x.y.z` (or direct Fluxer app folder)
- `--version=<x.y.z>` pick specific version under install root
- `--source-root=<path>` BetterFluxer source folder
- `--store-index-url=<url>` override plugin store index snapshot URL during injection
- `--dry-run` no writes

Default install roots by OS:

- Windows: `%USERPROFILE%\AppData\Local\fluxer_app`
- Linux: `~/.fluxer/fluxer`, then `$XDG_DATA_HOME/fluxer_app`, then `$XDG_CONFIG_HOME/fluxer_app`, then `~/.config/Fluxer`
- macOS: `~/Library/Application Support/fluxer_app`

## Uninject

```bash
npm run uninject -- --app-path="C:\Users\<USERNAME>\AppData\Local\fluxer_app\app-0.0.8"
```

Restores preload from backup (if present) and removes injected runtime files.
