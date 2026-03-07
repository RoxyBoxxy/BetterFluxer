const fs = require("fs")
const https = require("https");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const {
  DEFAULT_INSTALL_ROOTS,
  resolveInstallRoot,
  getInstalledVersions,
  getFluxerAppPath,
  getInjectionStatus,
  resolvePaths,
  ensureFileExists,
  copyRuntime,
  ensureLinuxSafeLauncher,
  writeBootstrap,
  collectInlinePlugins,
  patchPreload,
  unpatchPreload,
  patchMainIpcHandlers,
  unpatchMainIpcHandlers,
  buildStoreIndexSnapshot
} = require("../scripts/lib/fluxer-injector-utils");

const execFileAsync = promisify(execFile);
const SOURCE_ROOT = path.resolve(process.cwd(), "..");
const POSIX_PROCESS_NAMES = ["Fluxer", "fluxer", "fluxer_app"];
const POSIX_FALLBACK_PATTERN = "fluxer";
const LINUX_INSTALL_ROOT = path.join(os.homedir(), ".fluxer");
const LINUX_APP_PATH = path.join(LINUX_INSTALL_ROOT, "fluxer");
const LINUX_DESKTOP_ENTRY_PATH = path.join(os.homedir(), ".local", "share", "applications", "fluxer.desktop");
const LINUX_LATEST_APPIMAGE_URL = "https://api.fluxer.app/dl/desktop/stable/linux/x64/latest/appimage";
const LINUX_DOWNLOADS_DIR = path.join(LINUX_INSTALL_ROOT, "downloads");
const LINUX_DOWNLOADED_APPIMAGE_PATH = path.join(LINUX_DOWNLOADS_DIR, "fluxer-latest-x64.AppImage");
const DEFAULT_STORE_INDEX_URL = "https://raw.githubusercontent.com/RoxyBoxxy/BetterFluxer/refs/heads/main/plugins.json";

async function runOptionalExec(command, args) {
  try {
    return await execFileAsync(command, args);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function removePathBestEffort(targetPath) {
  if (!targetPath) return;
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return;
  } catch (_) {
    // fall through to shell fallback for odd AppImage trees
  }

  try {
    await execFileAsync("rm", ["-rf", targetPath]);
  } catch (_) {
    // best-effort cleanup only
  }
}

function isProcessMissingError(error) {
  return Number(error && error.code) === 1;
}

function parsePidLines(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => Number.parseInt(line.split(/\s+/)[0], 10))
    .filter(Number.isInteger);
}

