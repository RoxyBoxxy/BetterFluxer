const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

function getDefaultInstallRoots(platform = process.platform) {
  const home = os.homedir();

  if (platform === "win32") {
    return [path.join(home, "AppData", "Local", "fluxer_app")];
  }

  if (platform === "linux") {
    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
    const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    return [
      path.join(home, ".fluxer", "fluxer"),
      path.join(xdgDataHome, "fluxer_app"),
      path.join(xdgConfigHome, "fluxer_app"),
      path.join(home, ".config", "Fluxer")
    ];
  }

  if (platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "fluxer_app"),
      path.join(home, "Library", "Application Support", "Fluxer")
    ];
  }

  return [path.join(home, "fluxer_app")];
}

const DEFAULT_INSTALL_ROOTS = getDefaultInstallRoots();
const DEFAULT_INSTALL_ROOT = DEFAULT_INSTALL_ROOTS[0];
const DEFAULT_SPLASH_PULSE_COLOR = "#ff77b8";
const INJECTION_START = "// BetterFluxer Injector Start";
const INJECTION_END = "// BetterFluxer Injector End";
const MAIN_IPC_INJECTION_START = "// BetterFluxer Main IPC Start";
const MAIN_IPC_INJECTION_END = "// BetterFluxer Main IPC End";

function resolveInstallRoot(installRoot) {
  if (installRoot) {
    return path.resolve(installRoot);
  }

  for (const candidate of DEFAULT_INSTALL_ROOTS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return DEFAULT_INSTALL_ROOT;
}

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    if (!item.startsWith("--")) continue;
    const [rawKey, ...rest] = item.slice(2).split("=");
    const key = rawKey.trim();
    const value = rest.join("=").trim();
    args[key] = value === "" ? true : value;
  }
  return args;
}

function parseVersion(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return match.slice(1).map((n) => Number.parseInt(n, 10));
}

function compareVersionsDesc(a, b) {
  const pa = parseVersion(a.replace(/^app-/, ""));
  const pb = parseVersion(b.replace(/^app-/, ""));
  if (!pa || !pb) return 0;

  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return -1;
    if (pa[i] < pb[i]) return 1;
  }
  return 0;
}

function getInstalledVersions(installRoot) {
  const root = resolveInstallRoot(installRoot);
  if (!fs.existsSync(root)) {
    return [];
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^app-\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersionsDesc);
}

function isFluxerAppFolder(appPath) {
  const preloadPath = path.join(appPath, "resources", "app.asar.unpacked", "src-electron", "dist", "preload", "index.js");
  return fs.existsSync(preloadPath);
}

function getFluxerAppPath(options = {}) {
  const installRoot = resolveInstallRoot(options.installRoot);

  if (options.appPath) {
    return path.resolve(options.appPath);
  }

  if (isFluxerAppFolder(installRoot)) {
    return installRoot;
  }

  if (!fs.existsSync(installRoot)) {
    throw new Error(`Fluxer install root not found: ${installRoot}`);
  }

  const versions = getInstalledVersions(installRoot);

  if (versions.length === 0) {
    throw new Error(`No Fluxer version folders found under: ${installRoot}`);
  }

  if (options.version) {
    const requested = `app-${options.version}`;
    if (!versions.includes(requested)) {
      throw new Error(`Requested Fluxer version not found: ${requested}`);
    }
    return path.join(installRoot, requested);
  }

  return path.join(installRoot, versions[0]);
}

function resolvePaths(appPath) {
  const resourcesPath = path.join(appPath, "resources");
  const asarPath = path.join(resourcesPath, "app.asar");
  const backupAsarPath = `${asarPath}.betterfluxer.bak`;
  const unpackedPath = path.join(resourcesPath, "app.asar.unpacked");
  const preloadDir = path.join(unpackedPath, "src-electron", "dist", "preload");
  const mainDir = path.join(unpackedPath, "src-electron", "dist", "main");
  const preloadPath = path.join(preloadDir, "index.js");
  const backupPreloadPath = `${preloadPath}.betterfluxer.bak`;
  const mainIpcHandlersPath = path.join(mainDir, "ipc-handlers.js");
  const backupMainIpcHandlersPath = `${mainIpcHandlersPath}.betterfluxer.bak`;
  const injectedRoot = path.join(unpackedPath, "betterfluxer");
  const bootstrapPath = path.join(injectedRoot, "bootstrap.js");
  return {
    resourcesPath,
    asarPath,
    backupAsarPath,
    unpackedPath,
    preloadDir,
    mainDir,
    preloadPath,
    backupPreloadPath,
    mainIpcHandlersPath,
    backupMainIpcHandlersPath,
    injectedRoot,
    bootstrapPath
  };
}

