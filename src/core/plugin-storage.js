const fs = require("fs");
const path = require("path");

class PluginStorage {
  constructor(basePath, pluginId) {
    this.basePath = basePath;
    this.pluginId = pluginId;
    this.filePath = path.join(basePath, `${pluginId}.json`);
    this.data = {};
    this._load();
  }

  get(key, fallback = null) {
    return this.data[key] ?? fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  delete(key) {
    delete this.data[key];
    this.save();
  }

  save() {
    fs.mkdirSync(this.basePath, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.data = JSON.parse(raw);
    } catch (_) {
      this.data = {};
    }
  }
}

module.exports = {
  PluginStorage
};
