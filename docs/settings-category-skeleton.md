# Settings Category Skeleton

## Quick start (DevTools)

```js
const cat = window.betterFluxerDebug.createCategorySkeleton("my-tools");
cat.label = "MY TOOLS";
cat.items = [
  { id: "open-plugins", label: "Plugin Center", tab: "plugins" },
  { id: "open-settings", label: "Runtime Settings", tab: "settings" },
  {
    id: "custom-action",
    label: "Custom Action",
    onClick: ({ openSettings }) => {
      console.log("Custom menu clicked");
      openSettings("plugins");
    }
  }
];
window.betterFluxerDebug.registerSettingsCategory(cat);
```

## Remove category

```js
window.betterFluxerDebug.unregisterSettingsCategory("my-tools");
```

## From plugin code

```js
module.exports = class MyPlugin {
  constructor(api) {
    this.api = api;
    this.categoryId = null;
  }

  start() {
    this.categoryId = this.api.settings.registerCategory({
      id: "my-plugin-tools",
      label: "MY PLUGIN",
      items: [
        { id: "plugins", label: "Plugins", tab: "plugins" },
        { id: "settings", label: "Settings", tab: "settings" }
      ]
    });
  }

  stop() {
    if (this.categoryId) {
      this.api.settings.unregisterCategory(this.categoryId);
    }
  }
};
```