function resolveSourceDesktopMainBundle(sourceRoot) {
  const candidates = [
    path.join(sourceRoot, "vendor", "linux-desktop-bundle", "dist", "main", "index.js"),
    path.join(sourceRoot, "cache", "linux-desktop-bundle", "dist", "main", "index.js"),
    path.join(sourceRoot, "do_not_edit", "fluxer", "fluxer_desktop", "dist", "main", "index.js")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveAsarModulePath(sourceRoot) {
  const candidates = [
    path.join(sourceRoot, "vendor", "linux-desktop-bundle", "node_modules", "@electron", "asar", "lib", "asar.js"),
    path.join(sourceRoot, "cache", "linux-desktop-bundle", "node_modules", "@electron", "asar", "lib", "asar.js"),
    path.join(sourceRoot, "node_modules", "@electron", "asar", "lib", "asar.js"),
    path.join(
      sourceRoot,
      "do_not_edit",
      "fluxer",
      "fluxer_desktop",
      "node_modules",
      "@electron",
      "asar",
      "lib",
      "asar.js"
    )
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function patchPackagedMainBundle(asarPath, backupAsarPath, replacementMainPath, sourceRoot) {
  if (!asarPath || !fs.existsSync(asarPath)) {
    return { changed: false, skipped: true, reason: "asar-missing" };
  }
  if (!replacementMainPath || !fs.existsSync(replacementMainPath)) {
    return { changed: false, skipped: true, reason: "replacement-main-missing" };
  }

  const asarModulePath = resolveAsarModulePath(sourceRoot);
  if (!asarModulePath || !fs.existsSync(asarModulePath)) {
    return { changed: false, skipped: true, reason: "asar-module-missing" };
  }

  const asar = require(asarModulePath);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "betterfluxer-asar-"));
  const extractedDir = path.join(tmpRoot, "app");
  const tempAsarPath = path.join(tmpRoot, "app.asar");
  const archiveMainPath = path.join(extractedDir, "src-electron", "dist", "main", "index.js");
  const replacementMapPath = `${replacementMainPath}.map`;
  const archiveMapPath = `${archiveMainPath}.map`;

  try {
    asar.extractAll(asarPath, extractedDir);
    if (!fs.existsSync(archiveMainPath)) {
      return { changed: false, skipped: true, reason: "archive-main-missing" };
    }
    if (!fs.existsSync(backupAsarPath)) {
      fs.copyFileSync(asarPath, backupAsarPath);
    }

    fs.copyFileSync(replacementMainPath, archiveMainPath);
    if (fs.existsSync(replacementMapPath)) {
      fs.copyFileSync(replacementMapPath, archiveMapPath);
    }

    await asar.createPackage(extractedDir, tempAsarPath);
    fs.copyFileSync(tempAsarPath, asarPath);
    return { changed: true, skipped: false };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  }
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function copyRuntime(sourceRoot, injectedRoot) {
  fs.mkdirSync(injectedRoot, { recursive: true });
  const rootPluginsSource = path.join(sourceRoot, "plugins");
  const nwPluginsSource = path.join(sourceRoot, "nw", "plugins");
  const pluginsSource = fs.existsSync(rootPluginsSource) ? rootPluginsSource : nwPluginsSource;
  if (fs.existsSync(pluginsSource)) {
    try {
      fs.cpSync(pluginsSource, path.join(injectedRoot, "plugins"), { recursive: true, force: true });
    } catch (error) {
      const message = String((error && error.message) || error || "");
      const sourceLooksPacked = String(pluginsSource).toLowerCase().includes(".asar");
      const isMissingOrLstat =
        message.includes("ENOENT") || message.includes("lstat") || message.includes("no such file or directory");

      // Packaged injector builds can expose virtual paths inside app.asar that cannot be copied with fs.cpSync.
      // In that case we continue: inline plugin payload still gets injected into preload.
      if (!(sourceLooksPacked && isMissingOrLstat)) {
        throw error;
      }
    }
  }
  fs.mkdirSync(path.join(injectedRoot, "data"), { recursive: true });
}

function ensureLinuxSafeLauncher(appPath) {
  if (process.platform !== "linux") {
    return null;
  }
  const launcherPath = path.join(appPath, "betterfluxer-launch.sh");
  const script = [
    "#!/usr/bin/env sh",
    "set -eu",
    "",
    "# Linux stability defaults for Electron/Chromium GPU stack.",
    "export ELECTRON_OZONE_PLATFORM_HINT=\"${ELECTRON_OZONE_PLATFORM_HINT:-x11}\"",
    "export OZONE_PLATFORM=\"${OZONE_PLATFORM:-x11}\"",
    "export GDK_BACKEND=\"${GDK_BACKEND:-x11}\"",
    "export XDG_SESSION_TYPE=\"${XDG_SESSION_TYPE:-x11}\"",
    "export GTK_USE_PORTAL=\"${GTK_USE_PORTAL:-0}\"",
    "export LIBVA_DRIVER_NAME=\"${LIBVA_DRIVER_NAME:-dummy}\"",
    "",
    "APP_RUN=\"$(dirname \"$0\")/AppRun\"",
    "exec \"$APP_RUN\" \\",
    "  --disable-gpu \\",
    "  --disable-gpu-sandbox \\",
    "  --disable-accelerated-video-decode \\",
    "  --disable-features=WebRTCPipeWireCapturer \\",
    "  --disable-features=VaapiVideoDecoder,UseChromeOSDirectVideoDecoder,VaapiIgnoreDriverChecks \\",
    "  --use-gl=swiftshader \\",
    "  \"$@\""
  ].join("\n");
  fs.writeFileSync(launcherPath, `${script}\n`, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

function getDefaultSplashIconDataUrl(sourceRoot) {
  try {
    const root = sourceRoot ? path.resolve(sourceRoot) : path.resolve(__dirname, "..", "..");
    const candidates = [
      path.join(root, "nw", "assets", "betterfluxertrans.png"),
      path.join(root, "assets", "betterfluxertrans.png")
    ];
    const pngPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!pngPath) return "";
    const bytes = fs.readFileSync(pngPath);
    if (!bytes || !bytes.length) return "";
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch (_) {
    return "";
  }
}

function writeBootstrap() {
  // legacy no-op; runtime is now injected inline into preload for sandbox compatibility
}

function collectInlinePlugins(sourceRoot) {
  const rootPlugins = path.join(sourceRoot, "plugins");
  const nwPlugins = path.join(sourceRoot, "nw", "plugins");
  const pluginsRoot = fs.existsSync(rootPlugins) ? rootPlugins : nwPlugins;
  if (!fs.existsSync(pluginsRoot)) {
    return [];
  }

  const entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
  const plugins = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginsRoot, entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    const indexPath = path.join(dir, "index.js");
    if (!fs.existsSync(indexPath)) continue;

    let manifest = {};
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (_) {
        manifest = {};
      }
    }

    plugins.push({
      id: manifest.name || entry.name,
      code: fs.readFileSync(indexPath, "utf8")
    });
  }

  return plugins;
}

async function requestTextViaUndici(url) {
  let requestFn = null;
  try {
    // Optional dependency used by injector-side snapshot fetches.
    const undici = require("undici");
    if (undici && typeof undici.request === "function") {
      requestFn = undici.request;
    }
  } catch (_) {
    requestFn = null;
  }

  if (!requestFn) {
    throw new Error("undici unavailable");
  }

  const response = await requestFn(String(url || ""), {
    method: "GET",
    headers: {
      "User-Agent": "BetterFluxer/1.0"
    },
    maxRedirections: 5,
    headersTimeout: 15000,
    bodyTimeout: 15000
  });

  const status = Number(response && response.statusCode ? response.statusCode : 0);
  const body = response && response.body && typeof response.body.text === "function"
    ? await response.body.text()
    : "";
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}`);
  }
  return body;
}

function requestTextViaNodeHttp(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(url || ""));
    } catch (_) {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        method: "GET",
        path: parsed.pathname + parsed.search,
        headers: {
          "User-Agent": "BetterFluxer/1.0"
        }
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        if (status >= 300 && status < 400 && res.headers && res.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error("Redirect limit exceeded"));
            return;
          }
          const redirectTarget = new URL(String(res.headers.location), parsed).toString();
          requestTextViaNodeHttp(redirectTarget, redirectsLeft - 1).then(resolve).catch(reject);
          return;
        }
        const chunks = [];
        res.setEncoding("utf8");
        res.on("data", (chunk) => chunks.push(String(chunk)));
        res.on("error", (error) => reject(error));
        res.on("end", () => {
          const body = chunks.join("");
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          resolve(body);
        });
      }
    );
    req.on("error", (error) => reject(error));
    req.setTimeout(15000, () => {
      try {
        req.destroy(new Error("timeout"));
      } catch (_) {}
      reject(new Error("timeout"));
    });
    req.end();
  });
}

async function requestText(url, redirectsLeft = 5) {
  try {
    return await requestTextViaUndici(url);
  } catch (_) {
    return requestTextViaNodeHttp(url, redirectsLeft);
  }
}

async function requestJson(url) {
  const text = await requestText(url);
  return JSON.parse(text);
}

async function buildStoreIndexSnapshot(indexUrl) {
  const snapshot = [];
  try {
    const payload = await requestJson(indexUrl);
    let items = [];
    if (Array.isArray(payload)) items = payload;
    else if (payload && Array.isArray(payload.plugins)) items = payload.plugins;
    else if (payload && payload.data && Array.isArray(payload.data.plugins)) items = payload.data.plugins;
    else if (payload && Array.isArray(payload.items)) items = payload.items;

    for (const item of items) {
      if (!item) continue;
      const id = String(item.id || item.name || "");
      if (!id) continue;
      const normalized = {
        id,
        name: String(item.name || id),
        manifest: item.manifest ? String(item.manifest) : null,
        url: item.url ? String(item.url) : null,
        code: typeof item.code === "string" ? item.code : null,
        source: "snapshot"
      };

      if (!normalized.code && normalized.manifest) {
        try {
          const manifest = await requestJson(normalized.manifest);
          const main = String(manifest && manifest.main ? manifest.main : "index.js");
          const resolvedUrl = new URL(main, normalized.manifest).toString();
          normalized.url = resolvedUrl;
          normalized.code = await requestText(resolvedUrl);
          normalized.name = String(manifest && manifest.name ? manifest.name : normalized.name);
        } catch (_) {
          // keep snapshot item even if code couldn't be prefetched
        }
      } else if (!normalized.code && normalized.url) {
        try {
          normalized.code = await requestText(normalized.url);
        } catch (_) {
          // keep item metadata only
        }
      }

      snapshot.push(normalized);
    }
  } catch (_) {
    return [];
  }
  return snapshot;
}

function buildRequireSnippet(inlinePlugins, options = {}) {
  const payload = JSON.stringify(inlinePlugins);
  const storeIndexSnapshot = JSON.stringify(Array.isArray(options.storeIndexSnapshot) ? options.storeIndexSnapshot : []);
  const enableIpcBridge = options && options.enableIpcBridge === true;
  const customSplashIconDataUrl = JSON.stringify(String((options && options.customSplashIconDataUrl) || ""));
  const customSplashPulseColor = JSON.stringify(String((options && options.customSplashPulseColor) || ""));
  const betterFluxerVersion = JSON.stringify(String((options && options.betterFluxerVersion) || "dev"));
  const betterFluxerChecksum = JSON.stringify(String((options && options.betterFluxerChecksum) || ""));
  return `${INJECTION_START}
try {
  (function initBetterFluxerInline() {
    if (window.__betterFluxerRuntime) return;
    const ENABLE_BETTERFLUXER_IPC_BRIDGE = ${enableIpcBridge ? "true" : "false"};
    const STORE_INDEX_URL = "https://raw.githubusercontent.com/RoxyBoxxy/BetterFluxer/refs/heads/main/plugins.json";
    const STORE_INDEX_SNAPSHOT = ${storeIndexSnapshot};
    const CUSTOM_SPLASH_ICON_DATA_URL = ${customSplashIconDataUrl};
    const CUSTOM_SPLASH_PULSE_COLOR = ${customSplashPulseColor};
    const BETTERFLUXER_VERSION = ${betterFluxerVersion};
    const BETTERFLUXER_CHECKSUM = ${betterFluxerChecksum};
    let defs = ${payload};
    const runtime = {
      plugins: [],
      storePrefix: "betterfluxer:",
      store: {
        indexUrl: STORE_INDEX_URL,
        indexSnapshot: STORE_INDEX_SNAPSHOT,
        items: [],
        loading: false,
        open: false,
        error: null,
        remoteError: null
      },
      ui: {
        panel: null,
        observer: null,
        activeTab: null,
        manualInstallMessage: "",
        toastHost: null,
        contentHost: null,
        nativeContentNode: null,
        nativeContentPrevDisplay: "",
        customCategories: [],
        settingsNodes: {
          category: null,
          plugins: null,
          settings: null
        }
      }
    };

    function key(name) {
      return runtime.storePrefix + "core:" + name;
    }

    function getCoreSetting(name, fallback) {
      try {
        const raw = localStorage.getItem(key(name));
        return raw == null ? fallback : JSON.parse(raw);
      } catch (_e) {
        return fallback;
      }
    }

    function setCoreSetting(name, value) {
      localStorage.setItem(key(name), JSON.stringify(value));
      return value;
    }

    runtime.settings = {
      autoInjectCategory: getCoreSetting("autoInjectCategory", true)
    };
    runtime.uiClasses = null;
    runtime.classTypes = null;

    function toLinuxDisplayMediaConstraints(constraints) {
      const c = constraints && typeof constraints === "object" ? constraints : {};
      const wantsAudio = c.audio !== false && c.audio != null;
      return {
        video: {
          frameRate: 30
        },
        audio: Boolean(wantsAudio)
      };
    }

    async function getScreenStream(constraints) {
      const displayConstraints = toLinuxDisplayMediaConstraints(constraints);
      return await navigator.mediaDevices.getDisplayMedia({
        video: displayConstraints.video,
        audio: displayConstraints.audio
      });
    }

    function isDesktopCaptureRequest(constraints) {
      const c = constraints && typeof constraints === "object" ? constraints : {};
      const hasDesktopTokens = (track) => {
        if (!track || typeof track !== "object") return false;
        const mandatory = track.mandatory && typeof track.mandatory === "object" ? track.mandatory : null;
        if (mandatory) {
          if (String(mandatory.chromeMediaSource || "").toLowerCase() === "desktop") return true;
          if (String(mandatory.chromeMediaSourceId || "").trim()) return true;
        }
        if (String(track.chromeMediaSource || "").toLowerCase() === "desktop") return true;
        if (String(track.chromeMediaSourceId || "").trim()) return true;
        return false;
      };
      return hasDesktopTokens(c.video) || hasDesktopTokens(c.audio);
    }

    function patchLinuxDisplayCapture() {
      try {
        if (!process || process.platform !== "linux") return;
      } catch (_e) {
        return;
      }
      const mediaDevices = navigator && navigator.mediaDevices ? navigator.mediaDevices : null;
      if (!mediaDevices) return;
      if (typeof mediaDevices.getUserMedia !== "function" || typeof mediaDevices.getDisplayMedia !== "function") return;
      if (mediaDevices.__bfForceDisplayMediaPatched) return;

      const proto = Object.getPrototypeOf(mediaDevices);
      const nativeGetUserMedia =
        proto && typeof proto.getUserMedia === "function"
          ? proto.getUserMedia.bind(mediaDevices)
          : mediaDevices.getUserMedia.bind(mediaDevices);
      const nativeGetDisplayMedia =
        proto && typeof proto.getDisplayMedia === "function"
          ? proto.getDisplayMedia.bind(mediaDevices)
          : mediaDevices.getDisplayMedia.bind(mediaDevices);

      mediaDevices.getUserMedia = async (constraints) => {
        if (!isDesktopCaptureRequest(constraints)) {
          return nativeGetUserMedia(constraints);
        }
        const displayConstraints = toLinuxDisplayMediaConstraints(constraints);
        try {
          return await getScreenStream(constraints);
        } catch (_error) {
          return nativeGetDisplayMedia(displayConstraints);
        }
      };

      try {
        mediaDevices.__bfForceDisplayMediaPatched = true;
      } catch (_e) {}
      try {
        console.info("[BetterFluxer] Linux display capture patched: forcing getDisplayMedia.");
      } catch (_e) {}
    }

    async function chooseLinuxDisplaySourceId(requestedId) {
      const electronApi = window && window.electron ? window.electron : null;
      if (!electronApi || typeof electronApi.getDesktopSources !== "function") {
        return String(requestedId || "");
      }

      let sources = [];
      try {
        const result = await electronApi.getDesktopSources(["window", "screen"]);
        if (Array.isArray(result)) sources = result;
      } catch (_e) {
        return String(requestedId || "");
      }

      const requested = String(requestedId || "").trim();
      if (!requested) {
        const screen = sources.find((item) => String(item && item.id || "").startsWith("screen:"));
        return String((screen && screen.id) || (sources[0] && sources[0].id) || "");
      }

      const exact = sources.find((item) => String(item && item.id || "") === requested);
      if (exact) return requested;

      const prefix = requested.includes(":") ? requested.split(":")[0] : "";
      if (prefix) {
        const sameType = sources.find((item) => String(item && item.id || "").startsWith(prefix + ":"));
        if (sameType) return String(sameType.id || "");
      }

      const screen = sources.find((item) => String(item && item.id || "").startsWith("screen:"));
      return String((screen && screen.id) || (sources[0] && sources[0].id) || "");
    }

    async function logLinuxDisplaySources(reason) {
      const electronApi = window && window.electron ? window.electron : null;
      if (!electronApi || typeof electronApi.getDesktopSources !== "function") return;
      try {
        const sources = await electronApi.getDesktopSources(["window", "screen"]);
        if (!Array.isArray(sources)) return;
        const screens = [];
        const windows = [];
        for (const item of sources) {
          const id = String(item && item.id || "");
          const name = String(item && item.name || "");
          const entry = { id, name };
          if (id.startsWith("screen:")) screens.push(entry);
          else if (id.startsWith("window:")) windows.push(entry);
        }
        console.info("[BetterFluxer] Linux display source snapshot (" + String(reason || "unknown") + "):", {
          total: sources.length,
          screens,
          windows
        });
      } catch (_e) {}
    }

    async function showLinuxDisplaySourcePicker(requestId, withAudio) {
      const electronApi = window && window.electron ? window.electron : null;
      if (!electronApi || typeof electronApi.getDesktopSources !== "function") {
        return "";
      }

      let sources = [];
      try {
        const result = await electronApi.getDesktopSources(["window", "screen"]);
        if (Array.isArray(result)) {
          sources = result
            .map((item) => ({
              id: String((item && item.id) || ""),
              name: String((item && item.name) || "")
            }))
            .filter((item) => item.id);
        }
      } catch (_error) {
        return "";
      }

      if (!sources.length) {
        try {
          console.warn("[BetterFluxer] Linux picker: no display sources available.", { requestId });
        } catch (_error) {}
        return "";
      }

      sources.sort((a, b) => {
        const aScreen = a.id.startsWith("screen:");
        const bScreen = b.id.startsWith("screen:");
        if (aScreen !== bScreen) return aScreen ? -1 : 1;
        return a.id.localeCompare(b.id);
      });

      return await new Promise((resolve) => {
        const existing = document.getElementById("bf-linux-display-picker");
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

        const root = document.createElement("div");
        root.id = "bf-linux-display-picker";
        root.style.cssText = [
          "position:fixed",
          "inset:0",
          "z-index:2147483647",
          "background:rgba(5,7,12,0.72)",
          "backdrop-filter:blur(4px)",
          "display:flex",
          "align-items:center",
          "justify-content:center"
        ].join(";");

        const card = document.createElement("div");
        card.style.cssText = [
          "width:min(700px,92vw)",
          "max-height:82vh",
          "overflow:auto",
          "background:#0f172a",
          "color:#e2e8f0",
          "border:1px solid rgba(148,163,184,0.35)",
          "border-radius:12px",
          "box-shadow:0 24px 80px rgba(2,6,23,0.7)",
          "padding:14px"
        ].join(";");

        const title = document.createElement("div");
        title.textContent = "BetterFluxer Screen Share Picker";
        title.style.cssText = "font-size:16px;font-weight:700;margin-bottom:6px;";
        card.appendChild(title);

        const subtitle = document.createElement("div");
        subtitle.textContent = "Choose a source to share";
        subtitle.style.cssText = "font-size:12px;opacity:.85;margin-bottom:10px;";
        card.appendChild(subtitle);

        const list = document.createElement("div");
        list.style.cssText = "display:grid;grid-template-columns:1fr;gap:8px;";

        const close = (chosenId) => {
          if (root.parentNode) root.parentNode.removeChild(root);
          resolve(String(chosenId || ""));
        };

        for (const source of sources) {
          const btn = document.createElement("button");
          btn.type = "button";
          const label = source.name || source.id;
          btn.textContent = label + " (" + source.id + ")";
          btn.style.cssText = [
            "text-align:left",
            "padding:10px 12px",
            "border-radius:8px",
            "border:1px solid rgba(148,163,184,0.35)",
            "background:#111827",
            "color:#f8fafc",
            "cursor:pointer"
          ].join(";");
          btn.onmouseenter = () => {
            btn.style.background = "#1f2937";
            btn.style.borderColor = "rgba(96,165,250,0.9)";
          };
          btn.onmouseleave = () => {
            btn.style.background = "#111827";
            btn.style.borderColor = "rgba(148,163,184,0.35)";
          };
          btn.onclick = () => close(source.id);
          list.appendChild(btn);
        }

        card.appendChild(list);

        const footer = document.createElement("div");
        footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;";

        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.textContent = "Cancel";
        cancelBtn.style.cssText = [
          "padding:8px 10px",
          "border-radius:8px",
          "border:1px solid rgba(148,163,184,0.4)",
          "background:#0b1220",
          "color:#cbd5e1",
          "cursor:pointer"
        ].join(";");
        cancelBtn.onclick = () => close("");
        footer.appendChild(cancelBtn);

        card.appendChild(footer);
        root.appendChild(card);
        root.onclick = (event) => {
          if (event.target === root) close("");
        };
        document.body.appendChild(root);
      });
    }

    function patchLinuxDisplaySourceSelection() {
      try {
        if (!process || process.platform !== "linux") return;
      } catch (_e) {
        return;
      }

      const electronApi = window && window.electron ? window.electron : null;
      if (!electronApi) return;
      if (typeof electronApi.selectDisplayMediaSource !== "function") return;
      if (typeof electronApi.getDesktopSources !== "function") return;
      if (electronApi.__bfSelectDisplayMediaPatched) return;

      try {
        electronApi.__bfSelectDisplayMediaPatched = true;
      } catch (_e) {}
      try {
        console.info("[BetterFluxer] Linux display source selection patch active (pass-through mode).");
      } catch (_e) {}
      logLinuxDisplaySources("patch-start").catch(() => {});
    }

    patchLinuxDisplayCapture();
    patchLinuxDisplaySourceSelection();

    function createLogger(pluginId) {
      return {
        info: (...args) => console.info("[BetterFluxer:" + pluginId + "]", ...args),
        warn: (...args) => console.warn("[BetterFluxer:" + pluginId + "]", ...args),
        error: (...args) => console.error("[BetterFluxer:" + pluginId + "]", ...args),
        debug: (...args) => console.debug("[BetterFluxer:" + pluginId + "]", ...args)
      };
    }

    function ensureToastHost() {
      if (runtime.ui.toastHost && document.body && document.body.contains(runtime.ui.toastHost)) {
        return runtime.ui.toastHost;
      }
      if (!document || !document.body) return null;
      const existing = document.getElementById("bf-toast-host");
      if (existing) {
        runtime.ui.toastHost = existing;
        return existing;
      }
      const host = document.createElement("div");
      host.id = "bf-toast-host";
      host.style.cssText = [
        "position:fixed",
        "top:14px",
        "right:14px",
        "z-index:2147483647",
        "display:flex",
        "flex-direction:column",
        "gap:8px",
        "pointer-events:none",
        "max-width:420px"
      ].join(";");
      document.body.appendChild(host);
      runtime.ui.toastHost = host;
      return host;
    }

    function showToast(message, tone) {
      const host = ensureToastHost();
      if (!host) return;
      const type = String(tone || "info").toLowerCase();
      const bg =
        type === "success" ? "rgba(16, 185, 129, 0.97)" : type === "error" ? "rgba(220, 38, 38, 0.97)" : "rgba(17, 24, 39, 0.97)";
      const toast = document.createElement("div");
      toast.style.cssText = [
        "pointer-events:auto",
        "color:#fff",
        "background:" + bg,
        "padding:10px 12px",
        "border-radius:8px",
        "font-size:12px",
        "line-height:1.35",
        "box-shadow:0 8px 24px rgba(0,0,0,0.35)",
        "border:1px solid rgba(255,255,255,0.22)",
        "opacity:0",
        "transform:translateY(-6px)",
        "transition:opacity .18s ease, transform .18s ease"
      ].join(";");
      toast.textContent = String(message || "");
      host.appendChild(toast);
      requestAnimationFrame(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
      });
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(-6px)";
        setTimeout(() => {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 220);
      }, 3200);
    }

    function debugUiLog(label, payload) {
      try {
        console.log("[BetterFluxer:UI Debug] " + String(label || ""), payload || null);
      } catch (_e) {}
    }

    function normalizeIconDataUrl(input) {
      const raw = String(input || "").trim();
      if (!raw) return "";
      if (/^data:image\\/[a-z0-9.+-]+;base64,/i.test(raw)) return raw;
      const compact = raw.replace(/\s+/g, "");
      if (/^[a-z0-9+/=]+$/i.test(compact) && compact.length > 64) {
        return "data:image/png;base64," + compact;
      }
      return "";
    }

    function normalizeCssColor(input) {
      const raw = String(input || "").trim();
      if (!raw) return "";
      if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)) return raw;
      if (/^rgba?\\([^)]+\\)$/i.test(raw)) return raw;
      if (/^hsla?\\([^)]+\\)$/i.test(raw)) return raw;
      if (/^[a-z]+$/i.test(raw)) return raw;
      return "";
    }

    function applyCustomSplashIcon(root) {
      const dataUrl = normalizeIconDataUrl(CUSTOM_SPLASH_ICON_DATA_URL);
      const pulseColor = normalizeCssColor(CUSTOM_SPLASH_PULSE_COLOR);
      if (!dataUrl && !pulseColor) return false;
      const scope = root && root.querySelectorAll ? root : document;
      const wrappers = scope.querySelectorAll("div[class*='SplashScreen'][class*='iconWrapper']");
      if (!wrappers.length) return false;
      let changed = false;
      for (const wrap of wrappers) {
        if (!wrap || !wrap.querySelectorAll) continue;
        if (dataUrl) {
          let img = wrap.querySelector("img[data-bf-custom-splash-icon='1']");
          if (!img) {
            img = document.createElement("img");
            img.setAttribute("data-bf-custom-splash-icon", "1");
            img.setAttribute("alt", "BetterFluxer custom icon");
            img.style.width = "100%";
            img.style.height = "100%";
            img.style.objectFit = "contain";
            img.style.pointerEvents = "none";
            const pulse = wrap.querySelector("div[class*='iconPulse']");
            if (pulse && pulse.nextSibling) {
              wrap.insertBefore(img, pulse.nextSibling);
            } else {
              wrap.appendChild(img);
            }
            changed = true;
          }
          if (img.getAttribute("src") !== dataUrl) {
            img.setAttribute("src", dataUrl);
            changed = true;
          }
          const svgs = wrap.querySelectorAll("svg");
          for (const svg of svgs) {
            svg.style.setProperty("display", "none", "important");
            svg.style.setProperty("visibility", "hidden", "important");
          }
        }
        if (pulseColor) {
          const pulse = wrap.querySelector("div[class*='iconPulse']");
          if (pulse) {
            pulse.style.setProperty("background", pulseColor, "important");
            pulse.style.setProperty("border-color", pulseColor, "important");
            pulse.style.setProperty("box-shadow", "0 0 28px " + pulseColor, "important");
            changed = true;
          }
        }
      }
      return changed;
    }

    function getBetterFluxerBuildLabel() {
      const versionText = String(BETTERFLUXER_VERSION || "dev").trim() || "dev";
      const checksumText = String(BETTERFLUXER_CHECKSUM || "").trim();
      if (checksumText) {
        return "BetterFluxer " + versionText + " (chk:" + checksumText + ")";
      }
      return "BetterFluxer " + versionText;
    }

    function injectClientInfoVersionLine(root) {
      const scope = root && root.querySelectorAll ? root : document;
      const targets = scope.querySelectorAll("button[class*='ClientInfo'][class*='button']");
      if (!targets || !targets.length) return false;
      const lineText = getBetterFluxerBuildLabel();
      let changed = false;
      for (const btn of targets) {
        if (!btn || !btn.appendChild) continue;
        let line = btn.querySelector("[data-bf-client-info-version='1']");
        if (!line) {
          line = document.createElement("span");
          line.setAttribute("data-bf-client-info-version", "1");
          btn.appendChild(line);
          changed = true;
        }
        if (line.textContent !== lineText) {
          line.textContent = lineText;
          changed = true;
        }
      }
      return changed;
    }

    function createStorage(pluginId) {
      const base = runtime.storePrefix + pluginId + ":";
      return {
        get: (key, fallback) => {
          try {
            const raw = localStorage.getItem(base + key);
            return raw == null ? fallback : JSON.parse(raw);
          } catch (_e) {
            return fallback;
          }
        },
        set: (key, value) => {
          localStorage.setItem(base + key, JSON.stringify(value));
          return value;
        },
        delete: (key) => {
          localStorage.removeItem(base + key);
        }
      };
    }

    function getPluginEnabled(pluginId, fallback) {
      try {
        const raw = localStorage.getItem(key("pluginEnabled:" + pluginId));
        return raw == null ? fallback : JSON.parse(raw);
      } catch (_e) {
        return fallback;
      }
    }

    function setPluginEnabled(pluginId, enabled) {
      localStorage.setItem(key("pluginEnabled:" + pluginId), JSON.stringify(Boolean(enabled)));
    }

    function stripJsExtension(name) {
      const value = String(name || "");
      if (value.toLowerCase().endsWith(".js")) {
        return value.slice(0, -3);
      }
      return value;
    }

    function normalizeRemoteUrl(rawUrl) {
      try {
        const parsed = new URL(String(rawUrl || ""));
        while (parsed.pathname.includes("//")) {
          parsed.pathname = parsed.pathname.split("//").join("/");
        }
        return parsed.toString();
      } catch (_e) {
        return String(rawUrl || "");
      }
    }

    function getApiProxyBaseUrl() {
      try {
        if (typeof AP_PROXY_BASE_URL === "string" && AP_PROXY_BASE_URL) {
          return AP_PROXY_BASE_URL;
        }
      } catch (_e) {}
      try {
        if (window.electron && typeof window.electron.getApiProxyUrl === "function") {
          return window.electron.getApiProxyUrl();
        }
      } catch (_e) {}
      return null;
    }

    function getApiProxyCandidates() {
      const candidates = [];
      const push = (value) => {
        if (!value || typeof value !== "string") return;
        if (!candidates.includes(value)) candidates.push(value);
      };
      push(getApiProxyBaseUrl());
      push("http://127.0.0.1:21863/proxy");
      push("http://127.0.0.1:21864/proxy");
      push("http://127.0.0.1:21861/proxy");
      return candidates;
    }

    function getInternalApiProxyCandidates() {
      const candidates = [];
      const push = (value) => {
        if (!value || typeof value !== "string") return;
        if (!candidates.includes(value)) candidates.push(value);
      };
      push(getApiProxyBaseUrl());
      push("http://127.0.0.1:21861/proxy");
      return candidates;
    }

    function buildProxyUrl(base, targetUrl) {
      if (!base) return null;
      return String(base) + "?target=" + encodeURIComponent(String(targetUrl || ""));
    }

    async function fetchViaIpcBridge(url, responseType) {
      if (
        typeof import_electron === "undefined" ||
        !import_electron ||
        !import_electron.ipcRenderer ||
        typeof import_electron.ipcRenderer.invoke !== "function"
      ) {
        throw new Error("IPC bridge unavailable");
      }
      const payload = {
        url: String(url || ""),
        responseType: responseType === "text" ? "text" : "json",
        timeoutMs: 15000
      };
      const result = await import_electron.ipcRenderer.invoke("betterfluxer:fetch-url", payload);
      if (!result || result.ok !== true) {
        throw new Error(String((result && result.error) || "IPC fetch failed"));
      }
      if (responseType === "text") {
        return String(result.text || "");
      }
      if (typeof result.text === "string" && result.text) {
        return JSON.parse(result.text);
      }
      return result.json != null ? result.json : {};
    }

    async function fetchViaElectronNet(url, responseType, options) {
      const electronNet =
        typeof import_electron !== "undefined" && import_electron && import_electron.net ? import_electron.net : null;
      if (!electronNet) {
        throw new Error("Electron net unavailable");
      }
      const requestHeaders =
        options && options.headers && typeof options.headers === "object" ? options.headers : null;

      if (typeof electronNet.fetch === "function") {
        try {
          const response = await electronNet.fetch(String(url), {
            cache: "no-store",
            headers: requestHeaders || undefined
          });
          if (!response || !response.ok) {
            throw new Error("Electron net HTTP " + (response ? response.status : "unknown"));
          }
          if (responseType === "text") return response.text();
          return response.json();
        } catch (error) {
          throw new Error("Electron net fetch failed: " + String((error && error.message) || error || "unknown"));
        }
      }

      if (typeof electronNet.request === "function") {
        return new Promise((resolve, reject) => {
          try {
            const request = electronNet.request({
              method: "GET",
              url: String(url),
              headers: requestHeaders || undefined
            });
            const chunks = [];

            request.on("response", (response) => {
              const status = Number(response && response.statusCode ? response.statusCode : 0);
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.on("error", (error) => {
                reject(new Error("Electron net response failed: " + String((error && error.message) || error)));
              });
              response.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                if (status < 200 || status >= 300) {
                  reject(new Error("Electron net HTTP " + status));
                  return;
                }
                try {
                  if (responseType === "text") {
                    resolve(body);
                  } else {
                    resolve(JSON.parse(body));
                  }
                } catch (error) {
                  reject(new Error("Electron net parse failed: " + String((error && error.message) || error)));
                }
              });
            });
            request.on("error", (error) => {
              reject(new Error("Electron net request failed: " + String((error && error.message) || error)));
            });
            request.end();
          } catch (error) {
            reject(new Error("Electron net request setup failed: " + String((error && error.message) || error)));
          }
        });
      }

      throw new Error("Electron net request unavailable");
    }

    async function fetchViaElectronApiProxy(targetUrl, responseType) {
      const candidates = getInternalApiProxyCandidates();
      const errors = [];
      for (const base of candidates) {
        const proxyUrl = buildProxyUrl(base, targetUrl);
        if (!proxyUrl) continue;
        try {
          return await fetchViaElectronNet(proxyUrl, responseType, {
            headers: {
              "x-fluxer-proxy-initiator": String(targetUrl || "")
            }
          });
        } catch (error) {
          errors.push(String((error && error.message) || error || "unknown"));
        }
      }
      throw new Error("Electron proxy failed: " + errors.join(" | "));
    }

    async function fetchViaNode(url, responseType, options) {
      const redirectLimit = Number(options && options.redirectLimit != null ? options.redirectLimit : 5);
      const timeoutMs = Number(options && options.timeoutMs != null ? options.timeoutMs : 15000);
      return new Promise((resolve, reject) => {
        try {
          if (typeof require !== "function") {
            reject(new Error("Node require unavailable"));
            return;
          }

          const headers = options && options.headers && typeof options.headers === "object" ? options.headers : {};
          const parsed = new URL(String(url));
          const loadNodeModule = (names) => {
            for (const moduleName of names || []) {
              try {
                return require(moduleName);
              } catch (_) {}
            }
            return null;
          };
          const client =
            parsed.protocol === "https:"
              ? loadNodeModule(["node:https", "https"])
              : loadNodeModule(["node:http", "http"]);
          if (!client || typeof client.request !== "function") {
            reject(new Error("Node HTTP modules unavailable"));
            return;
          }
          const request = client.request(
            {
              protocol: parsed.protocol,
              hostname: parsed.hostname,
              port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
              method: "GET",
              path: parsed.pathname + parsed.search,
              headers: {
                "User-Agent": "BetterFluxer/1.0"
                ,
                ...headers
              }
            },
            (res) => {
              const status = Number(res.statusCode || 0);
              if (status >= 300 && status < 400 && res.headers && res.headers.location) {
                if (redirectLimit <= 0) {
                  reject(new Error("Node redirects exceeded for " + String(url)));
                  return;
                }
                const redirectTarget = new URL(String(res.headers.location), parsed).toString();
                fetchViaNode(redirectTarget, responseType, {
                  ...options,
                  redirectLimit: redirectLimit - 1
                }).then(resolve).catch(reject);
                return;
              }

              const chunks = [];
              res.setEncoding("utf8");
              res.on("data", (chunk) => chunks.push(String(chunk)));
              res.on("error", (error) => {
                reject(new Error("Node response failed: " + String((error && error.message) || error)));
              });
              res.on("end", () => {
                const body = chunks.join("");
                if (status < 200 || status >= 300) {
                  reject(new Error("Node HTTP " + status + " for " + String(url)));
                  return;
                }
                try {
                  if (responseType === "text") {
                    resolve(body);
                  } else {
                    resolve(JSON.parse(body));
                  }
                } catch (error) {
                  reject(new Error("Node parse failed: " + String((error && error.message) || error)));
                }
              });
            }
          );

          request.on("error", (error) => reject(new Error("Node request failed: " + String((error && error.message) || error))));
          request.setTimeout(timeoutMs, () => {
            try {
              request.destroy(new Error("timeout"));
            } catch (_) {}
            reject(new Error("Node request timeout for " + String(url)));
          });
          request.end();
        } catch (error) {
          reject(new Error("Node fetch failed: " + String((error && error.message) || error)));
        }
      });
    }

    async function fetchViaNodeProxy(targetUrl, responseType) {
      const candidates = getApiProxyCandidates();
      const errors = [];
      for (const base of candidates) {
        const proxyUrl = buildProxyUrl(base, targetUrl);
        if (!proxyUrl) continue;
        try {
          return await fetchViaNode(proxyUrl, responseType, {
            headers: {
              "x-fluxer-proxy-initiator": String(targetUrl || "")
            }
          });
        } catch (error) {
          errors.push(String((error && error.message) || error || "unknown"));
        }
      }
      throw new Error("Node proxy failed: " + errors.join(" | "));
    }

    async function fetchThroughProxy(url, responseType) {
      const errors = [];

      if (ENABLE_BETTERFLUXER_IPC_BRIDGE) {
        try {
          return await fetchViaIpcBridge(url, responseType);
        } catch (error) {
          errors.push("ipc-bridge: " + String((error && error.message) || error || "unknown"));
        }
      }

      try {
        return await fetchViaElectronNet(url, responseType);
      } catch (error) {
        errors.push("electron-net: " + String((error && error.message) || error || "unknown"));
      }

      try {
        return await fetchViaElectronApiProxy(url, responseType);
      } catch (error) {
        errors.push("electron-proxy: " + String((error && error.message) || error || "unknown"));
      }

      try {
        return await fetchViaNode(url, responseType);
      } catch (error) {
        errors.push("node-direct: " + String((error && error.message) || error || "unknown"));
      }

      try {
        return await fetchViaNodeProxy(url, responseType);
      } catch (error) {
        errors.push("node-proxy: " + String((error && error.message) || error || "unknown"));
      }

      throw new Error("Store fetch failed. " + errors.join(" | "));
    }

    function loadStoredPluginDefs() {
      try {
        const raw = localStorage.getItem(key("storedPluginDefs"));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry) => entry && typeof entry.id === "string" && typeof entry.code === "string");
      } catch (_e) {
        return [];
      }
    }

    function saveStoredPluginDefs(list) {
      localStorage.setItem(key("storedPluginDefs"), JSON.stringify(list || []));
    }

    function mergeDefs(baseDefs, extraDefs) {
      const out = [];
      const seen = new Set();
      const pushDef = (def) => {
        if (!def || typeof def.id !== "string") return;
        const id = String(def.id);
        if (seen.has(id)) {
          const idx = out.findIndex((x) => x.id === id);
          if (idx !== -1) out[idx] = def;
          return;
        }
        seen.add(id);
        out.push(def);
      };
      for (const d of baseDefs || []) pushDef(d);
      for (const d of extraDefs || []) pushDef(d);
      return out;
    }

    runtime.storedPluginDefs = loadStoredPluginDefs();
    defs = mergeDefs(defs, runtime.storedPluginDefs);

    function upsertStoredPluginDef(def) {
      const id = String(def.id);
      runtime.storedPluginDefs = runtime.storedPluginDefs.filter((entry) => entry.id !== id);
      runtime.storedPluginDefs.push({
        id,
        code: String(def.code || ""),
        name: def.name || id,
        url: def.url || null,
        installedAt: new Date().toISOString()
      });
      saveStoredPluginDefs(runtime.storedPluginDefs);
    }

    function removeStoredPluginDef(pluginId) {
      const id = String(pluginId || "");
      const before = runtime.storedPluginDefs.length;
      runtime.storedPluginDefs = runtime.storedPluginDefs.filter((entry) => entry.id !== id);
      if (runtime.storedPluginDefs.length !== before) {
        saveStoredPluginDefs(runtime.storedPluginDefs);
        return true;
      }
      return false;
    }

    function isStoredPlugin(pluginId) {
      const id = String(pluginId || "");
      return runtime.storedPluginDefs.some((entry) => entry.id === id);
    }

    function makeUniquePluginId(baseId) {
      const normalizedBase = String(baseId || "manual-plugin").trim() || "manual-plugin";
      let candidate = normalizedBase;
      let index = 2;
      const hasId = (id) => defs.some((entry) => entry && String(entry.id) === id);
      while (hasId(candidate)) {
        candidate = normalizedBase + "-" + String(index);
        index += 1;
      }
      return candidate;
    }

    function removePlugin(pluginId) {
      const id = String(pluginId || "");
      if (!id) return false;
      const existing = getRecord(id);
      if (existing) {
        stopPlugin(existing);
      }
      runtime.plugins = runtime.plugins.filter((entry) => entry.id !== id);
      defs = defs.filter((entry) => String(entry.id) !== id);
      runtime.store.items = (runtime.store.items || []).filter((item) => String(item.id) !== id);
      removeStoredPluginDef(id);
      try {
        localStorage.removeItem(key("pluginEnabled:" + id));
      } catch (_e) {}
      showToast("Plugin removed: " + id, "success");
      return true;
    }

    function upsertDefinition(def) {
      const id = String(def.id);
      const idx = defs.findIndex((entry) => entry.id === id);
      if (idx === -1) {
        defs.push(def);
      } else {
        defs[idx] = def;
      }
    }

    function getOfflineStoreItems() {
      const seen = new Set();
      return (defs || [])
        .filter((def) => def && (typeof def.id === "string" || typeof def.name === "string"))
        .map((def) => ({
          id: String(def.id || stripJsExtension(def.name || "plugin-" + randomId())),
          name: String(def.name || def.id || "plugin"),
          manifest: null,
          url: def.url ? normalizeRemoteUrl(String(def.url)) : null,
          code: typeof def.code === "string" ? def.code : null,
          source: "offline"
        }))
        .filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
    }

    function createDisabledPluginRecord(id) {
      return {
        id,
        instance: null,
        patcher: createPatcher(),
        enabled: false,
        api: null
      };
    }

    function applyPluginDefinition(def, forceEnabled) {
      const id = String(def.id);
      upsertDefinition(def);
      const idx = runtime.plugins.findIndex((p) => p.id === id);
      if (idx !== -1) {
        stopPlugin(runtime.plugins[idx]);
      }

      const shouldEnable = forceEnabled === true ? true : getPluginEnabled(id, true);
      if (!shouldEnable) {
        const disabled = createDisabledPluginRecord(id);
        if (idx === -1) runtime.plugins.push(disabled);
        else runtime.plugins[idx] = disabled;
        return true;
      }

      const started = startPlugin(def);
      if (!started) {
        const disabled = createDisabledPluginRecord(id);
        if (idx === -1) runtime.plugins.push(disabled);
        else runtime.plugins[idx] = disabled;
        return false;
      }

      if (idx === -1) runtime.plugins.push(started);
      else runtime.plugins[idx] = started;
      setPluginEnabled(id, true);
      return true;
    }

    async function loadStoreIndex() {
      runtime.store.loading = true;
      runtime.store.error = null;
      runtime.store.remoteError = null;
      const offlineItems = getOfflineStoreItems();
      const snapshotItems = Array.isArray(runtime.store.indexSnapshot)
        ? runtime.store.indexSnapshot
            .filter((item) => item && (item.manifest || item.url || item.code))
            .map((item) => ({
              id: String(item.id || stripJsExtension(item.name || "plugin-" + randomId())),
              name: String(item.name || item.id || "plugin"),
              manifest: item.manifest ? normalizeRemoteUrl(String(item.manifest)) : null,
              url: item.url ? normalizeRemoteUrl(String(item.url)) : null,
              code: typeof item.code === "string" ? item.code : null,
              source: item.source ? String(item.source) : "snapshot"
            }))
        : [];
      if (runtime.store.items.length === 0 && offlineItems.length > 0) {
        runtime.store.items = offlineItems.slice();
      }
      try {
        const payload = await fetchThroughProxy(runtime.store.indexUrl, "json");
        let items = [];
        if (Array.isArray(payload)) {
          items = payload;
        } else if (payload && Array.isArray(payload.plugins)) {
          items = payload.plugins;
        } else if (payload && payload.data && Array.isArray(payload.data.plugins)) {
          items = payload.data.plugins;
        } else if (payload && Array.isArray(payload.items)) {
          items = payload.items;
        }
        runtime.store.items = items
          .filter((item) => item && (item.manifest || item.url || item.code))
          .map((item) => ({
            id: String(item.id || stripJsExtension(item.name || "plugin-" + randomId())),
            name: String(item.name || item.id || "plugin"),
            manifest: item.manifest ? normalizeRemoteUrl(String(item.manifest)) : null,
            url: item.url ? normalizeRemoteUrl(String(item.url)) : null,
            code: typeof item.code === "string" ? item.code : null,
            source: item.source ? String(item.source) : "remote"
          }));
        if (runtime.store.items.length === 0 && offlineItems.length > 0) {
          runtime.store.items = offlineItems;
        }
        return runtime.store.items;
      } catch (error) {
        const remoteMessage = String((error && error.message) || error || "Store fetch failed");
        runtime.store.items = snapshotItems.length > 0 ? snapshotItems : offlineItems;
        runtime.store.remoteError = remoteMessage;
        runtime.store.error =
          runtime.store.items.length > 0
            ? "Remote store unavailable. Showing cached plugins."
            : remoteMessage;
        return runtime.store.items;
      } finally {
        runtime.store.loading = false;
      }
    }

    async function installStorePlugin(item) {
      const target = item || {};
      try {
        if (typeof target.code === "string" && target.code.trim()) {
          const def = {
            id: String(target.id || stripJsExtension(target.name || "plugin-" + randomId())),
            code: String(target.code),
            name: String(target.name || target.id || "plugin"),
            url: target.url ? normalizeRemoteUrl(String(target.url)) : null
          };
          upsertStoredPluginDef(def);
          const ok = applyPluginDefinition(def, true);
          showToast(ok ? "Plugin installed: " + def.id : "Plugin install failed: " + def.id, ok ? "success" : "error");
          return ok;
        }

        const manifestUrl = target.manifest ? normalizeRemoteUrl(String(target.manifest)) : "";
        let resolvedId = String(target.id || stripJsExtension(target.name || "plugin-" + randomId()));
        let resolvedName = String(target.name || resolvedId);
        let resolvedUrl = target.url ? normalizeRemoteUrl(String(target.url)) : "";

        if (manifestUrl) {
          const manifest = await fetchThroughProxy(manifestUrl, "json");
          resolvedId = String(manifest.id || resolvedId);
          resolvedName = String(manifest.name || resolvedName);
          const main = String(manifest.main || "index.js");
          resolvedUrl = normalizeRemoteUrl(new URL(main, manifestUrl).toString());
        }

        if (!resolvedUrl) return false;
        const code = await fetchThroughProxy(resolvedUrl, "text");
        const def = {
          id: resolvedId,
          code,
          name: resolvedName,
          url: resolvedUrl
        };
        upsertStoredPluginDef(def);
        const ok = applyPluginDefinition(def, true);
        showToast(ok ? "Plugin installed: " + def.id : "Plugin install failed: " + def.id, ok ? "success" : "error");
        return ok;
      } catch (error) {
        runtime.store.error = String((error && error.message) || error || "Install failed");
        showToast("Plugin install failed", "error");
        return false;
      }
    }

    async function installManualPlugin(nameInput, codeInput) {
      const code = String(codeInput || "");
      const trimmedCode = code.trim();
      if (!trimmedCode) {
        runtime.ui.manualInstallMessage = "Plugin JS is required.";
        return false;
      }

      const name = String(nameInput || "").trim();
      const baseId = stripJsExtension(name || "manual-plugin-" + randomId())
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const pluginId = makeUniquePluginId(baseId || "manual-plugin-" + randomId());

      const def = {
        id: pluginId,
        name: name || pluginId,
        code: trimmedCode,
        url: null
      };

      upsertStoredPluginDef(def);
      const ok = applyPluginDefinition(def, true);
      runtime.ui.manualInstallMessage = ok
        ? "Installed plugin: " + def.name
        : "Install failed. Check console for details.";
      showToast(
        ok ? "Plugin installed: " + String(def.name || def.id) : "Plugin install failed: " + String(def.name || def.id),
        ok ? "success" : "error"
      );
      return ok;
    }

    class BaseDOMClass {
      query(selector, root) {
        try {
          return (root || document).querySelector(selector);
        } catch (_e) {
          return null;
        }
      }

      queryAll(selector, root) {
        try {
          return Array.from((root || document).querySelectorAll(selector));
        } catch (_e) {
          return [];
        }
      }

      text(node) {
        return node ? String(node.textContent || "").trim() : "";
      }
    }

    class SettingsSidebarClass extends BaseDOMClass {
      getContainer() {
        return (
          this.query("nav.SettingsModalLayout.module__sidebarNavWrapper___XzU3Zj") ||
          this.query("nav[class*=sidebarNavWrapper]") ||
          this.query("nav")
        );
      }

      getItems() {
        const container = this.getContainer();
        if (!container) return [];
        return this.queryAll("button[id^='settings-tab-']", container).map((node) => ({
          id: node.id,
          label: this.text(node),
          element: node
        }));
      }

      clickById(tabId) {
        const node = this.query("#settings-tab-" + String(tabId).replace(/^settings-tab-/, ""));
        if (!node) return false;
        node.click();
        return true;
      }
    }

    class UserProfileClass extends BaseDOMClass {
      constructor(settingsSidebar) {
        super();
        this.settingsSidebar = settingsSidebar;
        this.currentUser = null;
        this.listeners = new Set();
        this.networkCaptureAttached = false;
      }

      getSidebarName() {
        const profileLabel =
          this.query("button#settings-tab-my_profile span") ||
          this.query("[id='settings-tab-my_profile']");
        return this.text(profileLabel);
      }

      openProfileSettings() {
        return this.settingsSidebar.clickById("my_profile");
      }

      isUserObject(value) {
        if (!value || typeof value !== "object") return false;
        if (!("id" in value) || !("username" in value)) return false;
        const id = value.id;
        const username = value.username;
        if (typeof id !== "string" && typeof id !== "number") return false;
        if (typeof username !== "string") return false;
        return true;
      }

      cloneSafe(value) {
        try {
          return JSON.parse(JSON.stringify(value));
        } catch (_e) {
          return value;
        }
      }

      ingestUser(user, source) {
        if (!this.isUserObject(user)) return null;
        const snapshot = this.cloneSafe(user);
        this.currentUser = {
          source: source || "unknown",
          capturedAt: new Date().toISOString(),
          data: snapshot
        };
        for (const listener of this.listeners) {
          try {
            listener(this.currentUser);
          } catch (_e) {}
        }
        return this.currentUser;
      }

      fromDebugJson(jsonOrObject) {
        if (typeof jsonOrObject === "string") {
          try {
            return this.ingestUser(JSON.parse(jsonOrObject), "debug-json");
          } catch (_e) {
            return null;
          }
        }
        return this.ingestUser(jsonOrObject, "debug-object");
      }

      getCurrentUser() {
        if (this.currentUser) return this.currentUser;
        return this.captureCurrentUser();
      }

      getCurrentUserData() {
        const current = this.getCurrentUser();
        return current ? current.data : null;
      }

      onUpdate(callback) {
        if (typeof callback !== "function") return () => {};
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
      }

      findUserDeep(input, depth) {
        if (depth > 5 || !input || typeof input !== "object") return null;
        if (this.isUserObject(input)) return input;

        const entries = Array.isArray(input) ? input.entries() : Object.entries(input);
        let checked = 0;
        for (const pair of entries) {
          const value = Array.isArray(input) ? pair[1] : pair[1];
          checked += 1;
          if (checked > 80) break;
          const found = this.findUserDeep(value, depth + 1);
          if (found) return found;
        }
        return null;
      }

      captureCurrentUser() {
        const directCandidates = [
          window.__BETTERFLUXER_DEBUG_USER,
          window.__INITIAL_STATE__,
          window.__APP_STATE__,
          window.__NEXT_DATA__,
          window.fluxer,
          window.Fluxer
        ];

        for (const candidate of directCandidates) {
          const found = this.findUserDeep(candidate, 0);
          if (found) {
            return this.ingestUser(found, "window-state");
          }
        }

        return null;
      }

      attachNetworkCapture() {
        if (this.networkCaptureAttached) return;
        this.networkCaptureAttached = true;

        const shouldCaptureUrl = (url) => {
          const u = String(url || "").toLowerCase();
          return (
            u.includes("/users/@me") ||
            u.includes("/auth/me") ||
            u.includes("/users/me") ||
            u.includes("/profile")
          );
        };

        const originalFetch = window.fetch;
        if (typeof originalFetch === "function") {
          const self = this;
          window.fetch = async function betterFluxerCapturedFetch(...args) {
            const response = await originalFetch.apply(this, args);
            try {
              const url = (args && args[0] && args[0].url) || args[0];
              if (shouldCaptureUrl(url) && response && typeof response.clone === "function") {
                const clone = response.clone();
                clone
                  .json()
                  .then((payload) => {
                    const found = self.findUserDeep(payload, 0);
                    if (found) self.ingestUser(found, "fetch");
                  })
                  .catch(() => {});
              }
            } catch (_e) {}
            return response;
          };
        }
      }
    }

    class MessagesClass extends BaseDOMClass {
      getComposer() {
        return (
          this.query("textarea") ||
          this.query("[contenteditable='true'][role='textbox']")
        );
      }

      getVisibleMessages() {
        return this.queryAll("article, [id^='message-'], [class*=message]");
      }

      sendMessage(text) {
        const value = String(text || "");
        const composer = this.getComposer();
        if (!composer) return false;

        if (composer.tagName === "TEXTAREA") {
          composer.focus();
          composer.value = value;
          composer.dispatchEvent(new Event("input", { bubbles: true }));
          composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
          return true;
        }

        composer.focus();
        composer.textContent = value;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
        return true;
      }
    }

    class GuildListClass extends BaseDOMClass {
      getGuildItems() {
        const selectors = [
          "a[href*='/channels/']",
          "[aria-label*='Servers'] a",
          "[class*=guild] a"
        ];
        for (const selector of selectors) {
          const nodes = this.queryAll(selector);
          if (nodes.length) {
            return nodes.map((node) => ({
              name: node.getAttribute("aria-label") || this.text(node),
              element: node
            }));
          }
        }
        return [];
      }

      clickGuildByName(name) {
        const target = String(name || "").toLowerCase();
        const match = this.getGuildItems().find((guild) => String(guild.name || "").toLowerCase().includes(target));
        if (!match || !match.element) return false;
        match.element.click();
        return true;
      }
    }

    class ChannelsClass extends BaseDOMClass {
      getChannelItems() {
        const selectors = [
          "a[href*='/channels/'][href*='/']",
          "[role='treeitem']",
          "[class*=channel]"
        ];
        for (const selector of selectors) {
          const nodes = this.queryAll(selector);
          if (nodes.length) {
            return nodes.map((node) => ({
              name: node.getAttribute("aria-label") || this.text(node),
              element: node
            }));
          }
        }
        return [];
      }

      clickChannelByName(name) {
        const target = String(name || "").toLowerCase();
        const match = this.getChannelItems().find((channel) =>
          String(channel.name || "").toLowerCase().includes(target)
        );
        if (!match || !match.element) return false;
        match.element.click();
        return true;
      }
    }

    class MembersClass extends BaseDOMClass {
      getMemberItems() {
        const nodes = this.queryAll(
          "span[class*='MemberListItem'][class*='name'], [data-user-id] span[class*='name'], [data-user-id]"
        );
        return nodes
          .map((node) => {
            const carrier = node.closest && typeof node.closest === "function" ? node.closest("[data-user-id]") : null;
            const userId = String((carrier && carrier.getAttribute && carrier.getAttribute("data-user-id")) || (node.getAttribute && node.getAttribute("data-user-id")) || "");
            return {
              id: userId,
              label: this.text(node),
              element: node
            };
          })
          .filter((item) => item.label || item.id);
      }

      clickMemberByName(name) {
        const needle = String(name || "").trim().toLowerCase();
        if (!needle) return false;
        const item = this.getMemberItems().find((it) => String(it.label || "").toLowerCase().includes(needle));
        if (!item || !item.element || typeof item.element.click !== "function") return false;
        item.element.click();
        return true;
      }

      getVisibleMemberIds() {
        const out = [];
        const seen = new Set();
        for (const item of this.getMemberItems()) {
          const id = String(item.id || "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push(id);
        }
        return out;
      }

      getMemberById(userId) {
        const id = String(userId || "").trim();
        if (!id) return null;
        return this.getMemberItems().find((it) => String(it.id) === id) || null;
      }

      clickMemberById(userId) {
        const item = this.getMemberById(userId);
        if (!item || !item.element || typeof item.element.click !== "function") return false;
        item.element.click();
        return true;
      }
    }

    function createUIClasses() {
      const settingsSidebar = new SettingsSidebarClass();
      const userProfile = new UserProfileClass(settingsSidebar);
      userProfile.captureCurrentUser();
      userProfile.attachNetworkCapture();
      return {
        settingsSidebar,
        userProfile,
        messages: new MessagesClass(),
        guildList: new GuildListClass(),
        channels: new ChannelsClass(),
        members: new MembersClass()
      };
    }

    runtime.classTypes = {
      BaseDOMClass,
      SettingsSidebarClass,
      UserProfileClass,
      MessagesClass,
      GuildListClass,
      ChannelsClass,
      MembersClass
    };
    runtime.uiClasses = createUIClasses();

    function randomId() {
      return Math.random().toString(36).slice(2, 10);
    }

    function normalizeCategoryDef(def) {
      const category = def && typeof def === "object" ? def : {};
      const id = String(category.id || "cat-" + randomId());
      const label = String(category.label || "CUSTOM");
      const items = Array.isArray(category.items) ? category.items : [];
      return {
        id,
        label,
        items: items.map((item, idx) => ({
          id: String((item && item.id) || "item-" + idx),
          label: String((item && item.label) || "Item " + (idx + 1)),
          tab: item && typeof item.tab === "string" ? item.tab : null,
          onClick: item && typeof item.onClick === "function" ? item.onClick : null
        }))
      };
    }

    function registerSettingsCategory(def) {
      const normalized = normalizeCategoryDef(def);
      runtime.ui.customCategories = runtime.ui.customCategories.filter((cat) => cat.id !== normalized.id);
      runtime.ui.customCategories.push(normalized);
      injectSettingsCategory();
      return normalized.id;
    }

    function unregisterSettingsCategory(categoryId) {
      const before = runtime.ui.customCategories.length;
      runtime.ui.customCategories = runtime.ui.customCategories.filter((cat) => cat.id !== String(categoryId));
      if (runtime.ui.customCategories.length !== before) {
        injectSettingsCategory();
        return true;
      }
      return false;
    }

    function createPatcher() {
      const unpatches = [];
      function patch(type, target, method, callback) {
        if (!target || typeof target[method] !== "function") return () => {};
        const original = target[method];
        const wrapped = function wrappedPatchedMethod(...args) {
          if (type === "before") {
            callback(args);
            return original.apply(this, args);
          }
          if (type === "instead") {
            return callback(args, original.bind(this));
          }
          const result = original.apply(this, args);
          callback(args, result);
          return result;
        };
        target[method] = wrapped;
        const unpatch = () => {
          if (target[method] === wrapped) target[method] = original;
        };
        unpatches.push(unpatch);
        return unpatch;
      }
      return {
        before: (target, method, callback) => patch("before", target, method, callback),
        after: (target, method, callback) => patch("after", target, method, callback),
        instead: (target, method, callback) => patch("instead", target, method, callback),
        unpatchAll: () => {
          for (let i = unpatches.length - 1; i >= 0; i -= 1) {
            try {
              unpatches[i]();
            } catch (_e) {}
          }
          unpatches.length = 0;
        }
      };
    }

    function getRecord(pluginId) {
      return runtime.plugins.find((plugin) => plugin.id === pluginId) || null;
    }

    function transpilePluginSource(source) {
      const code = String(source || "");
      if (/^\s*export\s+default\s+/m.test(code)) {
        return code.replace(/^\s*export\s+default\s+/m, "module.exports = ");
      }
      return code;
    }

    function normalizePluginExport(rawExport, api) {
      const exported =
        rawExport && typeof rawExport === "object" && "default" in rawExport ? rawExport.default : rawExport;

      if (!exported) return null;

      if (typeof exported === "function") {
        try {
          const instance = new exported(api);
          if (instance && (typeof instance.start === "function" || typeof instance.stop === "function")) {
            return instance;
          }
        } catch (_e) {
          // not a class constructor, try as factory
        }

        try {
          const factoryResult = exported(api);
          if (factoryResult && typeof factoryResult === "object") {
            return factoryResult;
          }
        } catch (_e) {}
      }

      if (typeof exported === "object") {
        return exported;
      }

      return null;
    }

    function startPlugin(def) {
      try {
        const module = { exports: {} };
        const source = transpilePluginSource(def.code);
        const fn = new Function("module", "exports", source);
        fn(module, module.exports);
        const patcher = createPatcher();
        const api = {
          pluginId: def.id,
          logger: createLogger(def.id),
          storage: createStorage(def.id),
          patcher,
          network: {
            fetchJson: async (url) => fetchThroughProxy(String(url || ""), "json"),
            fetchText: async (url) => fetchThroughProxy(String(url || ""), "text")
          },
          ui: runtime.uiClasses,
          classes: runtime.classTypes,
          settings: {
            open: (tabName) => renderPanel(tabName || "plugins"),
            registerCategory: (categoryDef) => registerSettingsCategory(categoryDef),
            unregisterCategory: (categoryId) => unregisterSettingsCategory(categoryId)
          },
          app: {
            getWindow: () => window,
            getDocument: () => document,
            getLocation: () => window.location
          }
        };
        const instance = normalizePluginExport(module.exports, api);
        if (!instance) return null;
        if (typeof instance.start === "function") {
          instance.start(api);
        }
        return { id: def.id, instance, patcher, enabled: true, api };
      } catch (error) {
        console.error("[BetterFluxer] Plugin failed to start:", def.id, error);
        return null;
      }
    }

    function stopPlugin(plugin) {
      if (!plugin) return;
      try {
        if (plugin.instance && typeof plugin.instance.stop === "function") {
          plugin.instance.stop(plugin.api);
        }
      } catch (error) {
        console.error("[BetterFluxer] Plugin failed to stop:", plugin.id, error);
      } finally {
        try {
          plugin.patcher.unpatchAll();
        } catch (_e) {}
        plugin.enabled = false;
      }
    }

    function ensureStyles() {
      if (document.getElementById("betterfluxer-ui-styles")) return;
      const style = document.createElement("style");
      style.id = "betterfluxer-ui-styles";
      style.textContent = [
        ".bf-settings-root{display:block;width:100%;height:100%;min-height:100%;overflow:hidden;}",
        ".bf-panel{width:100%;max-width:820px;height:100%;min-height:100%;margin:0 auto;overflow-x:hidden;overflow-y:auto;background:transparent;color:var(--text-normal,#f4f6f8);border:0;border-radius:0;box-shadow:none;font-family:var(--font-primary,Segoe UI,Tahoma,sans-serif);padding-top:35px;}",
        ".bf-head{display:none;}",
        ".bf-head h2{margin:0;font-size:18px;}",
        ".bf-body{padding:8px 24px 28px 24px;display:grid;gap:28px;min-height:100%;}",
        ".bf-card{background:transparent;border:0;border-radius:0;padding:0;}",
        ".bf-card h3{margin:0 0 14px 0;font-size:var(--header-secondary-size,20px);font-weight:700;line-height:1.2;color:var(--header-primary,#fff);letter-spacing:.01em;}",
        ".bf-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 0;border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));}",
        ".bf-row:first-child{border-top:0;padding-top:0;}",
        ".bf-row-info{min-width:0;}",
        ".bf-row-title{font-size:var(--text-md-normal-size,16px);font-weight:500;line-height:1.2;color:var(--text-normal,#e6edf4);word-break:break-word;}",
        ".bf-row-actions{display:flex;align-items:center;gap:10px;flex-shrink:0;}",
        ".bf-meta{font-size:var(--text-sm-normal-size,12px);color:var(--text-muted,#9cacbe);line-height:1.35;}",
        ".bf-btn{border:1px solid var(--button-outline-brand-border,#3c4754);background:var(--button-secondary-background,#2b3139);color:var(--interactive-normal,#fff);border-radius:8px;padding:6px 12px;min-height:32px;font-size:var(--text-sm-medium-size,13px);font-weight:600;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease;}",
        ".bf-btn:hover{background:var(--button-secondary-background-hover,#353c45);border-color:var(--button-outline-brand-border-hover,#4d5968);}",
        ".bf-btn:active{background:var(--button-secondary-background-active,#1f242b);}",
        ".bf-btn[disabled]{opacity:.6;cursor:not-allowed;}",
        ".bf-toggle{display:inline-flex;align-items:center;gap:10px;font-size:var(--text-md-normal-size,16px);color:var(--text-normal,#d7dee7);}",
        ".bf-toggle input[type='checkbox']{width:16px;height:16px;accent-color:var(--brand-500,#5865f2);}",
        ".bf-switch{position:relative;display:inline-flex;width:40px;height:24px;align-items:center;}",
        ".bf-switch input{position:absolute;opacity:0;width:40px;height:24px;left:0;top:0;cursor:pointer;}",
        ".bf-switch-track{width:40px;height:24px;border-radius:999px;background:var(--background-tertiary,#4f5660);position:relative;transition:background .15s ease;}",
        ".bf-switch-track::after{content:'';position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s ease;}",
        ".bf-switch input:checked + .bf-switch-track{background:var(--brand-500,#5865f2);}",
        ".bf-switch input:checked + .bf-switch-track::after{left:19px;}",
        ".bf-toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:4px;}",
        ".bf-plugins-list{max-height:46vh;overflow-y:auto;overflow-x:hidden;padding-right:2px;}",
        ".bf-manual{margin-top:18px;border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));padding-top:16px;display:grid;gap:10px;}",
        ".bf-manual h4{margin:0;font-size:var(--text-lg-semibold-size,16px);color:var(--header-primary,#fff);font-weight:700;}",
        ".bf-section{margin-top:18px;border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));padding-top:16px;display:grid;gap:10px;}",
        ".bf-section h4{margin:0;font-size:var(--text-lg-semibold-size,16px);color:var(--header-primary,#fff);font-weight:700;}",
        ".bf-plugins-settings{display:grid;gap:10px;}",
        ".bf-plugin-settings-card{padding:10px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));border-radius:8px;background:var(--background-secondary-alt,rgba(0,0,0,.12));display:grid;gap:8px;}",
        ".bf-plugin-settings-title{font-size:14px;font-weight:700;color:var(--header-primary,#fff);}",
        ".bf-plugin-settings-desc{font-size:12px;color:var(--text-muted,#9cacbe);}",
        ".bf-field{display:grid;gap:4px;}",
        ".bf-field label{font-size:var(--text-xs-normal-size,12px);color:var(--text-muted,#9cacbe);}",
        ".bf-input,.bf-textarea{width:100%;box-sizing:border-box;background:var(--input-background,#11151b);color:var(--text-normal,#e9eef5);border:1px solid var(--input-border,#313b47);border-radius:8px;padding:9px 11px;font:12px/1.4 ui-monospace,monospace;transition:border-color .12s ease,box-shadow .12s ease;}",
        ".bf-input:focus,.bf-textarea:focus{outline:none;border-color:var(--brand-500,#5865f2);box-shadow:0 0 0 1px var(--brand-500,#5865f2);}",
        ".bf-input{font-family:var(--font-primary,Segoe UI,Tahoma,sans-serif);}",
        ".bf-textarea{min-height:120px;resize:vertical;}",
        ".bf-error{color:#ff9fa9;font-size:12px;}",
        ".bf-menu-item{margin-top:6px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:#d3dbe4;}",
        ".bf-menu-item:hover{background:rgba(255,255,255,.08);}",
        ".bf-settings-sub{margin-left:16px;border-left:1px solid rgba(120,145,180,.45);padding-left:10px;}",
        ".bf-settings-active{box-shadow:inset 2px 0 0 #6f8bff;}",
        "[data-betterfluxer-settings-entry]{pointer-events:auto !important;}",
        "[data-betterfluxer-settings-entry]{position:relative;z-index:5;}",
        "[data-betterfluxer-settings-entry] *{pointer-events:auto !important;}",
        "[data-bf-action]{pointer-events:auto !important;cursor:pointer !important;}",
        ".bf-panel,.bf-panel *{pointer-events:auto;}",
        "[data-bf-category]{font-size:12px;letter-spacing:.04em;opacity:.9;}"
      ].join("");
      document.head.appendChild(style);
    }

    function getNodeArea(node) {
      if (!node || !node.getBoundingClientRect) return 0;
      const rect = node.getBoundingClientRect();
      return Math.max(0, rect.width) * Math.max(0, rect.height);
    }

    function findSettingsSidebarNode() {
      return (
        document.querySelector("nav [id^='settings-tab-']")?.closest("nav") ||
        document.querySelector("[class*='sidebarNavWrapper']") ||
        document.querySelector("[class*='sidebarNav']")
      );
    }

    function findActiveSettingsTabButton() {
      return (
        document.querySelector("button[id^='settings-tab-'][aria-current='page']") ||
        document.querySelector("button[id^='settings-tab-'][aria-selected='true']") ||
        document.querySelector("button[id^='settings-tab-'][data-state='active']") ||
        document.querySelector("button[id^='settings-tab-']")
      );
    }

    function findActiveSettingsContentNode() {
      const activeTab = findActiveSettingsTabButton();
      const controlledId = String(activeTab?.getAttribute?.("aria-controls") || "").trim();
      if (controlledId) {
        const controlled = document.getElementById(controlledId);
        if (controlled) return controlled;
      }

      const activeTabId = String(activeTab?.id || "").trim();
      if (activeTabId) {
        const byLabelled = document.querySelector("[role='tabpanel'][aria-labelledby='" + activeTabId + "']");
        if (byLabelled) return byLabelled;
      }

      return null;
    }

    function findSettingsContentHost() {
      if (runtime.ui.panel && runtime.ui.panel.parentNode && document.contains(runtime.ui.panel.parentNode)) {
        return runtime.ui.panel.parentNode;
      }
      const activeTab = findActiveSettingsTabButton();

      const controlledId = String(activeTab?.getAttribute?.("aria-controls") || "").trim();
      if (controlledId) {
        const controlled = document.getElementById(controlledId);
        if (controlled) {
          runtime.ui.nativeContentNode = controlled;
          return controlled.parentNode || null;
        }
      }

      const sidebar = findSettingsSidebarNode();
      if (sidebar && sidebar.parentElement) {
        const siblings = Array.from(sidebar.parentElement.children).filter((n) => n !== sidebar && getNodeArea(n) > 40000);
        if (siblings.length) {
          siblings.sort((a, b) => getNodeArea(b) - getNodeArea(a));
          return siblings[0];
        }
      }

      const root = activeTab
        ? activeTab.closest(
            "[class*='SettingsModalLayout'][class*='container'], [class*='SettingsModalLayout'][class*='layout'], [role='dialog']"
          )
        : null;

      const selectors = [
        "[class*='SettingsModalLayout'][class*='contentColumn']",
        "[class*='SettingsModalLayout'][class*='contentView']",
        "[class*='SettingsModalLayout'][class*='contentWrapper']",
        "[class*='SettingsModalLayout'][class*='content']",
        "main[class*='content']",
        "main"
      ];

      const searchRoot = root || document;
      const candidates = [];
      for (const selector of selectors) {
        const nodes = Array.from(searchRoot.querySelectorAll(selector));
        for (const node of nodes) {
          if (!node || candidates.includes(node)) continue;
          const isSidebar =
            node.matches("[class*='sidebar']") ||
            Boolean(node.querySelector?.("[class*='sidebarNavList'], [id^='settings-tab-']"));
          if (isSidebar) continue;
          const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0 };
          if (rect.width < 220 || rect.height < 120) continue;
          candidates.push(node);
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => getNodeArea(b) - getNodeArea(a));
        return candidates[0];
      }
      return null;
    }

    function ensureBetterFluxerContentHost() {
      const nativeNode = findActiveSettingsContentNode();
      if (nativeNode && nativeNode.parentNode) {
        runtime.ui.nativeContentNode = nativeNode;
        runtime.ui.contentHost = nativeNode.parentNode;
      } else if (!runtime.ui.contentHost) {
        runtime.ui.contentHost = findSettingsContentHost();
      }

      if (!runtime.ui.contentHost) return null;
      let host = runtime.ui.contentHost.querySelector("[data-bf-settings-host='1']");
      if (!host) {
        host = document.createElement("div");
        host.setAttribute("data-bf-settings-host", "1");
        host.style.width = "100%";
        host.style.height = "100%";
        host.style.minHeight = "100%";
        host.style.pointerEvents = "auto";
        host.style.display = "none";
        runtime.ui.contentHost.appendChild(host);
      }
      return host;
    }

    function showBetterFluxerContent() {
      const host = ensureBetterFluxerContentHost();
      if (!host || !runtime.ui.panel) return false;

      const nativeNode = runtime.ui.nativeContentNode || findActiveSettingsContentNode();
      if (nativeNode && nativeNode !== host) {
        runtime.ui.nativeContentNode = nativeNode;
        if (!nativeNode.hasAttribute("data-bf-hidden-by")) {
          nativeNode.setAttribute("data-bf-hidden-by", "1");
          nativeNode.setAttribute("data-bf-prev-display", nativeNode.style.display || "");
        }
        nativeNode.style.display = "none";
      }

      if (runtime.ui.panel.parentNode !== host) {
        host.replaceChildren(runtime.ui.panel);
      }
      host.style.display = "block";
      return true;
    }

    function hideBetterFluxerContent() {
      const host = document.querySelector("[data-bf-settings-host='1']");
      if (host) {
        host.style.display = "none";
      }
      const hiddenNodes = Array.from(document.querySelectorAll("[data-bf-hidden-by='1']"));
      for (const node of hiddenNodes) {
        const prev = node.getAttribute("data-bf-prev-display");
        node.style.display = prev == null ? "" : prev;
        node.removeAttribute("data-bf-prev-display");
        node.removeAttribute("data-bf-hidden-by");
      }
      runtime.ui.nativeContentNode = null;
      runtime.ui.nativeContentPrevDisplay = "";
    }

    function primeNativeSettingsContext() {
      const byId = [
        "#settings-tab-advanced",
        "#settings-tab-language",
        "#settings-tab-notifications",
        "#settings-tab-keybinds",
        "#settings-tab-appearance",
        "#settings-tab-my_profile"
      ];
      for (const selector of byId) {
        const button = document.querySelector(selector);
        if (button && typeof button.click === "function") {
          button.click();
          return true;
        }
      }
      return false;
    }

    function renderPanel(tabName) {
      if (tabName === "plugins" || tabName === "settings") {
        runtime.ui.activeTab = tabName;
      }
      ensureStyles();
      if (!runtime.ui.panel) {
        const root = document.createElement("div");
        root.className = "bf-settings-root";
        root.innerHTML = [
          "<div class=\\"bf-panel\\">",
          "  <div class=\\"bf-body\\">",
          "    <div class=\\"bf-card\\" data-bf-card-plugins>",
          "      <h3>Plugins</h3>",
          "      <div class=\\"bf-plugins-list\\" data-bf-plugins></div>",
          "      <div class=\\"bf-manual\\">",
          "        <h4>Manual Install</h4>",
          "        <input class=\\"bf-input\\" type=\\"text\\" data-bf-manual-name placeholder=\\"Plugin name (optional)\\" />",
          "        <textarea class=\\"bf-textarea\\" data-bf-manual-code placeholder=\\"Paste plugin JavaScript here\\"></textarea>",
          "        <div class=\\"bf-toolbar\\">",
          "          <button class=\\"bf-btn\\" data-bf-manual-install>Install JS</button>",
          "          <div class=\\"bf-meta\\" data-bf-manual-status></div>",
          "        </div>",
          "      </div>",
          "    </div>",
          "    <div class=\\"bf-card\\" data-bf-card-settings>",
          "      <h3>Settings</h3>",
          "      <label class=\\"bf-toggle\\">",
          "        <input type=\\"checkbox\\" data-bf-auto-cat />",
          "        Auto-inject BetterFluxer category in settings menu",
          "      </label>",
          "      <div class=\\"bf-section\\">",
          "        <h4>Plugin Settings</h4>",
          "        <div class=\\"bf-plugins-settings\\" data-bf-plugin-settings></div>",
          "        <div class=\\"bf-meta\\" data-bf-plugin-settings-status></div>",
          "      </div>",
          "    </div>",
          "  </div>",
          "</div>"
        ].join("");
        runtime.ui.panel = root;
      }

      if (!runtime.ui.pluginControlCaptureBound) {
        const capturePluginControl = (event) => {
          const targetEl =
            event && event.target && event.target.nodeType === 3
              ? event.target.parentElement
              : event && event.target && event.target.nodeType === 1
                ? event.target
                : null;
          if (!targetEl) return;
          if (!runtime.ui.panel || !document.body || !document.body.contains(runtime.ui.panel)) return;

          const deleteBtn = targetEl.closest ? targetEl.closest("[data-bf-delete-plugin]") : null;
          if (deleteBtn && runtime.ui.panel.contains(deleteBtn)) {
            event.preventDefault();
            event.stopPropagation();
            const pluginId = String(deleteBtn.getAttribute("data-bf-delete-plugin") || "");
            if (!pluginId) return;
            try {
              removePlugin(pluginId);
              runtime.ui.manualInstallMessage = "Deleted plugin: " + pluginId;
              showToast("Deleted plugin: " + pluginId, "success");
              renderPanel("plugins");
            } catch (error) {
              showToast("Delete failed: " + String((error && error.message) || error || "unknown"), "error");
            }
            return;
          }

          const switchWrap = targetEl.closest ? targetEl.closest("[data-bf-switch-plugin]") : null;
          if (switchWrap && runtime.ui.panel.contains(switchWrap)) {
            event.preventDefault();
            event.stopPropagation();
            const pluginId = String(switchWrap.getAttribute("data-bf-switch-plugin") || "");
            const checkbox = switchWrap.querySelector("input[type='checkbox']");
            if (!pluginId || !checkbox) return;
            const next = !Boolean(checkbox.checked);
            checkbox.checked = next;
            try {
              if (window.BetterFluxer && typeof window.BetterFluxer.setPluginEnabled === "function") {
                window.BetterFluxer.setPluginEnabled(pluginId, next);
              } else {
                setPluginEnabled(pluginId, next);
              }
              renderPanel("plugins");
            } catch (error) {
              showToast("Toggle failed: " + String((error && error.message) || error || "unknown"), "error");
            }
          }
        };
        document.addEventListener("pointerdown", capturePluginControl, true);
        document.addEventListener("click", capturePluginControl, true);
        runtime.ui.pluginControlCaptureBound = true;
      }

      const pluginsRoot = runtime.ui.panel.querySelector("[data-bf-plugins]");
      pluginsRoot.innerHTML = "";
      for (const def of defs) {
        const record = getRecord(def.id);
        const row = document.createElement("div");
        row.className = "bf-row";
        const info = document.createElement("div");
        info.className = "bf-row-info";
        info.innerHTML =
          "<div class=\\"bf-row-title\\">" +
          def.id +
          "</div><div class=\\"bf-meta\\">" +
          (record?.enabled ? "Enabled" : "Disabled") +
          "</div>";
        const controls = document.createElement("div");
        controls.className = "bf-row-actions";
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = Boolean(record?.enabled);
        const toggleWrap = document.createElement("label");
        toggleWrap.className = "bf-switch";
        toggleWrap.setAttribute("data-bf-switch-plugin", def.id);
        toggleWrap.style.pointerEvents = "auto";
        const triggerToggle = (event) => {
          if (event) event.stopPropagation();
          const pluginId = String(toggleWrap.getAttribute("data-bf-switch-plugin") || "");
          if (!pluginId) return;
          const next = !Boolean(toggle.checked);
          toggle.checked = next;
          try {
            if (window.BetterFluxer && typeof window.BetterFluxer.setPluginEnabled === "function") {
              window.BetterFluxer.setPluginEnabled(pluginId, next);
            } else {
              setPluginEnabled(pluginId, next);
            }
            renderPanel("plugins");
          } catch (error) {
            showToast("Toggle failed: " + String((error && error.message) || error || "unknown"), "error");
          }
        };
        toggleWrap.onclick = triggerToggle;
        toggle.onchange = (event) => {
          if (event) event.stopPropagation();
          const pluginId = String(toggleWrap.getAttribute("data-bf-switch-plugin") || "");
          if (!pluginId) return;
          const next = Boolean(toggle.checked);
          try {
            if (window.BetterFluxer && typeof window.BetterFluxer.setPluginEnabled === "function") {
              window.BetterFluxer.setPluginEnabled(pluginId, next);
            } else {
              setPluginEnabled(pluginId, next);
            }
            renderPanel("plugins");
          } catch (error) {
            showToast("Toggle failed: " + String((error && error.message) || error || "unknown"), "error");
          }
        };
        const toggleTrack = document.createElement("span");
        toggleTrack.className = "bf-switch-track";
        toggleWrap.appendChild(toggle);
        toggleWrap.appendChild(toggleTrack);
        controls.appendChild(toggleWrap);
        if (isStoredPlugin(def.id)) {
          const removeBtn = document.createElement("button");
          removeBtn.className = "bf-btn";
          removeBtn.type = "button";
          removeBtn.textContent = "Delete";
          removeBtn.setAttribute("data-bf-delete-plugin", def.id);
          removeBtn.style.pointerEvents = "auto";
          const triggerDelete = (event) => {
            if (event) event.stopPropagation();
            const pluginId = String(removeBtn.getAttribute("data-bf-delete-plugin") || "");
            if (!pluginId) return;
            try {
              removePlugin(pluginId);
              runtime.ui.manualInstallMessage = "Deleted plugin: " + pluginId;
              showToast("Deleted plugin: " + pluginId, "success");
              renderPanel("plugins");
            } catch (error) {
              showToast("Delete failed: " + String((error && error.message) || error || "unknown"), "error");
            }
          };
          removeBtn.onclick = triggerDelete;
          controls.appendChild(removeBtn);
        }
        row.appendChild(info);
        row.appendChild(controls);
        pluginsRoot.appendChild(row);
      }

      const manualNameInput = runtime.ui.panel.querySelector("[data-bf-manual-name]");
      const manualCodeInput = runtime.ui.panel.querySelector("[data-bf-manual-code]");
      const manualInstallBtn = runtime.ui.panel.querySelector("[data-bf-manual-install]");
      const manualStatus = runtime.ui.panel.querySelector("[data-bf-manual-status]");
      if (manualStatus) {
        manualStatus.textContent = String(runtime.ui.manualInstallMessage || "");
      }
      if (manualNameInput) {
        manualNameInput.oninput = () => {
          runtime.ui.manualInstallMessage = "";
          if (manualStatus) manualStatus.textContent = "";
        };
      }
      if (manualCodeInput) {
        manualCodeInput.oninput = () => {
          runtime.ui.manualInstallMessage = "";
          if (manualStatus) manualStatus.textContent = "";
        };
      }
      if (manualInstallBtn) {
        manualInstallBtn.onclick = async () => {
          manualInstallBtn.disabled = true;
          runtime.ui.manualInstallMessage = "Installing...";
          if (manualStatus) manualStatus.textContent = runtime.ui.manualInstallMessage;
          try {
            const ok = await installManualPlugin(
              manualNameInput ? manualNameInput.value : "",
              manualCodeInput ? manualCodeInput.value : ""
            );
            if (ok && manualCodeInput) {
              if (manualNameInput) manualNameInput.value = "";
              manualCodeInput.value = "";
            }
          } catch (error) {
            runtime.ui.manualInstallMessage = "Install failed: " + String((error && error.message) || error || "unknown");
          } finally {
            manualInstallBtn.disabled = false;
            if (manualStatus) manualStatus.textContent = runtime.ui.manualInstallMessage || "";
            renderPanel("plugins");
          }
        };
      }

      const autoCatInput = runtime.ui.panel.querySelector("[data-bf-auto-cat]");
      autoCatInput.checked = Boolean(runtime.settings.autoInjectCategory);
      autoCatInput.onchange = () => {
        runtime.settings.autoInjectCategory = Boolean(autoCatInput.checked);
        setCoreSetting("autoInjectCategory", runtime.settings.autoInjectCategory);
        injectSettingsCategory();
      };

      const pluginSettingsRoot = runtime.ui.panel.querySelector("[data-bf-plugin-settings]");
      const pluginSettingsStatus = runtime.ui.panel.querySelector("[data-bf-plugin-settings-status]");
      if (pluginSettingsRoot) {
        pluginSettingsRoot.innerHTML = "";
        const callPlugin = (pluginId, methodName, ...args) => {
          const id = String(pluginId || "");
          const method = String(methodName || "");
          if (!id || !method) return null;
          const plugin = runtime.plugins.find((p) => p && p.id === id);
          if (!plugin || !plugin.instance) return null;
          const fn = plugin.instance[method];
          if (typeof fn !== "function") return null;
          try {
            return fn.apply(plugin.instance, args);
          } catch (_e) {
            return null;
          }
        };
        const applyPluginSetting = (pluginId, key, value) => {
          const id = String(pluginId || "");
          const settingKey = String(key || "");
          if (!id || !settingKey) return null;
          const result = callPlugin(id, "setSettingValue", settingKey, value);
          // Optional compatibility hooks for plugins that need explicit re-apply.
          callPlugin(id, "onSettingChanged", settingKey, value, result);
          callPlugin(id, "refresh");
          callPlugin(id, "processDocument", document);
          try {
            if (runtime.events && typeof runtime.events.emit === "function") {
              runtime.events.emit("plugin:setting:changed", {
                pluginId: id,
                key: settingKey,
                value: value,
                result: result
              });
            }
          } catch (_e) {}
          try {
            window.dispatchEvent(
              new CustomEvent("betterfluxer:plugin-setting-changed", {
                detail: { pluginId: id, key: settingKey, value: value, result: result }
              })
            );
          } catch (_e) {}
          return result;
        };

        let renderedAny = false;
        for (const plugin of runtime.plugins) {
          if (!plugin || !plugin.instance || !plugin.enabled) continue;
          const schema = callPlugin(plugin.id, "getSettingsSchema");
          if (!schema || !Array.isArray(schema.controls) || !schema.controls.length) continue;
          renderedAny = true;

          const card = document.createElement("div");
          card.className = "bf-plugin-settings-card";

          const title = document.createElement("div");
          title.className = "bf-plugin-settings-title";
          title.textContent = String(schema.title || plugin.id);
          card.appendChild(title);

          if (schema.description) {
            const desc = document.createElement("div");
            desc.className = "bf-plugin-settings-desc";
            desc.textContent = String(schema.description);
            card.appendChild(desc);
          }

          for (const control of schema.controls) {
            if (!control || !control.key) continue;
            const field = document.createElement("div");
            field.className = "bf-field";
            const label = document.createElement("label");
            label.textContent = String(control.label || control.key);
            field.appendChild(label);

            if (control.type === "range") {
              const valueNode = document.createElement("div");
              valueNode.className = "bf-meta";
              const input = document.createElement("input");
              input.className = "bf-input";
              input.type = "range";
              input.min = String(Number.isFinite(Number(control.min)) ? Number(control.min) : 0);
              input.max = String(Number.isFinite(Number(control.max)) ? Number(control.max) : 100);
              input.step = String(Number.isFinite(Number(control.step)) ? Number(control.step) : 1);
              input.value = String(control.value != null ? control.value : input.min);
              const formatValue = () => {
                const suffix = control.suffix != null ? String(control.suffix) : "";
                const n = Number.parseFloat(String(input.value || "0"));
                valueNode.textContent = Number.isFinite(n) ? n.toFixed(2) + suffix : String(input.value || "");
              };
              formatValue();
              input.oninput = () => {
                formatValue();
                applyPluginSetting(plugin.id, String(control.key), Number.parseFloat(String(input.value || "0")));
              };
              field.appendChild(input);
              field.appendChild(valueNode);
            } else if (control.type === "boolean") {
              const wrap = document.createElement("label");
              wrap.className = "bf-toggle";
              const input = document.createElement("input");
              input.type = "checkbox";
              input.checked = Boolean(control.value);
              const text = document.createElement("span");
              text.textContent = String(control.toggleLabel || "Enabled");
              input.onchange = () => {
                applyPluginSetting(plugin.id, String(control.key), Boolean(input.checked));
              };
              wrap.appendChild(input);
              wrap.appendChild(text);
              field.appendChild(wrap);
            } else if (control.type === "button") {
              const btn = document.createElement("button");
              btn.type = "button";
              btn.className = "bf-btn";
              btn.textContent = String(control.buttonLabel || control.label || control.key || "Run");
              const resultNode = document.createElement("div");
              resultNode.className = "bf-meta";
              if (control.note) resultNode.textContent = String(control.note);
              btn.onclick = () => {
                btn.disabled = true;
                const maybeResult = applyPluginSetting(
                  plugin.id,
                  String(control.key),
                  control.value === undefined ? true : control.value
                );
                Promise.resolve(maybeResult)
                  .then((result) => {
                    if (result == null || result === "") {
                      if (!control.note) resultNode.textContent = "OK";
                      return;
                    }
                    if (typeof result === "string") {
                      resultNode.textContent = result;
                      return;
                    }
                    try {
                      resultNode.textContent = JSON.stringify(result);
                    } catch (_e) {
                      resultNode.textContent = String(result);
                    }
                  })
                  .catch((err) => {
                    resultNode.textContent = "Error: " + (err && err.message ? err.message : "failed");
                  })
                  .finally(() => {
                    btn.disabled = false;
                  });
              };
              field.appendChild(btn);
              field.appendChild(resultNode);
            } else {
              const input = document.createElement("input");
              input.className = "bf-input";
              input.type = "text";
              input.value = String(control.value == null ? "" : control.value);
              input.onchange = () => {
                applyPluginSetting(plugin.id, String(control.key), String(input.value || ""));
              };
              field.appendChild(input);
            }
            card.appendChild(field);
          }
          pluginSettingsRoot.appendChild(card);
        }
        if (pluginSettingsStatus) {
          pluginSettingsStatus.textContent = renderedAny ? "" : "No plugin settings available.";
        }
      }

      const pluginsCard = runtime.ui.panel.querySelector("[data-bf-card-plugins]");
      const settingsCard = runtime.ui.panel.querySelector("[data-bf-card-settings]");
      const showingPlugins = runtime.ui.activeTab !== "settings";
      pluginsCard.style.display = showingPlugins ? "" : "none";
      settingsCard.style.display = showingPlugins ? "none" : "";

      updateSettingsEntrySelection();
      if (!showBetterFluxerContent() && (runtime.ui.activeTab === "plugins" || runtime.ui.activeTab === "settings")) {
        const sidebar = findSettingsSidebarNode();
        if (sidebar && sidebar.parentElement) {
          let fallbackHost = sidebar.parentElement.querySelector("[data-bf-settings-host='1']");
          if (!fallbackHost) {
            fallbackHost = document.createElement("div");
            fallbackHost.setAttribute("data-bf-settings-host", "1");
            fallbackHost.style.flex = "1 1 auto";
            fallbackHost.style.minWidth = "0";
            fallbackHost.style.height = "100%";
            sidebar.insertAdjacentElement("afterend", fallbackHost);
          }
          fallbackHost.replaceChildren(runtime.ui.panel);
          fallbackHost.style.display = "block";
        } else if (primeNativeSettingsContext()) {
          requestAnimationFrame(() => requestAnimationFrame(() => renderPanel(runtime.ui.activeTab)));
        }
      }
    }

    function closePanel() {
      hideBetterFluxerContent();
      const fallbackHost = document.querySelector("[data-bf-settings-host='1']");
      if (fallbackHost && fallbackHost.parentNode) {
        fallbackHost.parentNode.removeChild(fallbackHost);
      }
    }

    function removeInjectedEntries() {
      const existing = document.querySelectorAll("[data-betterfluxer-settings-entry]");
      for (const node of existing) node.remove();
      runtime.ui.settingsNodes = { category: null, plugins: null, settings: null };
    }

    function findApplicationAnchor() {
      const byId = [
        "button#settings-tab-advanced",
        "button#settings-tab-language",
        "button#settings-tab-notifications",
        "button#settings-tab-keybinds"
      ];
      for (const selector of byId) {
        const node = document.querySelector(selector);
        if (node) return node;
      }
      return null;
    }

    function stripStatefulClasses(node) {
      node.removeAttribute("aria-selected");
      node.removeAttribute("aria-current");
      node.removeAttribute("data-state");
      node.removeAttribute("data-selected");

      const lowered = (token) => String(token || "").toLowerCase();
      for (const token of Array.from(node.classList)) {
        const t = lowered(token);
        if (t.includes("selected") || t.includes("active") || t.includes("focus") || t.includes("current")) {
          node.classList.remove(token);
        }
      }

      const descendants = node.querySelectorAll("*");
      for (const child of descendants) {
        child.removeAttribute("aria-selected");
        child.removeAttribute("aria-current");
        child.removeAttribute("data-state");
        child.removeAttribute("data-selected");
        for (const token of Array.from(child.classList)) {
          const t = lowered(token);
          if (t.includes("selected") || t.includes("active") || t.includes("focus") || t.includes("current")) {
            child.classList.remove(token);
          }
        }
      }
    }

    function rewriteCloneLabel(clone) {
      const textTargets = clone.querySelectorAll("span, div, p");
      let updated = false;
      for (const node of textTargets) {
        const txt = (node.textContent || "").trim();
        if (!txt) continue;
        if (txt.length > 40) continue;
        node.textContent = "BetterFluxer";
        updated = true;
        break;
      }
      if (!updated) {
        clone.textContent = "BetterFluxer";
      }
    }

    function normalizeText(value) {
      return String(value || "").toLowerCase().replace(/\\s+/g, " ").trim();
    }

    function cssPath(el) {
      if (!el || !el.tagName) return "";
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && cur.nodeType === 1 && depth < 6) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) {
          part += "#" + cur.id;
          parts.unshift(part);
          break;
        }
        const classes = Array.from(cur.classList || []).slice(0, 2);
        if (classes.length) {
          part += "." + classes.join(".");
        }
        parts.unshift(part);
        cur = cur.parentElement;
        depth += 1;
      }
      return parts.join(" > ");
    }

    function probeSettingsDom() {
      const roots = Array.from(document.querySelectorAll("nav, [role=tablist], [class*=sidebar]"));
      const report = roots.map((root, i) => {
        const rows = Array.from(root.querySelectorAll("button, a, [role=tab], [class*=item], [class*=row]"));
        const labels = rows
          .map((r) => (r.textContent || "").trim())
          .filter(Boolean)
          .slice(0, 40);
        const hasApplication = labels.some((l) => /application/i.test(l));
        const hasAdvanced = labels.some((l) => /^advanced$/i.test(l));
        const hasLookAndFeel = labels.some((l) => /look\\s*&\\s*feel/i.test(l));
        const score = (hasApplication ? 30 : 0) + (hasAdvanced ? 20 : 0) + (hasLookAndFeel ? 20 : 0) + Math.min(rows.length, 20);
        return {
          index: i,
          score,
          path: cssPath(root),
          rowCount: rows.length,
          hasApplication,
          hasAdvanced,
          hasLookAndFeel,
          labels
        };
      });
      report.sort((a, b) => b.score - a.score);
      const best = report[0] || null;
      const payload = { timestamp: new Date().toISOString(), best, roots: report };
      try {
        console.group("[BetterFluxer] Settings DOM probe");
        console.table(report.map((r) => ({
          index: r.index,
          score: r.score,
          rowCount: r.rowCount,
          hasApplication: r.hasApplication,
          hasAdvanced: r.hasAdvanced,
          hasLookAndFeel: r.hasLookAndFeel,
          path: r.path
        })));
        if (best) {
          console.log("[BetterFluxer] Best root labels:", best.labels);
        }
        console.log("[BetterFluxer] Full probe JSON:", payload);
        console.groupEnd();
      } catch (_e) {}
      return payload;
    }

    function updateSettingsEntrySelection() {
      const nodes = runtime.ui.settingsNodes;
      if (!nodes) return;
      for (const entry of [nodes.plugins, nodes.settings]) {
        if (!entry) continue;
        entry.classList.remove("bf-settings-active");
      }
      if (runtime.ui.activeTab === "settings" && nodes.settings) {
        nodes.settings.classList.add("bf-settings-active");
      } else if (runtime.ui.activeTab === "plugins" && nodes.plugins) {
        nodes.plugins.classList.add("bf-settings-active");
      }
    }

    function findApplicationInsertionPoint(items) {
      const appLabels = new Set([
        "look & feel",
        "accessibility",
        "messages & media",
        "audio & video",
        "keybinds",
        "sounds & alerts",
        "language & time",
        "advanced"
      ]);

      let lastAppItem = null;
      for (const item of items) {
        const label = normalizeText(item.textContent);
        if (appLabels.has(label)) {
          lastAppItem = item;
        }
      }
      return lastAppItem;
    }

    function makeEntryInteractive(node, onActivate) {
      node.style.pointerEvents = "auto";
      node.removeAttribute("disabled");
      node.removeAttribute("aria-disabled");
      if (node.tagName !== "BUTTON" && node.tagName !== "A") {
        node.setAttribute("role", "button");
        node.setAttribute("tabindex", "0");
      }
      if (node.tagName === "A") {
        node.setAttribute("href", "#");
      }
      node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      });
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onActivate();
        }
      });
      node.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      };
    }

    function createCategoryHeader(template, text) {
      const header =
        (template && template.cloneNode ? template.cloneNode(true) : document.createElement("h2"));
      header.setAttribute("data-betterfluxer-settings-entry", "1");
      header.setAttribute("data-bf-category", "1");
      header.textContent = text;
      return header;
    }

    function createSidebarEntry(template, label, tabName, isSub, onActivateOverride) {
      const node = document.createElement("button");
      node.type = "button";
      node.className = template.className || "";
      node.setAttribute("data-betterfluxer-settings-entry", "1");
      node.setAttribute("data-bf-action", "open:" + tabName);
      node.style.position = "relative";
      node.style.zIndex = "5";
      node.style.pointerEvents = "auto";
      node.setAttribute(
        "onclick",
        "try{window.betterFluxerDebug&&window.betterFluxerDebug.openSettings('" + tabName + "');}catch(_e){} return false;"
      );
      stripStatefulClasses(node);

      const iconTemplate = template.querySelector("svg");
      if (iconTemplate) {
        const icon = iconTemplate.cloneNode(true);
        icon.setAttribute(
          "onclick",
          "try{window.betterFluxerDebug&&window.betterFluxerDebug.openSettings('" + tabName + "');}catch(_e){} return false;"
        );
        icon.style.pointerEvents = "auto";
        node.appendChild(icon);
      }

      const labelTemplate = template.querySelector("span");
      const labelNode = document.createElement("span");
      labelNode.className = labelTemplate ? labelTemplate.className : "";
      labelNode.textContent = label;
      labelNode.setAttribute(
        "onclick",
        "try{window.betterFluxerDebug&&window.betterFluxerDebug.openSettings('" + tabName + "');}catch(_e){} return false;"
      );
      labelNode.style.pointerEvents = "auto";
      node.appendChild(labelNode);

      if (isSub) {
        node.classList.add("bf-settings-sub");
      }
      const activate = typeof onActivateOverride === "function" ? onActivateOverride : () => renderPanel(tabName);
      makeEntryInteractive(node, activate);
      return node;
    }

    function injectSettingsCategory() {
      if (!runtime.settings.autoInjectCategory) {
        removeInjectedEntries();
        return;
      }

      const existingPlugins = document.querySelector('[data-bf-action="open:plugins"]');
      const existingSettings = document.querySelector('[data-bf-action="open:settings"]');
      if (existingPlugins && existingSettings) {
        runtime.ui.settingsNodes.plugins = existingPlugins;
        runtime.ui.settingsNodes.settings = existingSettings;
        runtime.ui.settingsNodes.category =
          document.querySelector("[data-bf-category]") || runtime.ui.settingsNodes.category;
        updateSettingsEntrySelection();
        return;
      }

      removeInjectedEntries();

      const anchor = findApplicationAnchor();
      if (!anchor || !anchor.parentNode) return;
      const parent = anchor.parentNode;
      const template = anchor;
      const categoryTemplate = parent.querySelector("h2, [class*=sidebarCategory], [class*=category]");

      const pluginsEntry = createSidebarEntry(template, "Plugins", "plugins", true);
      const settingsEntry = createSidebarEntry(template, "Settings", "settings", true);
      const categoryHeader = createCategoryHeader(categoryTemplate, "BETTER FLUXER");
      categoryHeader.style.marginTop = "10px";

      parent.insertBefore(categoryHeader, anchor.nextSibling);
      parent.insertBefore(pluginsEntry, categoryHeader.nextSibling);
      parent.insertBefore(settingsEntry, pluginsEntry.nextSibling);

      let cursor = settingsEntry;
      for (const customCategory of runtime.ui.customCategories) {
        const customHeader = createCategoryHeader(categoryTemplate, String(customCategory.label || "CUSTOM"));
        customHeader.setAttribute("data-bf-custom-category", customCategory.id);
        parent.insertBefore(customHeader, cursor.nextSibling);
        cursor = customHeader;

        for (const item of customCategory.items) {
          const activate = () => {
            if (typeof item.onClick === "function") {
              item.onClick({
                openSettings: (tabName) => renderPanel(tabName || "plugins"),
                runtime
              });
              return;
            }
            if (item.tab === "settings" || item.tab === "plugins") {
              renderPanel(item.tab);
              return;
            }
            renderPanel("plugins");
          };
          const customItem = createSidebarEntry(template, item.label, item.tab || "plugins", true, activate);
          customItem.setAttribute("data-bf-custom-item", customCategory.id + ":" + item.id);
          parent.insertBefore(customItem, cursor.nextSibling);
          cursor = customItem;
        }
      }

      runtime.ui.settingsNodes = {
        category: categoryHeader,
        plugins: pluginsEntry,
        settings: settingsEntry
      };
      updateSettingsEntrySelection();
    }

    function mountObservers() {
      if (runtime.ui.observer) return;
      let pending = false;
      const schedule = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          injectSettingsCategory();
          if (runtime.ui.activeTab === "plugins" || runtime.ui.activeTab === "settings") {
            // Keep panel attached/visible without force-rerendering on every app DOM mutation.
            updateSettingsEntrySelection();
            showBetterFluxerContent();
          }
          applyCustomSplashIcon(document);
          injectClientInfoVersionLine(document);
        });
      };
      runtime.ui.observer = new MutationObserver(() => schedule());
      runtime.ui.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: false });
      injectSettingsCategory();
      applyCustomSplashIcon(document);
      injectClientInfoVersionLine(document);

      document.addEventListener(
        "click",
        (event) => {
          const target = event.target && event.target.closest ? event.target.closest("[data-bf-action]") : null;
          if (!target) return;
          const action = target.getAttribute("data-bf-action") || "";
          if (!action.startsWith("open:")) return;
          const tab = action.slice("open:".length) || "plugins";
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
          renderPanel(tab);
        },
        true
      );

      document.addEventListener(
        "click",
        (event) => {
          const tabButton = event.target && event.target.closest ? event.target.closest("button[id^='settings-tab-']") : null;
          if (!tabButton) return;
          if (tabButton.getAttribute("data-betterfluxer-settings-entry") === "1") return;
          if (runtime.ui.activeTab !== "plugins" && runtime.ui.activeTab !== "settings") return;
          runtime.ui.activeTab = null;
          requestAnimationFrame(() => {
            closePanel();
            updateSettingsEntrySelection();
          });
        },
        false
      );
    }

    window.addEventListener("DOMContentLoaded", () => {
      for (const def of defs) {
        const enabled = getPluginEnabled(def.id, true);
        if (!enabled) {
          runtime.plugins.push({ id: def.id, instance: null, patcher: createPatcher(), enabled: false });
          continue;
        }
        const started = startPlugin(def);
        if (started) {
          runtime.plugins.push(started);
        } else {
          runtime.plugins.push({ id: def.id, instance: null, patcher: createPatcher(), enabled: false });
        }
      }
      mountObservers();
      applyCustomSplashIcon(document);
      injectClientInfoVersionLine(document);
      const callPluginMethod = (pluginId, methodName, ...args) => {
        const id = String(pluginId || "");
        const method = String(methodName || "");
        if (!id || !method) return null;
        const plugin = runtime.plugins.find((p) => p && p.id === id);
        if (!plugin || !plugin.instance) return null;
        const fn = plugin.instance[method];
        if (typeof fn !== "function") return null;
        try {
          return fn.apply(plugin.instance, args);
        } catch (_e) {
          return null;
        }
      };
      window.BetterFluxer = {
        listPlugins: () =>
          runtime.plugins.map((p) => ({
            id: p.id,
            enabled: Boolean(p.enabled)
          })),
        ui: runtime.uiClasses,
        classes: runtime.classTypes,
        openSettings: (tabName) => renderPanel(tabName || "plugins"),
        loadStoreIndex: () => loadStoreIndex(),
        installStorePlugin: (item) => installStorePlugin(item),
        removePlugin: (pluginId) => removePlugin(pluginId),
        getStoreItems: () => runtime.store.items.slice(),
        getStoreError: () => runtime.store.error,
        getStoreRemoteError: () => runtime.store.remoteError,
        getStoreIndexUrl: () => runtime.store.indexUrl,
        getStoreState: () => ({
          indexUrl: runtime.store.indexUrl,
          loading: Boolean(runtime.store.loading),
          error: runtime.store.error,
          remoteError: runtime.store.remoteError,
          items: runtime.store.items.slice()
        }),
        registerSettingsCategory: (categoryDef) => registerSettingsCategory(categoryDef),
        unregisterSettingsCategory: (categoryId) => unregisterSettingsCategory(categoryId),
        listSettingsCategories: () =>
          runtime.ui.customCategories.map((cat) => ({
            id: cat.id,
            label: cat.label,
            items: cat.items.map((item) => ({ id: item.id, label: item.label, tab: item.tab }))
          })),
        createCategorySkeleton: (id) => ({
          id: id || "my-category",
          label: "MY CATEGORY",
          items: [
            { id: "menu-plugins", label: "Plugins", tab: "plugins" },
            { id: "menu-settings", label: "Settings", tab: "settings" }
          ]
        }),
        debugSettingsDOM: () => probeSettingsDom(),
        callPluginMethod: (pluginId, methodName, ...args) => callPluginMethod(pluginId, methodName, ...args),
        reloadPlugin: (pluginId) => {
          const def = defs.find((d) => d.id === pluginId);
          if (!def) return false;
          return window.BetterFluxer.setPluginEnabled(pluginId, true, true);
        },
        setPluginEnabled: (pluginId, enabled, forceRestart) => {
          const idx = runtime.plugins.findIndex((p) => p.id === pluginId);
          const def = defs.find((d) => d.id === pluginId);
          if (idx === -1 || !def) return false;
          const existing = runtime.plugins[idx];
          const targetEnabled = Boolean(enabled);
          setPluginEnabled(pluginId, targetEnabled);

          if (existing.enabled) {
            stopPlugin(existing);
          }

          if (!targetEnabled) {
            runtime.plugins[idx] = { id: pluginId, instance: null, patcher: createPatcher(), enabled: false };
            showToast("Plugin disabled: " + String(pluginId), "info");
            return true;
          }

          const started = startPlugin(def);
          if (!started) {
            runtime.plugins[idx] = { id: pluginId, instance: null, patcher: createPatcher(), enabled: false };
            setPluginEnabled(pluginId, false);
            showToast("Plugin failed to enable: " + String(pluginId), "error");
            return false;
          }
          runtime.plugins[idx] = started;
          showToast("Plugin enabled: " + String(pluginId), "success");
          if (forceRestart) {
            return true;
          }
          return true;
        }
      };
      try {
        if (
          typeof import_electron !== "undefined" &&
          import_electron.contextBridge &&
          typeof import_electron.contextBridge.exposeInMainWorld === "function"
        ) {
          const debugBridgeApi = {
            debugSettingsDOM: () => probeSettingsDom(),
            callPluginMethod: (pluginId, methodName, ...args) => callPluginMethod(pluginId, methodName, ...args),
            openSettings: (tabName) => renderPanel(tabName || "plugins"),
            loadStoreIndex: () => loadStoreIndex(),
            installStorePlugin: (item) => installStorePlugin(item),
            removePlugin: (pluginId) => removePlugin(pluginId),
            getStoreItems: () => runtime.store.items.slice(),
            getStoreError: () => runtime.store.error,
            getStoreRemoteError: () => runtime.store.remoteError,
            getStoreIndexUrl: () => runtime.store.indexUrl,
            getStoreState: () => ({
              indexUrl: runtime.store.indexUrl,
              loading: Boolean(runtime.store.loading),
              error: runtime.store.error,
              remoteError: runtime.store.remoteError,
              items: runtime.store.items.slice()
            }),
            userProfile: {
              getCurrentUser: () => runtime.uiClasses.userProfile.getCurrentUser(),
              getCurrentUserData: () => runtime.uiClasses.userProfile.getCurrentUserData(),
              captureCurrentUser: () => runtime.uiClasses.userProfile.captureCurrentUser(),
              fromDebugJson: (jsonOrObject) => runtime.uiClasses.userProfile.fromDebugJson(jsonOrObject),
              openProfileSettings: () => runtime.uiClasses.userProfile.openProfileSettings()
            },
            messages: {
              getVisibleMessages: () => runtime.uiClasses.messages.getVisibleMessages(),
              sendMessage: (text) => runtime.uiClasses.messages.sendMessage(text)
            },
            guildList: {
              getGuildItems: () => runtime.uiClasses.guildList.getGuildItems(),
              clickGuildByName: (name) => runtime.uiClasses.guildList.clickGuildByName(name)
            },
            channels: {
              getChannelItems: () => runtime.uiClasses.channels.getChannelItems(),
              clickChannelByName: (name) => runtime.uiClasses.channels.clickChannelByName(name)
            },
            members: {
              getMemberItems: () => runtime.uiClasses.members.getMemberItems(),
              getVisibleMemberIds: () => runtime.uiClasses.members.getVisibleMemberIds(),
              getMemberById: (userId) => runtime.uiClasses.members.getMemberById(userId),
              clickMemberById: (userId) => runtime.uiClasses.members.clickMemberById(userId),
              clickMemberByName: (name) => runtime.uiClasses.members.clickMemberByName(name)
            },
            settingsSidebar: {
              getItems: () => runtime.uiClasses.settingsSidebar.getItems(),
              clickById: (tabId) => runtime.uiClasses.settingsSidebar.clickById(tabId)
            },
            registerSettingsCategory: (categoryDef) => registerSettingsCategory(categoryDef),
            unregisterSettingsCategory: (categoryId) => unregisterSettingsCategory(categoryId),
            listSettingsCategories: () =>
              runtime.ui.customCategories.map((cat) => ({
                id: cat.id,
                label: cat.label,
                items: cat.items.map((item) => ({ id: item.id, label: item.label, tab: item.tab }))
              })),
            createCategorySkeleton: (id) => ({
              id: id || "my-category",
              label: "MY CATEGORY",
              items: [
                { id: "menu-plugins", label: "Plugins", tab: "plugins" },
                { id: "menu-settings", label: "Settings", tab: "settings" }
              ]
            }),
            listPlugins: () =>
              runtime.plugins.map((p) => ({
                id: p.id,
                enabled: Boolean(p.enabled)
              }))
          };

          const safeExpose = (name, value) => {
            try {
              import_electron.contextBridge.exposeInMainWorld(name, value);
              return true;
            } catch (_exposeError) {
              return false;
            }
          };

          safeExpose("betterFluxerDebug", debugBridgeApi);
          safeExpose("bfDebug", debugBridgeApi);
          safeExpose("BetterFluxer", window.BetterFluxer);
        }
      } catch (_e) {}
      window.__betterFluxerRuntime = runtime;
      showToast("BetterFluxer injected", "success");
    });

    window.addEventListener("beforeunload", () => {
      closePanel();
      if (runtime.ui.observer) {
        runtime.ui.observer.disconnect();
      }
      if (runtime.ui.toastHost && runtime.ui.toastHost.parentNode) {
        runtime.ui.toastHost.parentNode.removeChild(runtime.ui.toastHost);
      }
      for (const plugin of runtime.plugins) {
        stopPlugin(plugin);
      }
      runtime.plugins.length = 0;
    });
  })();
} catch (error) {
  console.error("[BetterFluxer] Failed to load injector:", error);
}
${INJECTION_END}
`;
}

function buildMainIpcSnippet() {
  return `${MAIN_IPC_INJECTION_START}