function uniqNumbers(list) {
  return [...new Set((list || []).filter(Number.isInteger))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeAppImage(value) {
  return /\.AppImage$/i.test(String(value || ""));
}

function sanitizeCmdToken(value) {
  if (!value) return "";
  return String(value).replace(/\0/g, "").trim();
}

function getCandidateAppPathFromResourcePath(resourcePath) {
  const marker = `${path.sep}resources${path.sep}`;
  const idx = String(resourcePath || "").indexOf(marker);
  if (idx <= 0) return null;
  return String(resourcePath).slice(0, idx);
}

function getCandidateAppPathFromCmdTokens(tokens) {
  for (const token of tokens || []) {
    if (token.startsWith("--app-path=")) {
      const rawValue = token.slice("--app-path=".length).trim();
      if (rawValue) {
        const maybeAppPath = getCandidateAppPathFromResourcePath(rawValue);
        return maybeAppPath || rawValue;
      }
    }
  }

  for (const token of tokens || []) {
    const maybeAppPath = getCandidateAppPathFromResourcePath(token);
    if (maybeAppPath) return maybeAppPath;
  }

  return null;
}

function isValidFluxerAppPath(appPath) {
  if (!appPath) return false;
  const normalized = path.resolve(appPath);
  const preloadPath = resolvePaths(normalized).preloadPath;
  return fs.existsSync(preloadPath);
}

function collectAncestorDirs(inputPath) {
  const out = [];
  let current = inputPath ? path.resolve(inputPath) : null;
  while (current && !out.includes(current)) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function detectFluxerAppPathFromCandidates(candidates) {
  for (const candidate of candidates || []) {
    if (!candidate) continue;
    const roots = collectAncestorDirs(candidate);
    for (const root of roots) {
      if (isValidFluxerAppPath(root)) {
        return path.resolve(root);
      }
    }
  }
  return null;
}

function canWriteToAppPath(appPath) {
  if (!appPath) return false;
  try {
    const preloadPath = resolvePaths(appPath).preloadPath;
    fs.accessSync(preloadPath, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function getPosixFluxerPids() {
  const hasPgrep = await runOptionalExec("pgrep", ["-V"]);
  if (!hasPgrep) return [];

  const pids = [];
  for (const name of POSIX_PROCESS_NAMES) {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-x", name]);
      pids.push(...parsePidLines(stdout));
    } catch (error) {
      if (!isProcessMissingError(error)) throw error;
    }
  }

  if (pids.length === 0) {
    try {
      const { stdout } = await execFileAsync("pgrep", ["-fi", POSIX_FALLBACK_PATTERN]);
      pids.push(...parsePidLines(stdout));
    } catch (error) {
      if (!isProcessMissingError(error)) throw error;
    }
  }

  const unique = uniqNumbers(pids);
  const filtered = [];

  for (const pid of unique) {
    const commandTokens = readProcCommandLine(pid);
    const exePath = readProcLink(pid, "exe");
    if (isInjectorProcess(pid, commandTokens, exePath)) continue;
    if (!looksLikeFluxerProcess(commandTokens, exePath)) continue;
    filtered.push(pid);
  }

  return uniqNumbers(filtered);
}

function readProcCommandLine(pid) {
  const cmdPath = path.join("/proc", String(pid), "cmdline");
  try {
    const raw = fs.readFileSync(cmdPath);
    return raw
      .toString("utf8")
      .split("\u0000")
      .map((item) => sanitizeCmdToken(item))
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function readProcEnviron(pid) {
  const envPath = path.join("/proc", String(pid), "environ");
  try {
    const raw = fs.readFileSync(envPath);
    const vars = {};
    raw
      .toString("utf8")
      .split("\u0000")
      .filter(Boolean)
      .forEach((entry) => {
        const eq = entry.indexOf("=");
        if (eq <= 0) return;
        const key = entry.slice(0, eq);
        const value = entry.slice(eq + 1);
        vars[key] = value;
      });
    return vars;
  } catch (_) {
    return {};
  }
}

function readProcLink(pid, name) {
  try {
    return fs.readlinkSync(path.join("/proc", String(pid), name));
  } catch (_) {
    return null;
  }
}

function isInjectorProcess(pid, commandTokens, exePath) {
  if (pid === process.pid || pid === process.ppid) return true;
  const joined = String((commandTokens || []).join(" ")).toLowerCase();
  const exe = String(exePath || "").toLowerCase();
  const sourceRoot = String(SOURCE_ROOT || "").toLowerCase();
  return (
    joined.includes("betterfluxer") ||
    joined.includes("injector-main.js") ||
    joined.includes("electron/injector") ||
    exe.includes("betterfluxer") ||
    (sourceRoot && (joined.includes(sourceRoot) || exe.includes(sourceRoot)))
  );
}

function looksLikeFluxerProcess(commandTokens, exePath) {
  const tokens = commandTokens || [];
  const joined = String(tokens.join(" ")).toLowerCase();
  const exe = String(exePath || "").toLowerCase();
  if (joined.includes("fluxer") || exe.includes("fluxer")) return true;
  if (looksLikeAppImage(exe)) return true;
  return tokens.some((token) => looksLikeAppImage(token));
}

async function getFluxerProcessInfo() {
  if (process.platform === "win32") {
    const running = await isFluxerRunning();
    return {
      running,
      pids: [],
      appImagePath: null,
      appPath: null
    };
  }

  if (process.platform !== "linux" && process.platform !== "darwin") {
    return {
      running: false,
      pids: [],
      appImagePath: null,
      appPath: null
    };
  }

  const pids = await getPosixFluxerPids();
  const info = {
    running: pids.length > 0,
    pids,
    appImagePath: null,
    appPath: null,
    exePath: null,
    cwd: null,
    command: []
  };

  for (const pid of pids) {
    const command = readProcCommandLine(pid);
    const envVars = readProcEnviron(pid);
    const exePath = readProcLink(pid, "exe");
    const cwd = readProcLink(pid, "cwd");
    const appImagePath =
      sanitizeCmdToken(envVars.APPIMAGE) ||
      command.find((item) => looksLikeAppImage(item)) ||
      (looksLikeAppImage(exePath) ? exePath : null);
    const cmdAppPath = getCandidateAppPathFromCmdTokens(command);
    const detectedAppPath = detectFluxerAppPathFromCandidates([
      cmdAppPath,
      cwd,
      exePath ? path.dirname(exePath) : null
    ]);

    if (!info.exePath && exePath) info.exePath = exePath;
    if (!info.cwd && cwd) info.cwd = cwd;
    if (info.command.length === 0 && command.length > 0) info.command = command;
    if (!info.appImagePath && appImagePath) info.appImagePath = appImagePath;
    if (!info.appPath && detectedAppPath) info.appPath = path.resolve(detectedAppPath);
  }

  return info;
}

function getDesktopIconPath(appPath) {
  const candidates = [
    path.join(appPath, ".DirIcon"),
    path.join(appPath, "usr", "share", "icons", "hicolor", "512x512", "apps", "fluxer.png"),
    path.join(appPath, "usr", "share", "icons", "hicolor", "256x256", "apps", "fluxer.png"),
    path.join(appPath, "usr", "share", "pixmaps", "fluxer.png")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function createLinuxLaunchWrapper(appPath) {
  const wrapperPath = path.join(appPath, "fluxer-launch.sh");
  const script = [
    "#!/usr/bin/env sh",
    "set -eu",
    "",
    "# Force a stable Linux software-rendered launch path.",
    "export ELECTRON_OZONE_PLATFORM_HINT=\"${ELECTRON_OZONE_PLATFORM_HINT:-x11}\"",
    "export OZONE_PLATFORM=\"${OZONE_PLATFORM:-x11}\"",
    "export GDK_BACKEND=\"${GDK_BACKEND:-x11}\"",
    "",
    "APP_RUN=\"$(dirname \"$0\")/AppRun\"",
    "exec \"$APP_RUN\" --disable-gpu --disable-gpu-sandbox --use-gl=swiftshader \"$@\""
  ].join("\n");
  fs.writeFileSync(wrapperPath, `${script}\n`, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function buildDesktopEntry({ execPath, iconPath }) {
  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Fluxer",
    "Comment=Fluxer installed by BetterFluxer Injector",
    `Exec=${execPath}`,
    `Icon=${iconPath || "application-x-executable"}`,
    "Terminal=false",
    "Categories=Network;Chat;",
    "StartupNotify=true",
    "X-AppImage-Integrate=false"
  ];
  return `${lines.join("\n")}\n`;
}

async function installLinuxAppImage(options = {}) {
  if (process.platform !== "linux") {
    throw new Error("AppImage installation is only supported on Linux.");
  }

  const appImagePath = path.resolve(String(options.appImagePath || ""));
  if (!appImagePath || !fs.existsSync(appImagePath)) {
    throw new Error(`AppImage not found: ${appImagePath || "(empty path)"}`);
  }
  if (!looksLikeAppImage(appImagePath)) {
    throw new Error(`Expected an .AppImage file, got: ${appImagePath}`);
  }

  const outputAppPath = path.resolve(String(options.outputAppPath || LINUX_APP_PATH));
  fs.mkdirSync(LINUX_INSTALL_ROOT, { recursive: true });
  fs.mkdirSync(path.dirname(outputAppPath), { recursive: true });

  if (path.basename(outputAppPath) === "squashfs-root") {
    const extractCwd = path.dirname(outputAppPath);
    if (fs.existsSync(outputAppPath)) {
      await removePathBestEffort(outputAppPath);
    }
    await execFileAsync(appImagePath, ["--appimage-extract"], { cwd: extractCwd });
    if (!fs.existsSync(outputAppPath)) {
      throw new Error(`AppImage extraction failed: ${outputAppPath} was not created.`);
    }
  } else {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "betterfluxer-appimage-"));
    try {
      await execFileAsync(appImagePath, ["--appimage-extract"], { cwd: tmpRoot });
      const extractedRoot = path.join(tmpRoot, "squashfs-root");
      if (!fs.existsSync(extractedRoot)) {
        throw new Error("AppImage extraction failed: squashfs-root not created.");
      }

      if (fs.existsSync(outputAppPath)) {
        await removePathBestEffort(outputAppPath);
      }
      fs.cpSync(extractedRoot, outputAppPath, { recursive: true, force: true });
    } finally {
      await removePathBestEffort(tmpRoot);
    }
  }

  const appRunPath = path.join(outputAppPath, "AppRun");
  if (!fs.existsSync(appRunPath)) {
    throw new Error(`Extracted app is missing AppRun: ${appRunPath}`);
  }
  fs.chmodSync(appRunPath, 0o755);
  const wrapperPath = createLinuxLaunchWrapper(outputAppPath);

  const iconPath = getDesktopIconPath(outputAppPath);
  const desktopDir = path.dirname(LINUX_DESKTOP_ENTRY_PATH);
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.writeFileSync(
    LINUX_DESKTOP_ENTRY_PATH,
    buildDesktopEntry({ execPath: wrapperPath, iconPath }),
    { encoding: "utf8", mode: 0o644 }
  );

  await runOptionalExec("update-desktop-database", [desktopDir]);

  return {
    ok: true,
    installRoot: LINUX_INSTALL_ROOT,
    appPath: outputAppPath,
    launchScriptPath: wrapperPath,
    desktopEntryPath: LINUX_DESKTOP_ENTRY_PATH
  };
}

function downloadFile(url, destinationPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(String(url));
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(parsed, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error("Too many redirects while downloading Fluxer AppImage."));
          return;
        }
        const nextUrl = new URL(response.headers.location, parsed).toString();
        downloadFile(nextUrl, destinationPath, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(destinationPath);
      response.pipe(file);
      file.on("finish", () => {
        file.close(() => resolve(destinationPath));
      });
      file.on("error", (error) => {
        try {
          fs.unlinkSync(destinationPath);
        } catch (_) {}
        reject(error);
      });
    });

    request.on("error", reject);
  });
}

async function installLatestLinuxAppImage() {
  if (process.platform !== "linux") {
    throw new Error("Latest AppImage install is only supported on Linux.");
  }

  fs.mkdirSync(LINUX_DOWNLOADS_DIR, { recursive: true });
  await downloadFile(LINUX_LATEST_APPIMAGE_URL, LINUX_DOWNLOADED_APPIMAGE_PATH);
  fs.chmodSync(LINUX_DOWNLOADED_APPIMAGE_PATH, 0o755);
  const installed = await installLinuxAppImage({
    appImagePath: LINUX_DOWNLOADED_APPIMAGE_PATH,
    outputAppPath: LINUX_APP_PATH
  });
  return {
    ...installed,
    downloadedFrom: LINUX_LATEST_APPIMAGE_URL,
    downloadedPath: LINUX_DOWNLOADED_APPIMAGE_PATH
  };
}

async function isFluxerRunning() {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("tasklist", ["/FI", "IMAGENAME eq Fluxer.exe", "/FO", "CSV", "/NH"]);
    return /"Fluxer\.exe"/i.test(stdout);
  }

  if (process.platform !== "linux" && process.platform !== "darwin") {
    return false;
  }

  const pids = await getPosixFluxerPids();
  return pids.length > 0;
}

async function closeFluxer() {
  if (process.platform === "win32") {
    const running = await isFluxerRunning();
    if (!running) {
      return { closed: true, message: "Fluxer is not running." };
    }

    await execFileAsync("taskkill", ["/IM", "Fluxer.exe", "/F"]);
    return { closed: true, message: "Fluxer process terminated." };
  }

  if (process.platform !== "linux" && process.platform !== "darwin") {
    return { closed: false, message: "Automatic close is not supported on this OS." };
  }

  let pids = await getPosixFluxerPids();
  if (pids.length === 0) {
    return { closed: true, message: "Fluxer is not running." };
  }

  let attempted = false;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      attempted = true;
    } catch (error) {
      if (error && error.code !== "ESRCH") throw error;
    }
  }

  await sleep(900);
  pids = await getPosixFluxerPids();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      attempted = true;
    } catch (error) {
      if (error && error.code !== "ESRCH") throw error;
    }
  }

  await sleep(150);
  const remaining = await getPosixFluxerPids();
  if (remaining.length > 0) {
    return { closed: false, message: "Tried to close Fluxer, but it is still running. Please close it manually." };
  }

  if (!attempted) {
    return { closed: false, message: "Fluxer process was not found by pkill. Please close it manually." };
  }

  return { closed: true, message: "Fluxer process terminated." };
}

