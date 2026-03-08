const path = require("path");
const { Patcher } = require("./core/patcher");
const { PluginManager } = require("./core/plugin-manager");
const { createLogger } = require("./core/logger");
const { createUIApi } = require("./core/ui-classes");

class BetterFluxer {
  constructor(options = {}) {
    this.rootPath = options.rootPath || process.cwd();
    this.pluginsPath = options.pluginsPath || path.join(this.rootPath, "plugins");
    this.dataPath = options.dataPath || path.join(this.rootPath, "data");
    this.logger = createLogger("Core");
    this.patcher = new Patcher();
    const uiApi = createUIApi(options.appContext || {});
    this.ui = uiApi.ui;
    this.classes = uiApi.classes;
    this.pluginManager = new PluginManager({
      pluginsPath: this.pluginsPath,
      dataPath: this.dataPath,
      patcher: this.patcher,
      appContext: options.appContext || {},
      ui: this.ui,
      classes: this.classes
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

  getPublicApi() {
    return {
      listPlugins: () => this.listPlugins(),
      reloadPlugin: (pluginId) => this.reloadPlugin(pluginId),
      ui: this.ui,
      classes: this.classes
    };
  }
}

function createBetterFluxer(options = {}) {
  return new BetterFluxer(options);
}

module.exports = {
  BetterFluxer,
  createBetterFluxer
};
