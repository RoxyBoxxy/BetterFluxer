# Runtime API

## `window.BetterFluxer`

### `listPlugins(): Array<{ id: string, enabled: boolean }>`
Returns loaded plugins and enabled state.

### `ui`
Live module instances for common app surfaces:
- `settingsSidebar`
- `userProfile`
- `messages`
- `guildList`
- `channels`
- `members` (alias: `userList`)
- `navigation`
- `modals`

Fluxer-focused helpers now include:
- tab resolution/open helpers in `settingsSidebar`
- channel and guild ID targeting helpers in `channels` / `guildList`
- visible member ID helpers in `members`
- route parsing and channel/DM navigation in `navigation`

### `classes`
Class constructors for building custom modules.

### `openSettings(tabName?: "plugins" | "settings"): void`
Opens BetterFluxer settings content inside Fluxer's settings right pane.

### `loadStoreIndex(): Promise<Array<{ id: string, name: string, url: string }>>`
Fetches remote plugin index from store URL.

### `installStorePlugin(item): Promise<boolean>`
Downloads and installs one store plugin.

### `removePlugin(pluginId: string): boolean`
Removes one installed plugin (runtime + persisted store copy).

### `getStoreItems(): Array<{ id: string, name: string, manifest?: string, url?: string }>`
Returns current store items.

### `getStoreError(): string | null`
Returns latest store error message.

### `getStoreRemoteError(): string | null`
Returns latest remote/network error detail.

### `getStoreIndexUrl(): string`
Returns current store index URL.

### `getStoreState(): { indexUrl: string, loading: boolean, error: string | null, remoteError: string | null, items: any[] }`
Returns full store runtime state snapshot.

### `setPluginEnabled(pluginId: string, enabled: boolean): boolean`
Enables or disables one plugin.

### `reloadPlugin(pluginId: string): boolean`
Reloads one plugin.

### `registerSettingsCategory(def: CategoryDef): string`
Registers a custom sidebar category and returns category id.

### `unregisterSettingsCategory(categoryId: string): boolean`
Removes a previously registered custom category.

### `listSettingsCategories(): Array<CategoryDef>`
Returns currently registered custom categories.

### `createCategorySkeleton(id?: string): CategoryDef`
Returns a starter object you can customize.

### `debugSettingsDOM(): object`
Logs and returns sidebar DOM probe info.

## `window.betterFluxerDebug`

Same debug-safe methods exposed into main world under context isolation:

- `openSettings`
- `loadStoreIndex`
- `installStorePlugin`
- `removePlugin`
- `getStoreItems`
- `getStoreError`
- `getStoreRemoteError`
- `getStoreIndexUrl`
- `getStoreState`
- `debugSettingsDOM`
- `ui`
- `classes`
- `userProfile`
- `messages`
- `guildList`
- `channels`
- `members` / `userList`
- `navigation`
- `modals`
- `settingsSidebar`
- `registerSettingsCategory`
- `unregisterSettingsCategory`
- `listSettingsCategories`
- `createCategorySkeleton`
- `listPlugins`

## `CategoryDef`

```ts
type CategoryDef = {
  id?: string;
  label?: string;
  items?: Array<{
    id?: string;
    label?: string;
    tab?: "plugins" | "settings" | string;
    onClick?: (ctx: { openSettings: (tabName?: string) => void; runtime: any }) => void;
  }>;
};
```
