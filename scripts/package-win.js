const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function copyRecursive(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function copyPluginsIntoStage(root, stageRoot) {
  const rootPlugins = path.join(root, "plugins");
  const nwPlugins = path.join(root, "nw", "plugins");
  const stagePlugins = path.join(stageRoot, "plugins");
  if (fs.existsSync(rootPlugins)) {
    copyRecursive(rootPlugins, stagePlugins);
    return;
  }
  if (fs.existsSync(nwPlugins)) {
    copyRecursive(nwPlugins, stagePlugins);
    return;
  }
  fs.mkdirSync(stagePlugins, { recursive: true });
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function pruneLocales(buildDir) {
  const localesDir = path.join(buildDir, "locales");
  if (!fs.existsSync(localesDir)) return;
  const keep = new Set(["en-US.pak"]);
  for (const name of fs.readdirSync(localesDir)) {
    if (!keep.has(name)) {
      fs.rmSync(path.join(localesDir, name), { force: true, recursive: true });
    }
  }
}

function pruneUnneededFiles(buildDir) {
  const removable = ["credits.html"];
  for (const name of removable) {
    const target = path.join(buildDir, name);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true, recursive: true });
    }
  }
}

function createZipFromBuildDir(buildDir, zipPath) {
  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath, { force: true });
  }
  run(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -Path '${buildDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
    ]
  );
}

function createStage(root, outDir) {
  const stageRoot = path.join(root, ".tmp-nw-stage-win");
  ensureCleanDir(stageRoot);

  copyRecursive(path.join(root, "nw"), path.join(stageRoot, "nw"));
  copyRecursive(path.join(root, "scripts"), path.join(stageRoot, "scripts"));
  copyPluginsIntoStage(root, stageRoot);
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
  const buildOutDir = path.join(outDir, "nw-win64");
  const zipOutPath = path.join(outDir, "nw-win64.zip");
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
      outDir: buildOutDir,
      platform: "win",
      arch: "x64",
      flavor: "normal",
      winIco: "./nw/assets/betterfluxertransicon.ico",
      zip: false,
      logLevel: "info"
    });
  } finally {
    process.chdir(prevCwd);
  }
  pruneLocales(buildOutDir);
  pruneUnneededFiles(buildOutDir);
  createZipFromBuildDir(buildOutDir, zipOutPath);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  console.log("[BetterFluxer] NW.js Windows build complete.");
}

main().catch((error) => {
  console.error("[BetterFluxer] NW.js Windows packaging failed:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
