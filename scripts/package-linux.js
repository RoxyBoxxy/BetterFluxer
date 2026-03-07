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

function createStage(root, outDir) {
  const stageRoot = path.join(root, ".tmp-nw-stage-linux");
  ensureCleanDir(stageRoot);

  copyRecursive(path.join(root, "nw"), path.join(stageRoot, "nw"));
  copyRecursive(path.join(root, "scripts"), path.join(stageRoot, "scripts"));
  copyRecursive(path.join(root, "plugins"), path.join(stageRoot, "plugins"));
  copyRecursive(path.join(root, "src"), path.join(stageRoot, "src"));
  copyRecursive(path.join(root, "docs"), path.join(stageRoot, "docs"));

  const rootReadme = path.join(root, "README.md");
  if (fs.existsSync(rootReadme)) {
    fs.copyFileSync(rootReadme, path.join(stageRoot, "README.md"));
  }

  const nwPackagePath = path.join(stageRoot, "nw", "package.json");
  const nwPackage = JSON.parse(fs.readFileSync(nwPackagePath, "utf8"));
  let appVersion = "1.0.0";
  try {
    const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (rootPackage && typeof rootPackage.version === "string" && rootPackage.version.trim()) {
      appVersion = rootPackage.version.trim();
    }
  } catch (_) {}
  const iconPath =
    nwPackage &&
    nwPackage.window &&
    typeof nwPackage.window.icon === "string" &&
    nwPackage.window.icon.trim()
      ? nwPackage.window.icon.trim()
      : "";
  const stagedPackage = {
    ...nwPackage,
    main: "nw/index.html",
    version: typeof nwPackage.version === "string" && nwPackage.version.trim() ? nwPackage.version.trim() : appVersion,
    window: {
      ...(nwPackage.window || {}),
      icon: iconPath && !iconPath.startsWith("nw/") ? `nw/${iconPath}` : iconPath || "nw/assets/betterfluxertransicon.png"
    }
  };
  fs.writeFileSync(path.join(stageRoot, "package.json"), `${JSON.stringify(stagedPackage, null, 2)}\n`, "utf8");

  return stageRoot;
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const outDir = path.join(root, "dist");
  fs.mkdirSync(outDir, { recursive: true });

  const stageRoot = createStage(root, outDir);
  const nwbuild = loadNwBuilder();
  const prevCwd = process.cwd();
  try {
    process.chdir(stageRoot);
    await nwbuild({
      mode: "build",
      srcDir: [
        "./**/*",
        "./nw/.env"
      ],
      outDir: path.join(outDir, "nw-linux64"),
      platform: "linux",
      arch: "x64",
      zip: true,
      logLevel: "info"
    });
  } finally {
    process.chdir(prevCwd);
  }
  fs.rmSync(stageRoot, { recursive: true, force: true });
  console.log("[BetterFluxer] NW.js Linux build complete.");
}

main().catch((error) => {
  console.error("[BetterFluxer] NW.js Linux packaging failed:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
