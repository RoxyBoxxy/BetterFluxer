const path = require("path");
const { contextBridge } = require("electron");
const { createBetterFluxer } = require("../index");

const runtime = createBetterFluxer({
  rootPath: path.join(process.resourcesPath, "betterfluxer"),
  appContext: {
    // Expose whatever internals Fluxer should make available to plugins.
  }
});

window.addEventListener("DOMContentLoaded", () => {
  runtime.start();
});

window.addEventListener("beforeunload", () => {
  runtime.stop();
});

contextBridge.exposeInMainWorld("BetterFluxer", {
  listPlugins: () => runtime.listPlugins(),
  reloadPlugin: (pluginId) => runtime.reloadPlugin(pluginId)
});
