const path = require("path");
const { createBetterFluxer } = require("../src");

function resolveRuntimeRoot() {
  if (process.env.BETTERFLUXER_HOME) {
    return process.env.BETTERFLUXER_HOME;
  }
  return process.cwd();
}


const runtime = createBetterFluxer({
  rootPath: resolveRuntimeRoot(),
  appContext: {
    getWindow: () => window,
    getDocument: () => document,
    getLocation: () => window.location 
  }
});

window.addEventListener("DOMContentLoaded", () => {
  runtime.start();

  window.BetterFluxer = {
    listPlugins: () => runtime.listPlugins(),
    reloadPlugin: (pluginId) => runtime.reloadPlugin(pluginId)
  };
});

window.addEventListener("beforeunload", () => {
  runtime.stop();
});
