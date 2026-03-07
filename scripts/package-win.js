const path = require("path");
const packager = require("@electron/packager");

async function main() {
  const root = path.resolve(__dirname, "..");
  const outDir = path.join(root, "dist");

  const ignorePatterns = [
    /(^|[\\/])\.git([\\/]|$)/,
    /(^|[\\/])dist([\\/]|$)/,
    /(^|[\\/])tmp_asar([\\/]|$)/,
    /(^|[\\/])tmp_full_asar([\\/]|$)/,
    /(^|[\\/])app_do_not_edit([\\/]|$)/,
    /(^|[\\/])data([\\/]|$)/,
    /(^|[\\/])test([\\/]|$)/
  ];

  const appPaths = await packager({
    dir: root,
    out: outDir,
    overwrite: true,
    prune: true,
    platform: "win32",
    arch: "x64",
    asar: true,
    name: "BetterFluxer Injector",
    executableName: "BetterFluxerInjector",
    ignore: (fullPath) => ignorePatterns.some((pattern) => pattern.test(fullPath))
  });

  for (const appPath of appPaths) {
    console.log(`[BetterFluxer] Packaged: ${appPath}`);
    console.log(`[BetterFluxer] EXE: ${path.join(appPath, "BetterFluxerInjector.exe")}`);
  }
}

main().catch((error) => {
  console.error("[BetterFluxer] Packaging failed:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
