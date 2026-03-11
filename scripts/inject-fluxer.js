#!/usr/bin/env node
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const {
  DEFAULT_INSTALL_ROOT,
  parseArgs,
  getFluxerAppPath,
  resolvePaths,
  ensureFileExists,
  copyRuntime,
  ensureLinuxSafeLauncher,
  writeBootstrap,
  collectInlinePlugins,
  patchPreload,
  patchMainIpcHandlers,
  patchPackagedMainBundle,
  resolveSourceDesktopMainBundle,
  buildStoreIndexSnapshot,
  getDefaultSplashIconDataUrl,
  DEFAULT_SPLASH_PULSE_COLOR
} = require("./lib/fluxer-injector-utils");

function getBetterFluxerVersion(sourceRoot) {
  try {
    const res = require("child_process").spawnSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: sourceRoot,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      encoding: "utf8"
    });
    if (!res.error && res.status === 0) {
      const tag = String(res.stdout || "").trim();
      if (tag) return tag;
    }
  } catch (_) {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
    if (pkg && typeof pkg.version === "string" && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch (_) {}
  return "dev";
}

function computeInjectorChecksum(version, inlinePlugins) {
  try {
    const payload = JSON.stringify(inlinePlugins || []);
    return crypto.createHash("sha256").update(String(version || "dev")).update("\n").update(payload).digest("hex").slice(0, 12);
  } catch (_) {
    return "";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);
  const sourceRoot = path.resolve(args["source-root"] || path.join(__dirname, ".."));
  const defaultSplashIconDataUrl = getDefaultSplashIconDataUrl(sourceRoot);
  const defaultSplashPulseColor = DEFAULT_SPLASH_PULSE_COLOR;

  const appPath = getFluxerAppPath({
    appPath: args["app-path"],
    installRoot: args["install-root"] || DEFAULT_INSTALL_ROOT,
    version: args.version
  });

  const paths = resolvePaths(appPath);
  ensureFileExists(paths.preloadPath, "Fluxer preload entry");

  // eslint-disable-next-line no-console
  console.log(`[BetterFluxer] Target app: ${appPath}`);
  // eslint-disable-next-line no-console
  console.log(`[BetterFluxer] Source root: ${sourceRoot}`);
  // eslint-disable-next-line no-console
  console.log(`[BetterFluxer] Preload: ${paths.preloadPath}`);
  // eslint-disable-next-line no-console
  console.log(`[BetterFluxer] Inject dir: ${paths.injectedRoot}`);

  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log("[BetterFluxer] Dry run complete. No files changed.");
    return;
  }

  copyRuntime(sourceRoot, paths.injectedRoot);
  const launcherPath = ensureLinuxSafeLauncher(appPath);
  writeBootstrap(paths.bootstrapPath);
  const inlinePlugins = collectInlinePlugins(sourceRoot);
  const betterFluxerVersion = getBetterFluxerVersion(sourceRoot);
  const betterFluxerChecksum = computeInjectorChecksum(betterFluxerVersion, inlinePlugins);
  const storeIndexUrl =
    String(args["store-index-url"] || "https://raw.githubusercontent.com/RoxyBoxxy/BetterFluxer/refs/heads/main/plugins.json");
  const storeIndexSnapshot = await buildStoreIndexSnapshot(storeIndexUrl);
  // eslint-disable-next-line no-console
  console.log(`[BetterFluxer] Store snapshot items: ${storeIndexSnapshot.length}`);
  const mainPatchResult = patchMainIpcHandlers(paths.mainIpcHandlersPath, paths.backupMainIpcHandlersPath);
  let packagedMainPatchResult = { changed: false, skipped: true, reason: "non-linux" };
  if (process.platform === "linux") {
    const sourceDesktopMainBundle = resolveSourceDesktopMainBundle(sourceRoot);
    if (!sourceDesktopMainBundle) {
      throw new Error(
        "Linux prebuilt desktop bundle not found. Commit do_not_edit/fluxer/fluxer_desktop/dist/main/index.js before shipping the injector."
      );
    }
    packagedMainPatchResult = await patchPackagedMainBundle(
      paths.asarPath,
      paths.backupAsarPath,
      sourceDesktopMainBundle,
      sourceRoot
    );
  }
  const patchResult = patchPreload(paths.preloadPath, paths.backupPreloadPath, inlinePlugins, {
    enableIpcBridge: mainPatchResult && mainPatchResult.skipped !== true,
    storeIndexSnapshot,
    betterFluxerVersion,
    betterFluxerChecksum,
    customSplashIconDataUrl: String(args["custom-splash-icon-data-url"] || defaultSplashIconDataUrl),
    customSplashPulseColor: String(args["custom-splash-pulse-color"] || defaultSplashPulseColor)
  });

  // eslint-disable-next-line no-console
  console.log(
    patchResult.changed
      ? "[BetterFluxer] Injection complete. Preload patched."
      : "[BetterFluxer] Injection complete. Preload already patched."
  );
  if (packagedMainPatchResult && packagedMainPatchResult.changed) {
    // eslint-disable-next-line no-console
    console.log("[BetterFluxer] Packaged main bundle patched.");
  }
  if (launcherPath) {
    // eslint-disable-next-line no-console
    console.log(`[BetterFluxer] Linux launcher: ${launcherPath}`);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[BetterFluxer] Injection failed:", error.message);
  process.exit(1);
});
