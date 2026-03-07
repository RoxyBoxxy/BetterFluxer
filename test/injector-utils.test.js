const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { getDefaultInstallRoots, getFluxerAppPath } = require("../scripts/lib/fluxer-injector-utils");

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "betterfluxer-injector-"));
}

test("getDefaultInstallRoots returns linux defaults in priority order", () => {
  const roots = getDefaultInstallRoots("linux");
  assert.ok(Array.isArray(roots));
  assert.ok(roots.length >= 2);
  assert.match(roots[0], /\.fluxer[\/\\]fluxer$/);
  assert.match(roots[1], /fluxer_app$/);
});

test("getFluxerAppPath supports direct app folder layout", () => {
  const root = createTempDir();
  const preloadPath = path.join(root, "resources", "app.asar.unpacked", "src-electron", "dist", "preload", "index.js");
  fs.mkdirSync(path.dirname(preloadPath), { recursive: true });
  fs.writeFileSync(preloadPath, "// preload", "utf8");

  const appPath = getFluxerAppPath({ installRoot: root });
  assert.equal(appPath, root);
});

test("getFluxerAppPath picks latest app version folder", () => {
  const installRoot = createTempDir();
  fs.mkdirSync(path.join(installRoot, "app-0.0.8"), { recursive: true });
  fs.mkdirSync(path.join(installRoot, "app-0.0.9"), { recursive: true });

  const appPath = getFluxerAppPath({ installRoot });
  assert.equal(appPath, path.join(installRoot, "app-0.0.9"));
});
