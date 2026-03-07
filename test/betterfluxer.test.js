const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createBetterFluxer } = require("../src");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "betterfluxer-"));
}

function writePlugin(pluginRoot, name, content) {
  const pluginDir = path.join(pluginRoot, name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "manifest.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        main: "index.js"
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(path.join(pluginDir, "index.js"), content, "utf8");
}

test("loads plugin and persists storage", () => {
  const root = createTempDir();
  const pluginsPath = path.join(root, "plugins");
  const dataPath = path.join(root, "data");
  fs.mkdirSync(pluginsPath, { recursive: true });

  writePlugin(
    pluginsPath,
    "CounterPlugin",
    `
module.exports = class CounterPlugin {
  constructor(api) { this.api = api; }
  start() {
    const value = this.api.storage.get("count", 0) + 1;
    this.api.storage.set("count", value);
  }
  stop() {}
}
`
  );

  const runtime = createBetterFluxer({ rootPath: root, pluginsPath, dataPath });
  runtime.start();
  runtime.stop();

  const persisted = JSON.parse(fs.readFileSync(path.join(dataPath, "CounterPlugin.json"), "utf8"));
  assert.equal(persisted.count, 1);
});

test("patcher before/after/instead works and cleans up", () => {
  const root = createTempDir();
  const pluginsPath = path.join(root, "plugins");
  const dataPath = path.join(root, "data");
  fs.mkdirSync(pluginsPath, { recursive: true });

  writePlugin(
    pluginsPath,
    "PatchPlugin",
    `
module.exports = class PatchPlugin {
  constructor(api) { this.api = api; }
  start() {
    this.state = this.api.app.state;
    this.api.patcher.before(this.state, "sum", (args) => { args[0] = args[0] + 1; });
    this.api.patcher.after(this.state, "sum", (_args, result) => { this.state.lastResult = result; });
    this.api.patcher.instead(this.state, "mul", (args, original) => original(...args) * 10);
  }
  stop() { this.api.patcher.unpatchAll(); }
}
`
  );

  const appContext = {
    state: {
      lastResult: 0,
      sum(a, b) {
        return a + b;
      },
      mul(a, b) {
        return a * b;
      }
    }
  };

  const runtime = createBetterFluxer({ rootPath: root, pluginsPath, dataPath, appContext });
  runtime.start();

  assert.equal(appContext.state.sum(1, 2), 4);
  assert.equal(appContext.state.lastResult, 4);
  assert.equal(appContext.state.mul(2, 3), 60);

  runtime.stop();

  assert.equal(appContext.state.sum(1, 2), 3);
  assert.equal(appContext.state.mul(2, 3), 6);
});
