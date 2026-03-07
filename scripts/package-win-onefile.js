const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32" && String(command || "").toLowerCase().endsWith(".cmd"),
    ...options
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function resolvePkgBin(root) {
  const winBin = path.join(root, "node_modules", ".bin", "pkg.cmd");
  if (fs.existsSync(winBin)) return winBin;
  const unixBin = path.join(root, "node_modules", ".bin", "pkg");
  if (fs.existsSync(unixBin)) return unixBin;
  throw new Error("pkg binary not found. Run: npm i -D pkg");
}

function main() {
  if (process.platform !== "win32") {
    throw new Error("One-file build is Windows-only.");
  }

  const root = path.resolve(__dirname, "..");
  const distDir = path.join(root, "dist");
  fs.mkdirSync(distDir, { recursive: true });

  const nwZip = path.join(distDir, "nw-win64.zip");
  if (!fs.existsSync(nwZip)) {
    console.log("[BetterFluxer] NW zip not found. Building dist:win first...");
    run("node", [path.join(root, "scripts", "package-win.js")], { cwd: root });
  }

  if (!fs.existsSync(nwZip)) {
    throw new Error(`Expected NW runtime zip at ${nwZip}`);
  }

  const pkgBin = resolvePkgBin(root);
  const outputExe = path.join(distDir, "BetterFluxerInjector.exe");
  const launcherPath = path.join(root, "scripts", "onefile-launcher.js");
  const bundledZipPath = path.join(root, "scripts", "nw-win64.zip");
  const target = "node18-win-x64";
  fs.copyFileSync(nwZip, bundledZipPath);

  try {
    run(
      pkgBin,
      [
        launcherPath,
        "--targets",
        target,
        "--output",
        outputExe,
        "--public",
        "--compress",
        "GZip",
        "--assets",
        path.join("scripts", "nw-win64.zip")
      ],
      { cwd: root }
    );
  } finally {
    try {
      fs.rmSync(bundledZipPath, { force: true });
    } catch (_) {}
  }

  console.log(`[BetterFluxer] One-file EXE built: ${outputExe}`);
}

try {
  main();
} catch (error) {
  console.error("[BetterFluxer] One-file packaging failed:", error && error.message ? error.message : error);
  process.exitCode = 1;
}
