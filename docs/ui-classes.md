# UI Classes

BetterFluxer now exposes reusable UI classes/modules to plugins.

## Access

From plugin `start()`:

```js
const { ui, classes } = this.api;
```

From DevTools:

```js
window.BetterFluxer.ui
window.BetterFluxer.classes
// or context-safe bridge:
window.betterFluxerDebug.ui
```

## Available modules (`api.ui`)

### `settingsSidebar`
- `getContainer()`
- `getItems()`
- `clickById(tabId)`

### `userProfile`
- `getSidebarName()`
- `openProfileSettings()`
- `getCurrentUser()`
- `getCurrentUserData()`
- `captureCurrentUser()`
- `fromDebugJson(jsonOrObject)`
- `onUpdate(callback)`
- `attachNetworkCapture()`

### `messages`
- `getComposer()`
- `getVisibleMessages()`
- `sendMessage(text)`

### `guildList`
- `getGuildItems()`
- `clickGuildByName(name)`

### `channels`
- `getChannelItems()`
- `clickChannelByName(name)`

## Class constructors (`api.classes`)

- `BaseDOMClass`
- `SettingsSidebarClass`
- `UserProfileClass`
- `MessagesClass`
- `GuildListClass`
- `ChannelsClass`

Use these if you want to build your own higher-level modules.

## BaseDOM helpers (`BaseDOMClass`)

- `query(selector, root?)`
- `queryAll(selector, root?)`
- `text(node)`

## User capture example

```js
// Paste full debug JSON string or object
const json = `{"id":"123","username":"test"}`;
window.BetterFluxer.ui.userProfile.fromDebugJson(json);
console.log(window.BetterFluxer.ui.userProfile.getCurrentUserData());
```

## Live update hook

```js
const off = window.BetterFluxer.ui.userProfile.onUpdate((snapshot) => {
  console.log("User updated from:", snapshot.source, snapshot.data);
});

// Later:
off();
```
