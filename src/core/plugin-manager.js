const fs = require("fs");
const path = require("path");
const { createLogger } = require("./logger");
const { PluginStorage } = require("./plugin-storage");

function isDirectory(fullPath) {
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch (_) {
    return false;
  }
}

class PluginManager {
  constructor(options) {
    this.pluginsPath = options.pluginsPath;
    this.dataPath = options.dataPath;
    this.patcher = options.patcher;
    this.appContext = options.appContext || {};
    this.logger = createLogger("PluginManager");
    this.plugins = new Map();
  }

  startAll() {
    fs.mkdirSync(this.pluginsPath, { recursive: true });
    fs.mkdirSync(this.dataPath, { recursive: true });
    const entries = fs.readdirSync(this.pluginsPath);
    for (const entry of entries) {
      const pluginPath = path.join(this.pluginsPath, entry);
      if (!entry.endsWith(".js") && !isDirectory(pluginPath)) continue;
      this.load(pluginPath);
    }
  }

  stopAll() {
    for (const pluginId of this.plugins.keys()) {
      this.stop(pluginId);
    }
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      enabled: p.enabled,
      path: p.path,
      meta: p.meta
    }));
  }

  load(pluginPath) {
    const resolvedPath = path.resolve(pluginPath);
    const definition = this._resolvePluginDefinition(resolvedPath);
    const pluginId = definition.meta.name || path.basename(resolvedPath, path.extname(resolvedPath));

    if (this.plugins.has(pluginId)) {
      this.unload(pluginId);
    }

    const logger = createLogger(pluginId);
    const storage = new PluginStorage(this.dataPath, pluginId);
    const api = this._createApi(pluginId, logger, storage);

    let instance;
    if (typeof definition.exports === "function") {
      instance = new definition.exports(api);
    } else {
      instance = definition.exports;
    }

    if (!instance || typeof instance.start !== "function" || typeof instance.stop !== "function") {
      throw new Error(`Plugin ${pluginId} must expose start() and stop()`);
    }

    const pluginRecord = {
      id: pluginId,
      enabled: false,
      path: definition.entryPath,
      directoryPath: definition.directoryPath,
      modulePath: definition.modulePath,
      meta: definition.meta,
      instance
    };

    this.plugins.set(pluginId, pluginRecord);
    this.start(pluginId);
    logger.info("Loaded plugin", pluginId);
    return pluginRecord;
  }

  unload(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    this.stop(pluginId);
    this._clearRequireCache(plugin.modulePath);
    this.plugins.delete(pluginId);
  }

  reload(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);
    const sourcePath = plugin.directoryPath || plugin.path;
    this.unload(pluginId);
    return this.load(sourcePath);
  }

  start(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || plugin.enabled) return;
    plugin.instance.start();
    plugin.enabled = true;
  }

  stop(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || !plugin.enabled) return;
    try {
      plugin.instance.stop();
    } finally {
      this.patcher.unpatchAll(pluginId);
      plugin.enabled = false;
    }
  }

  _createApi(pluginId, logger, storage) {
    return {
      pluginId,
      logger,
      app: this.appContext,
      storage: {
        get: (key, fallback) => storage.get(key, fallback),
        set: (key, value) => storage.set(key, value),
        delete: (key) => storage.delete(key)
      },
      patcher: {
        before: (target, method, callback) => this.patcher.before(pluginId, target, method, callback),
        after: (target, method, callback) => this.patcher.after(pluginId, target, method, callback),
        instead: (target, method, callback) => this.patcher.instead(pluginId, target, method, callback),
        unpatchAll: () => this.patcher.unpatchAll(pluginId)
      }
    };
  }

  _resolvePluginDefinition(inputPath) {
    if (isDirectory(inputPath)) {
      const manifestPath = path.join(inputPath, "manifest.json");
      let manifest = {};

      if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      }

      const mainFile = manifest.main || "index.js";
      const modulePath = path.join(inputPath, mainFile);
      this._clearRequireCache(modulePath);
      const exportsObject = require(modulePath);

      return {
        exports: exportsObject,
        entryPath: inputPath,
        directoryPath: inputPath,
        modulePath,
        meta: {
          name: manifest.name || path.basename(inputPath),
          version: manifest.version || "0.0.0",
          description: manifest.description || "",
          author: manifest.author || ""
        }
      };
    }

    this._clearRequireCache(inputPath);
    const exportsObject = require(inputPath);
    const inferredName = path.basename(inputPath, path.extname(inputPath));

    return {
      exports: exportsObject,
      entryPath: inputPath,
      directoryPath: null,
      modulePath: inputPath,
      meta: {
        name: inferredName,
        version: "0.0.0",
        description: "",
        author: ""
      }
    };
  }

  _clearRequireCache(modulePath) {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
  }
}

module.exports = {
  PluginManager
};
