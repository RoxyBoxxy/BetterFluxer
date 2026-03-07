const path = require("path");
const { Patcher } = require("./core/patcher");
const { PluginManager } = require("./core/plugin-manager");
const { createLogger } = require("./core/logger");

class BetterFluxer {
  constructor(options = {}) {
    this.rootPath = options.rootPath || process.cwd();
    this.pluginsPath = options.pluginsPath || path.join(this.rootPath, "plugins");
    this.dataPath = options.dataPath || path.join(this.rootPath, "data");
    this.logger = createLogger("Core");
    this.patcher = new Patcher();
    this.pluginManager = new PluginManager({
      pluginsPath: this.pluginsPath,
      dataPath: this.dataPath,
      patcher: this.patcher,
      appContext: options.appContext || {}
    });
  }

  start() {
    this.logger.info("Starting BetterFluxer runtime");
    this.pluginManager.startAll();
  }

  stop() {
    this.logger.info("Stopping BetterFluxer runtime");
    this.pluginManager.stopAll();
  }

  listPlugins() {
    return this.pluginManager.list();
  }

  reloadPlugin(pluginId) {
    return this.pluginManager.reload(pluginId);
  }
}

function createBetterFluxer(options = {}) {
  return new BetterFluxer(options);
}

module.exports = {
  BetterFluxer,
  createBetterFluxer
};
