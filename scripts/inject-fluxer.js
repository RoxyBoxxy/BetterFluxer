#!/usr/bin/env node
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
  buildStoreIndexSnapshot
} = require("./lib/fluxer-injector-utils");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);
  const sourceRoot = path.resolve(args["source-root"] || path.join(__dirname, ".."));

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
  const storeIndexUrl =
    String(args["store-index-url"] || "https://raw.githubusercontent.com/RoxyBoxxy/BetterFluxer/refs/heads/main/plugins.json");
  const storeIndexSnapshot = await buildStoreIndexSnapshot(storeIndexUrl);
  // eslint-disable-next-line no-console
  console.log(`[BetterFluxer] Store snapshot items: ${storeIndexSnapshot.length}`);
  const mainPatchResult = patchMainIpcHandlers(paths.mainIpcHandlersPath, paths.backupMainIpcHandlersPath);
  const patchResult = patchPreload(paths.preloadPath, paths.backupPreloadPath, inlinePlugins, {
    enableIpcBridge: mainPatchResult && mainPatchResult.skipped !== true,
    storeIndexSnapshot
  });

  // eslint-disable-next-line no-console
  console.log(
    patchResult.changed
      ? "[BetterFluxer] Injection complete. Preload patched."
      : "[BetterFluxer] Injection complete. Preload already patched."
  );
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