try {
  if (
    typeof ipcMain !== "undefined" &&
    ipcMain &&
    typeof ipcMain.handle === "function" &&
    !ipcMain.__betterFluxerFetchUrlRegistered
  ) {
    ipcMain.__betterFluxerFetchUrlRegistered = true;
    ipcMain.handle("betterfluxer:fetch-url", async (_event, payload) => {
      const requestUrl = String((payload && payload.url) || "");
      const responseType = String((payload && payload.responseType) || "json").toLowerCase() === "text" ? "text" : "json";
      const timeoutMs = Math.max(1000, Math.min(30000, Number((payload && payload.timeoutMs) || 15000)));
      if (!requestUrl) {
        return { ok: false, error: "Missing url" };
      }

      let parsed;
      try {
        parsed = new URL(requestUrl);
      } catch (_err) {
        return { ok: false, error: "Invalid URL" };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: "Unsupported protocol" };
      }

      const makeRequest = (targetUrl, redirectsLeft) =>
        new Promise((resolve) => {
          let targetParsed;
          try {
            targetParsed = new URL(targetUrl);
          } catch (_err) {
            resolve({ ok: false, error: "Invalid redirect URL" });
            return;
          }

          const client = targetParsed.protocol === "https:" ? https : http;
          const req = client.request(
            {
              protocol: targetParsed.protocol,
              hostname: targetParsed.hostname,
              port: targetParsed.port || (targetParsed.protocol === "https:" ? 443 : 80),
              method: "GET",
              path: targetParsed.pathname + targetParsed.search,
              headers: {
                "User-Agent": "BetterFluxer/1.0"
              }
            },
            (res) => {
              const status = Number(res.statusCode || 0);
              if (status >= 300 && status < 400 && res.headers && res.headers.location) {
                if (redirectsLeft <= 0) {
                  resolve({ ok: false, error: "Redirect limit exceeded" });
                  return;
                }
                const redirectUrl = new URL(String(res.headers.location), targetParsed).toString();
                makeRequest(redirectUrl, redirectsLeft - 1).then(resolve);
                return;
              }

              const chunks = [];
              res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              res.on("error", (error) => resolve({ ok: false, error: "Response failed: " + String(error && error.message ? error.message : error) }));
              res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                if (status < 200 || status >= 300) {
                  resolve({ ok: false, error: "HTTP " + status, status, text });
                  return;
                }
                if (responseType === "text") {
                  resolve({ ok: true, status, text });
                  return;
                }
                try {
                  resolve({ ok: true, status, text, json: JSON.parse(text) });
                } catch (error) {
                  resolve({ ok: false, error: "JSON parse failed: " + String(error && error.message ? error.message : error), status, text });
                }
              });
            }
          );

          req.on("error", (error) => resolve({ ok: false, error: "Request failed: " + String(error && error.message ? error.message : error) }));
          req.setTimeout(timeoutMs, () => {
            try {
              req.destroy(new Error("timeout"));
            } catch (_err) {}
            resolve({ ok: false, error: "Request timeout" });
          });
          req.end();
        });

      return makeRequest(parsed.toString(), 5);
    });
  }
} catch (error) {
  try {
    console.error("[BetterFluxer] Failed to register main IPC bridge:", error);
  } catch (_err) {}
}
${MAIN_IPC_INJECTION_END}
`;
}

function patchPreloadDisplaySourceSelection(sourceText) {
  const source = String(sourceText || "");
  const legacyPattern = /selectDisplayMediaSource:\s*\(requestId,\s*sourceId,\s*withAudio\)\s*=>\s*\{\s*import_electron\.ipcRenderer\.send\("select-display-media-source",\s*requestId,\s*sourceId,\s*withAudio\);\s*\},/m;
  const broadPattern = /selectDisplayMediaSource:\s*(?:async\s*)?\(requestId,\s*sourceId,\s*withAudio\)\s*=>\s*\{[\s\S]*?\n\s*\},/m;
  const pattern = legacyPattern.test(source) ? legacyPattern : broadPattern;
  if (!pattern.test(source)) {
    return source;
  }
  return source.replace(
    pattern,
    [
      'selectDisplayMediaSource: (requestId, sourceId, withAudio) => {',
      '    console.info("[BetterFluxer] selectDisplayMediaSource patch active.", { requestId, sourceId, withAudio: Boolean(withAudio) });',
      '    import_electron.ipcRenderer.send("select-display-media-source", requestId, String(sourceId || ""), withAudio);',
      "  },"
    ].join("\n")
  );
}

function patchPreload(preloadPath, backupPreloadPath, inlinePlugins, options = {}) {
  const rawSource = fs.readFileSync(preloadPath, "utf8");
  const source = patchPreloadDisplaySourceSelection(rawSource);
  if (!fs.existsSync(backupPreloadPath)) {
    fs.writeFileSync(backupPreloadPath, rawSource, "utf8");
  }

  const snippet = buildRequireSnippet(inlinePlugins, options);
  const blockPattern = new RegExp(
    `${escapeRegex(INJECTION_START)}[\\s\\S]*?${escapeRegex(INJECTION_END)}\\s*`,
    "m"
  );

  let patched;
  if (blockPattern.test(source)) {
    patched = source.replace(blockPattern, `${snippet}\n`);
  } else {
    patched = `${source.trimEnd()}\n\n${snippet}`;
  }

  fs.writeFileSync(preloadPath, patched, "utf8");
  return { changed: true, replacedExisting: blockPattern.test(source) };
}

function patchMainIpcHandlers(mainIpcHandlersPath, backupMainIpcHandlersPath) {
  if (!mainIpcHandlersPath || !fs.existsSync(mainIpcHandlersPath)) {
    return { changed: false, skipped: true, reason: "main-ipc-handlers-missing" };
  }

  const source = fs.readFileSync(mainIpcHandlersPath, "utf8");
  if (!fs.existsSync(backupMainIpcHandlersPath)) {
    fs.writeFileSync(backupMainIpcHandlersPath, source, "utf8");
  }

  const snippet = buildMainIpcSnippet();
  const blockPattern = new RegExp(
    `${escapeRegex(MAIN_IPC_INJECTION_START)}[\\s\\S]*?${escapeRegex(MAIN_IPC_INJECTION_END)}\\s*`,
    "m"
  );

  let patched;
  if (blockPattern.test(source)) {
    patched = source.replace(blockPattern, `${snippet}\n`);
  } else {
    patched = `${source.trimEnd()}\n\n${snippet}`;
  }

  fs.writeFileSync(mainIpcHandlersPath, patched, "utf8");
  return { changed: true, replacedExisting: blockPattern.test(source), skipped: false };
}

function unpatchPreload(preloadPath, backupPreloadPath) {
  if (fs.existsSync(backupPreloadPath)) {
    fs.copyFileSync(backupPreloadPath, preloadPath);
    return { restoredFromBackup: true };
  }

  if (!fs.existsSync(preloadPath)) {
    return { restoredFromBackup: false, removedSnippet: false };
  }

  const source = fs.readFileSync(preloadPath, "utf8");
  const pattern = new RegExp(
    `${escapeRegex(INJECTION_START)}[\\s\\S]*?${escapeRegex(INJECTION_END)}\\s*`,
    "m"
  );
  if (!pattern.test(source)) {
    return { restoredFromBackup: false, removedSnippet: false };
  }
  const cleaned = source.replace(pattern, "").trimEnd();
  fs.writeFileSync(preloadPath, `${cleaned}\n`, "utf8");
  return { restoredFromBackup: false, removedSnippet: true };
}

function unpatchMainIpcHandlers(mainIpcHandlersPath, backupMainIpcHandlersPath) {
  if (!mainIpcHandlersPath || !fs.existsSync(mainIpcHandlersPath)) {
    return { restoredFromBackup: false, removedSnippet: false, skipped: true };
  }

  if (fs.existsSync(backupMainIpcHandlersPath)) {
    fs.copyFileSync(backupMainIpcHandlersPath, mainIpcHandlersPath);
    return { restoredFromBackup: true, removedSnippet: true, skipped: false };
  }

  const source = fs.readFileSync(mainIpcHandlersPath, "utf8");
  const pattern = new RegExp(
    `${escapeRegex(MAIN_IPC_INJECTION_START)}[\\s\\S]*?${escapeRegex(MAIN_IPC_INJECTION_END)}\\s*`,
    "m"
  );
  if (!pattern.test(source)) {
    return { restoredFromBackup: false, removedSnippet: false, skipped: false };
  }
  const cleaned = source.replace(pattern, "").trimEnd();
  fs.writeFileSync(mainIpcHandlersPath, `${cleaned}\n`, "utf8");
  return { restoredFromBackup: false, removedSnippet: true, skipped: false };
}

function getInjectionStatus(appPath) {
  const paths = resolvePaths(appPath);
  const preloadExists = fs.existsSync(paths.preloadPath);
  const backupExists = fs.existsSync(paths.backupPreloadPath);
  const runtimeExists = fs.existsSync(paths.injectedRoot);
  const mainIpcExists = fs.existsSync(paths.mainIpcHandlersPath);
  const mainIpcBackupExists = fs.existsSync(paths.backupMainIpcHandlersPath);
  let hasInjectionSnippet = false;
  let hasMainIpcSnippet = false;

  if (preloadExists) {
    const source = fs.readFileSync(paths.preloadPath, "utf8");
    hasInjectionSnippet = source.includes(INJECTION_START) && source.includes(INJECTION_END);
  }
  if (mainIpcExists) {
    const source = fs.readFileSync(paths.mainIpcHandlersPath, "utf8");
    hasMainIpcSnippet = source.includes(MAIN_IPC_INJECTION_START) && source.includes(MAIN_IPC_INJECTION_END);
  }

  return {
    appPath,
    preloadExists,
    backupExists,
    mainIpcExists,
    mainIpcBackupExists,
    runtimeExists,
    injected: hasInjectionSnippet && runtimeExists,
    mainIpcInjected: hasMainIpcSnippet
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  DEFAULT_INSTALL_ROOTS,
  DEFAULT_INSTALL_ROOT,
  DEFAULT_SPLASH_PULSE_COLOR,
  getDefaultInstallRoots,
  getDefaultSplashIconDataUrl,
  resolveInstallRoot,
  parseArgs,
  getInstalledVersions,
  getFluxerAppPath,
  getInjectionStatus,
  resolvePaths,
  ensureFileExists,
  copyRuntime,
  ensureLinuxSafeLauncher,
  writeBootstrap,
  collectInlinePlugins,
  resolveSourceDesktopMainBundle,
  buildStoreIndexSnapshot,
  patchPreload,
  patchPackagedMainBundle,
  unpatchPreload,
  patchMainIpcHandlers,
  unpatchMainIpcHandlers
};
