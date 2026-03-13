#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  DEFAULT_INSTALL_ROOT,
  parseArgs,
  getFluxerAppPath,
  resolvePaths,
  unpatchPreload,
  unpatchMainIpcHandlers
} = require("./lib/fluxer-injector-utils");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);

  const appPath = getFluxerAppPath({
    appPath: args["app-path"],
    installRoot: args["install-root"] || DEFAULT_INSTALL_ROOT,
    version: args.version
  });

  const paths = resolvePaths(appPath);

  // eslint-disable-next-line no-console
  console.log(`[BetterFluxer] Target app: ${appPath}`);
  // eslint-disable-next-line no-console
  console.log(`[BetterFluxer] Preload: ${paths.preloadPath}`);
  // eslint-disable-next-line no-console
  console.log(`[BetterFluxer] Inject dir: ${paths.injectedRoot}`);

  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log("[BetterFluxer] Dry run complete. No files changed.");
    return;
  }

  const result = unpatchPreload(paths.preloadPath, paths.backupPreloadPath);
  unpatchMainIpcHandlers(paths.mainIpcHandlersPath, paths.backupMainIpcHandlersPath);
  if (fs.existsSync(paths.backupAsarPath)) {
    fs.copyFileSync(paths.backupAsarPath, paths.asarPath);
  }
  const legacyInjectorPath = path.join(paths.preloadDir, "betterfluxer.injector.js");
  if (fs.existsSync(legacyInjectorPath)) {
    fs.rmSync(legacyInjectorPath, { force: true });
  }

  if (fs.existsSync(paths.injectedRoot)) {
    fs.rmSync(paths.injectedRoot, { recursive: true, force: true });
  }

  // eslint-disable-next-line no-console
  console.log(
    result.restoredFromBackup
      ? "[BetterFluxer] Uninject complete. Preload restored from backup."
      : "[BetterFluxer] Uninject complete. Injection snippet removed if present."
  );
}

try {
  main();
} catch (error) {
  // eslint-disable-next-line no-console
  console.error("[BetterFluxer] Uninject failed:", error.message);
  process.exit(1);
}
