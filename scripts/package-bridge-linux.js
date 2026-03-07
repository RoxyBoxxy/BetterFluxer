const fs = require("fs");
const path = require("path");

function copyRecursive(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function ensureCleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function loadNwBuilder() {
  try {
    const mod = require("nw-builder");
    return mod && typeof mod.default === "function" ? mod.default : mod;
  } catch (error) {
    throw new Error(
      `nw-builder is required for NW.js packaging. Run "npm i -D nw-builder". Details: ${
        error && error.message ? error.message : String(error)
      }`
    );
  }
}

function createStage(root) {
  const stageRoot = path.join(root, ".tmp-nw-bridge-stage-linux");
  ensureCleanDir(stageRoot);

  copyRecursive(path.join(root, "bridge-nw"), path.join(stageRoot, "bridge-nw"));
  copyRecursive(path.join(root, "scripts"), path.join(stageRoot, "scripts"));
  copyRecursive(path.join(root, "docs"), path.join(stageRoot, "docs"));

  const rootReadme = path.join(root, "README.md");
  if (fs.existsSync(rootReadme)) {
    fs.copyFileSync(rootReadme, path.join(stageRoot, "README.md"));
  }

  const bridgePkgPath = path.join(stageRoot, "bridge-nw", "package.json");
  const bridgePkg = JSON.parse(fs.readFileSync(bridgePkgPath, "utf8"));
  let appVersion = "1.0.0";
  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (rootPkg && typeof rootPkg.version === "string" && rootPkg.version.trim()) {
      appVersion = rootPkg.version.trim();
    }
  } catch (_) {}

  const iconPath =
    bridgePkg &&
    bridgePkg.window &&
    typeof bridgePkg.window.icon === "string" &&
    bridgePkg.window.icon.trim()
      ? bridgePkg.window.icon.trim()
      : "";

  const stagedPackage = {
    ...bridgePkg,
    name: bridgePkg.name || "betterfluxer-bridge",
    version: typeof bridgePkg.version === "string" && bridgePkg.version.trim() ? bridgePkg.version.trim() : appVersion,
    main: "bridge-nw/index.html",
    window: {
      ...(bridgePkg.window || {}),
      icon:
        iconPath && !iconPath.startsWith("bridge-nw/")
          ? `bridge-nw/${iconPath}`
          : iconPath || "bridge-nw/assets/betterfluxertransicon.png"
    }
  };
  fs.writeFileSync(path.join(stageRoot, "package.json"), `${JSON.stringify(stagedPackage, null, 2)}\n`, "utf8");

  return stageRoot;
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const outDir = path.join(root, "dist");
  fs.mkdirSync(outDir, { recursive: true });

  const stageRoot = createStage(root);
  const nwbuild = loadNwBuilder();
  const prevCwd = process.cwd();
  try {
    process.chdir(stageRoot);
    await nwbuild({
      mode: "build",
      srcDir: ["./**/*", "./bridge-nw/.env"],
      outDir: path.join(outDir, "nw-bridge-linux64"),
      platform: "linux",
      arch: "x64",
      zip: true,
      logLevel: "info"
    });
  } finally {
    process.chdir(prevCwd);
  }
  fs.rmSync(stageRoot, { recursive: true, force: true });
  console.log("[BetterFluxer Bridge] NW.js Linux build complete.");
}

main().catch((error) => {
  console.error(
    "[BetterFluxer Bridge] NW.js Linux packaging failed:",
    error && error.message ? error.message : error
  );
  process.exitCode = 1;
});