async function closeFluxerBeforeInject(options = {}) {
  if (process.platform === "linux") {
    const result = await closeFluxer();
    if (!result.closed) {
      throw new Error(`Cannot inject while Fluxer is running. ${result.message}`);
    }
    return;
  }

  if (options.closeFluxerFirst !== false) {
    await closeFluxer();
  }
}

function resolveTarget(options = {}) {
  const installRoot = resolveInstallRoot(options.installRoot);
  const versions = getInstalledVersions(options.installRoot);
  const appPath = getFluxerAppPath({ installRoot: options.installRoot, appPath: options.appPath, version: options.version });
  return { installRoot, versions, appPath };
}

function getPackedPreloadPath(appPath) {
  return path.join(appPath, "resources", "app.asar", "src-electron", "dist", "preload", "index.js");
}

function appPathHasInjectablePreload(appPath) {
  if (!appPath) return false;
  try {
    return fs.existsSync(resolvePaths(appPath).preloadPath);
  } catch (_) {
    return false;
  }
}

function findInjectableAppPath(installRoot, versions, preferredAppPath) {
  const candidates = [];
  const push = (value) => {
    if (!value) return;
    const normalized = path.resolve(value);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  push(preferredAppPath);
  for (const version of versions || []) {
    push(path.join(installRoot, version));
  }

  for (const candidate of candidates) {
    if (appPathHasInjectablePreload(candidate)) return candidate;
  }
  return null;
}

async function readStatus(options = {}) {
  const processInfo = await getFluxerProcessInfo();
  const installRoot = resolveInstallRoot(options.installRoot);
  const versions = getInstalledVersions(options.installRoot);

  let appPath = options.appPath ? path.resolve(options.appPath) : null;
  let status = null;
  let resolveError = null;

  if (!appPath) {
    try {
      appPath = resolveTarget(options).appPath;
    } catch (error) {
      resolveError = error;
    }
  }

  if (!appPath && processInfo.appPath) {
    appPath = processInfo.appPath;
  }

  if (appPath && !appPathHasInjectablePreload(appPath)) {
    const fallback = findInjectableAppPath(installRoot, versions, appPath);
    if (fallback) {
      appPath = fallback;
    }
  }

  if (appPath) {
    status = getInjectionStatus(appPath);
  }

  const appPathWritable = canWriteToAppPath(appPath);

  let resolveErrorMessage = resolveError ? resolveError.message : null;
  if (!resolveErrorMessage && appPath && !appPathWritable) {
    resolveErrorMessage =
      processInfo.appImagePath && appPath.includes("/tmp/.mount_")
        ? "Fluxer is running from a mounted AppImage (read-only). Patch cannot persist there."
        : "Detected app path is not writable by current user.";
  }

  return {
    installRoot,
    versions,
    appPath: appPath || null,
    appPathWritable,
    preloadExists: status ? status.preloadExists : false,
    backupExists: status ? status.backupExists : false,
    runtimeExists: status ? status.runtimeExists : false,
    injected: status ? status.injected : false,
    fluxerRunning: processInfo.running,
    process: processInfo,
    resolveError: resolveErrorMessage
  };
}

async function runInject(options = {}) {
  await closeFluxerBeforeInject(options);

  const statusBefore = await readStatus(options);
  if (!statusBefore.appPath) {
    throw new Error(
      "Unable to locate Fluxer app path. Set --app-path manually or start Fluxer so BetterFluxer can detect it from process info."
    );
  }
  const target = {
    installRoot: statusBefore.installRoot,
    versions: statusBefore.versions,
    appPath: statusBefore.appPath
  };
  const injectableAppPath = findInjectableAppPath(target.installRoot, target.versions, target.appPath);
  if (injectableAppPath) {
    target.appPath = injectableAppPath;
  }
  const paths = resolvePaths(target.appPath);
  if (!fs.existsSync(paths.preloadPath)) {
    const packedPreloadPath = getPackedPreloadPath(target.appPath);
    if (fs.existsSync(packedPreloadPath)) {
      throw new Error(
        `Fluxer preload exists only inside app.asar (packed build): ${packedPreloadPath}. ` +
          "This build layout is not patchable with BetterFluxer injector yet. Install a standard Fluxer desktop build that includes app.asar.unpacked."
      );
    }
    throw new Error(
      `Fluxer preload entry not found: ${paths.preloadPath}. ` +
        "Try clearing the Version field in the injector so it auto-selects the newest installed app-* folder."
    );
  }
  if (!canWriteToAppPath(target.appPath)) {
    throw new Error(
      "Target preload is not writable. If Fluxer runs as AppImage, install/extract it to a writable folder and use --app-path."
    );
  }
  copyRuntime(SOURCE_ROOT, paths.injectedRoot);
  const launcherPath = ensureLinuxSafeLauncher(target.appPath);
  writeBootstrap(paths.bootstrapPath);
  const inlinePlugins = collectInlinePlugins(SOURCE_ROOT);
  const storeIndexSnapshot = await buildStoreIndexSnapshot(DEFAULT_STORE_INDEX_URL);
  console.log(`[BetterFluxer] Store snapshot items: ${storeIndexSnapshot.length}`);
  const mainPatchResult = patchMainIpcHandlers(paths.mainIpcHandlersPath, paths.backupMainIpcHandlersPath);
  const patchResult = patchPreload(paths.preloadPath, paths.backupPreloadPath, inlinePlugins, {
    enableIpcBridge: mainPatchResult && mainPatchResult.skipped !== true,
    storeIndexSnapshot
  });
  const status = await readStatus(target);
  return {
    ok: true,
    changed: patchResult.changed,
    launcherPath: launcherPath || null,
    status
  };
}

async function runUninject(options = {}) {
  if (options.closeFluxerFirst !== false) {
    await closeFluxer();
  }
  const statusBefore = await readStatus(options);
  if (!statusBefore.appPath) {
    throw new Error(
      "Unable to locate Fluxer app path. Set --app-path manually or start Fluxer so BetterFluxer can detect it from process info."
    );
  }
  const target = {
    installRoot: statusBefore.installRoot,
    versions: statusBefore.versions,
    appPath: statusBefore.appPath
  };
  const paths = resolvePaths(target.appPath);
  if (!canWriteToAppPath(target.appPath)) {
    throw new Error(
      "Target preload is not writable. If Fluxer runs as AppImage, install/extract it to a writable folder and use --app-path."
    );
  }
  unpatchPreload(paths.preloadPath, paths.backupPreloadPath);
  unpatchMainIpcHandlers(paths.mainIpcHandlersPath, paths.backupMainIpcHandlersPath);
  const fs = require("fs");
  if (fs.existsSync(paths.injectedRoot)) {
    fs.rmSync(paths.injectedRoot, { recursive: true, force: true });
  }
  const status = await readStatus(target);
  return {
    ok: true,
    status
  };
}

module.exports = {
  getDefaults: async () => ({
    platform: process.platform,
    defaultInstallRoot: resolveInstallRoot(),
    defaultInstallRoots: DEFAULT_INSTALL_ROOTS,
    supportsAutoClose: process.platform === "win32" || process.platform === "linux" || process.platform === "darwin",
    linuxLatestAppImageUrl: LINUX_LATEST_APPIMAGE_URL
  }),
  getStatus: (options) => readStatus(options || {}),
  closeFluxer: () => closeFluxer(),
  inject: (options) => runInject(options || {}),
  uninject: (options) => runUninject(options || {}),
  installAppImage: (options) => installLinuxAppImage(options || {}),
  installLatestLinuxAppImage: () => installLatestLinuxAppImage()
};