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
- `resolveTabId(idOrLabel)`
- `clickById(tabId)`
- `clickByLabel(label)`
- `openTab(idOrLabel)`
- `getApplicationItems()`

### `userProfile`
- `getSidebarName()`
- `openProfileSettings()`
- `getCurrentUser()`
- `getCurrentUserData()`
- `getCurrentUserId()`
- `captureCurrentUser()`
- `fromDebugJson(jsonOrObject)`
- `onUpdate(callback)`
- `attachNetworkCapture()`

### `messages`
- `getComposer()`
- `getVisibleMessages()`
- `getVisibleMessageIds()`
- `getLastVisibleMessage()`
- `sendMessage(text)`

### `guildList`
- `getGuildItems()`
- `clickGuildByName(name)`
- `clickGuildById(guildId)`

### `channels`
- `getChannelItems()`
- `clickChannelByName(name)`
- `getCurrentRoute()`
- `getCurrentGuildId()`
- `getCurrentChannelId()`
- `clickChannelById(channelId, guildId?)`

### `members` / `userList`
- `getMemberItems()`
- `clickMemberByName(name)`
- `getVisibleMemberIds()`
- `getMemberById(userId)`
- `clickMemberById(userId)`

### `navigation`
- `getCurrentPath()`
- `navigateTo(pathName)`
- `parseRoute(pathName?)`
- `navigateToChannel(guildId, channelId)`
- `navigateToDm(channelId)`

### `modals`
- `getOpenModals()`
- `closeTopModal()`

## Class constructors (`api.classes`)

- `BaseDOMClass`
- `SettingsSidebarClass`
- `UserProfileClass`
- `MessagesClass`
- `GuildListClass`
- `ChannelsClass`
- `MembersClass`
- `NavigationClass`
- `ModalsClass`

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
