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

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function copyRuntime(sourceRoot, injectedRoot) {
  fs.mkdirSync(injectedRoot, { recursive: true });
  const pluginsSource = path.join(sourceRoot, "plugins");
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

function writeBootstrap() {
  // legacy no-op; runtime is now injected inline into preload for sandbox compatibility
}

function collectInlinePlugins(sourceRoot) {
  const pluginsRoot = path.join(sourceRoot, "plugins");
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
  return `${INJECTION_START}
try {
  (function initBetterFluxerInline() {
    if (window.__betterFluxerRuntime) return;
    const ENABLE_BETTERFLUXER_IPC_BRIDGE = ${enableIpcBridge ? "true" : "false"};
    const STORE_INDEX_URL = "https://raw.githubusercontent.com/RoxyBoxxy/BetterFluxer/refs/heads/main/plugins.json";
    const STORE_INDEX_SNAPSHOT = ${storeIndexSnapshot};
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
        activeTab: "plugins",
        manualInstallMessage: "",
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

    function createLogger(pluginId) {
      return {
        info: (...args) => console.info("[BetterFluxer:" + pluginId + "]", ...args),
        warn: (...args) => console.warn("[BetterFluxer:" + pluginId + "]", ...args),
        error: (...args) => console.error("[BetterFluxer:" + pluginId + "]", ...args),
        debug: (...args) => console.debug("[BetterFluxer:" + pluginId + "]", ...args)
      };
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
          return applyPluginDefinition(def, true);
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
        return applyPluginDefinition(def, true);
      } catch (error) {
        runtime.store.error = String((error && error.message) || error || "Install failed");
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
        channels: new ChannelsClass()
      };
    }

    runtime.classTypes = {
      BaseDOMClass,
      SettingsSidebarClass,
      UserProfileClass,
      MessagesClass,
      GuildListClass,
      ChannelsClass
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
        ".bf-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483645;display:flex;align-items:center;justify-content:center;}",
        ".bf-panel{width:min(820px,94vw);max-height:86vh;overflow:auto;background:#15181d;color:#f4f6f8;border:1px solid #2b3139;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.45);font-family:Segoe UI,Tahoma,sans-serif;}",
        ".bf-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #2b3139;}",
        ".bf-head h2{margin:0;font-size:18px;}",
        ".bf-body{padding:14px 16px;display:grid;gap:14px;}",
        ".bf-card{background:#1b2027;border:1px solid #2b3139;border-radius:10px;padding:12px;}",
        ".bf-card h3{margin:0 0 10px 0;font-size:14px;color:#d7dee7;}",
        ".bf-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #2b3139;}",
        ".bf-row:first-child{border-top:0;padding-top:0;}",
        ".bf-meta{font-size:12px;color:#9cacbe;}",
        ".bf-btn{border:1px solid #3c4754;background:#26313d;color:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;}",
        ".bf-btn[disabled]{opacity:.6;cursor:not-allowed;}",
        ".bf-toggle{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:#d7dee7;}",
        ".bf-toolbar{display:flex;gap:8px;margin-bottom:8px;}",
        ".bf-manual{margin-top:12px;border-top:1px solid #2b3139;padding-top:12px;display:grid;gap:8px;}",
        ".bf-manual h4{margin:0;font-size:13px;color:#d7dee7;}",
        ".bf-section{margin-top:12px;border-top:1px solid #2b3139;padding-top:12px;display:grid;gap:8px;}",
        ".bf-section h4{margin:0;font-size:13px;color:#d7dee7;}",
        ".bf-field{display:grid;gap:4px;}",
        ".bf-field label{font-size:12px;color:#9cacbe;}",
        ".bf-input,.bf-textarea{width:100%;box-sizing:border-box;background:#11151b;color:#e9eef5;border:1px solid #313b47;border-radius:8px;padding:8px 10px;font:12px/1.4 ui-monospace,monospace;}",
        ".bf-input{font-family:Segoe UI,Tahoma,sans-serif;}",
        ".bf-textarea{min-height:120px;resize:vertical;}",
        ".bf-error{color:#ff9fa9;font-size:12px;}",
        ".bf-menu-item{margin-top:6px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:#d3dbe4;}",
        ".bf-menu-item:hover{background:rgba(255,255,255,.08);}",
        ".bf-settings-sub{margin-left:16px;border-left:1px solid rgba(120,145,180,.45);padding-left:10px;}",
        ".bf-settings-active{box-shadow:inset 2px 0 0 #6f8bff;}",
        "[data-betterfluxer-settings-entry]{pointer-events:auto !important;}",
        "[data-betterfluxer-settings-entry]{position:relative;z-index:5;}",
        "[data-betterfluxer-settings-entry] *{pointer-events:auto !important;}",
        "[data-bf-category]{font-size:12px;letter-spacing:.04em;opacity:.9;}"
      ].join("");
      document.head.appendChild(style);
    }

    function renderPanel(tabName) {
      if (tabName === "plugins" || tabName === "settings") {
        runtime.ui.activeTab = tabName;
      }
      ensureStyles();
      if (!runtime.ui.panel) {
        const backdrop = document.createElement("div");
        backdrop.className = "bf-modal-backdrop";
        backdrop.innerHTML = [
          "<div class=\\"bf-panel\\">",
          "  <div class=\\"bf-head\\">",
          "    <h2>BetterFluxer</h2>",
          "    <button class=\\"bf-btn\\" data-bf-close>Close</button>",
          "  </div>",
          "  <div class=\\"bf-body\\">",
          "    <div class=\\"bf-card\\" data-bf-card-plugins>",
          "      <h3>Plugins</h3>",
          "      <div data-bf-plugins></div>",
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
          "        <h4>DiscordRPCEmu Bridge</h4>",
          "        <label class=\\"bf-toggle\\">",
          "          <input type=\\"checkbox\\" data-bf-bridge-enabled />",
          "          Enable local bridge source for now-playing",
          "        </label>",
          "        <div class=\\"bf-field\\">",
          "          <label>Bridge Port</label>",
          "          <input class=\\"bf-input\\" type=\\"number\\" min=\\"1\\" step=\\"1\\" data-bf-bridge-port placeholder=\\"21864\\" />",
          "        </div>",
          "        <div class=\\"bf-field\\">",
          "          <label>Bridge Token</label>",
          "          <input class=\\"bf-input\\" type=\\"text\\" data-bf-bridge-token placeholder=\\"Token from data/bridge-token.txt\\" />",
          "        </div>",
          "        <div class=\\"bf-toolbar\\">",
          "          <button class=\\"bf-btn\\" data-bf-bridge-save>Save Bridge</button>",
          "          <button class=\\"bf-btn\\" data-bf-bridge-test>Test Sync Now</button>",
          "        </div>",
          "        <div class=\\"bf-meta\\" data-bf-bridge-status></div>",
          "      </div>",
          "    </div>",
          "  </div>",
          "</div>"
        ].join("");
        backdrop.addEventListener("click", (event) => {
          if (event.target === backdrop) {
            closePanel();
          }
        });
        backdrop.querySelector("[data-bf-close]").addEventListener("click", () => closePanel());
        runtime.ui.panel = backdrop;
      }

      const pluginsRoot = runtime.ui.panel.querySelector("[data-bf-plugins]");
      pluginsRoot.innerHTML = "";
      for (const def of defs) {
        const record = getRecord(def.id);
        const row = document.createElement("div");
        row.className = "bf-row";
        const info = document.createElement("div");
        info.innerHTML = "<div>" + def.id + "</div><div class=\\"bf-meta\\">" + (record?.enabled ? "Enabled" : "Disabled") + "</div>";
        const controls = document.createElement("div");
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = Boolean(record?.enabled);
        toggle.addEventListener("change", () => {
          window.BetterFluxer.setPluginEnabled(def.id, toggle.checked);
          renderPanel();
        });
        controls.appendChild(toggle);
        if (isStoredPlugin(def.id)) {
          const removeBtn = document.createElement("button");
          removeBtn.className = "bf-btn";
          removeBtn.textContent = "Delete";
          removeBtn.addEventListener("click", () => {
            removePlugin(def.id);
            runtime.ui.manualInstallMessage = "Deleted plugin: " + String(def.id);
            renderPanel("plugins");
          });
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

      const bridgeEnabledInput = runtime.ui.panel.querySelector("[data-bf-bridge-enabled]");
      const bridgePortInput = runtime.ui.panel.querySelector("[data-bf-bridge-port]");
      const bridgeTokenInput = runtime.ui.panel.querySelector("[data-bf-bridge-token]");
      const bridgeSaveBtn = runtime.ui.panel.querySelector("[data-bf-bridge-save]");
      const bridgeTestBtn = runtime.ui.panel.querySelector("[data-bf-bridge-test]");
      const bridgeStatus = runtime.ui.panel.querySelector("[data-bf-bridge-status]");
      const callBridge = (methodName, ...args) => {
        if (!window.BetterFluxer || typeof window.BetterFluxer.callPluginMethod !== "function") return null;
        return window.BetterFluxer.callPluginMethod("DiscordRPCEmu", methodName, ...args);
      };
      const applyBridgeStateToInputs = (state) => {
        if (!state || typeof state !== "object") return;
        if (bridgeEnabledInput && Object.prototype.hasOwnProperty.call(state, "localBridgeEnabled")) {
          bridgeEnabledInput.checked = Boolean(state.localBridgeEnabled);
        }
        if (bridgePortInput && Object.prototype.hasOwnProperty.call(state, "localBridgePort")) {
          const p = Number(state.localBridgePort || 21864);
          bridgePortInput.value = Number.isFinite(p) ? String(p) : "21864";
        }
      };
      try {
        const state = callBridge("getStatusSyncState");
        applyBridgeStateToInputs(state);
      } catch (_e) {}

      if (bridgeSaveBtn) {
        bridgeSaveBtn.onclick = () => {
          bridgeSaveBtn.disabled = true;
          const payload = {
            enabled: bridgeEnabledInput ? Boolean(bridgeEnabledInput.checked) : true,
            port: bridgePortInput ? Number.parseInt(String(bridgePortInput.value || "21864"), 10) : 21864
          };
          if (bridgeTokenInput) {
            const tokenText = String(bridgeTokenInput.value || "").trim();
            if (tokenText) payload.token = tokenText;
          }
          try {
            const result = callBridge("configureLocalBridge", payload);
            if (bridgeStatus) {
              bridgeStatus.textContent =
                "Saved. enabled=" +
                String(result && result.enabled) +
                " port=" +
                String((result && result.port) || payload.port) +
                " tokenSet=" +
                String(Boolean(result && result.tokenSet));
            }
          } catch (error) {
            if (bridgeStatus) {
              bridgeStatus.textContent = "Bridge save failed: " + String((error && error.message) || error || "unknown");
            }
          } finally {
            bridgeSaveBtn.disabled = false;
          }
        };
      }

      if (bridgeTestBtn) {
        bridgeTestBtn.onclick = async () => {
          bridgeTestBtn.disabled = true;
          if (bridgeStatus) bridgeStatus.textContent = "Running now-playing sync...";
          try {
            const ok = await Promise.resolve(callBridge("syncNowPlayingNow"));
            const state = callBridge("getStatusSyncState");
            if (bridgeStatus) {
              bridgeStatus.textContent =
                "Sync result: " + String(Boolean(ok)) + (state && state.lastAppliedStatusText ? " | " + state.lastAppliedStatusText : "");
            }
          } catch (error) {
            if (bridgeStatus) {
              bridgeStatus.textContent = "Sync failed: " + String((error && error.message) || error || "unknown");
            }
          } finally {
            bridgeTestBtn.disabled = false;
          }
        };
      }

      const pluginsCard = runtime.ui.panel.querySelector("[data-bf-card-plugins]");
      const settingsCard = runtime.ui.panel.querySelector("[data-bf-card-settings]");
      const showingPlugins = runtime.ui.activeTab !== "settings";
      pluginsCard.style.display = showingPlugins ? "" : "none";
      settingsCard.style.display = showingPlugins ? "none" : "";

      updateSettingsEntrySelection();
      if (!document.body.contains(runtime.ui.panel)) {
        document.body.appendChild(runtime.ui.panel);
      }
    }

    function closePanel() {
      if (runtime.ui.panel && runtime.ui.panel.parentNode) {
        runtime.ui.panel.parentNode.removeChild(runtime.ui.panel);
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
      } else if (nodes.plugins) {
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
      node.addEventListener(
        "pointerdown",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
        },
        true
      );
      node.addEventListener(
        "mousedown",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
        },
        true
      );
      node.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") {
            event.stopImmediatePropagation();
          }
          onActivate();
        },
        true
      );
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      });
      node.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") {
          event.stopImmediatePropagation();
        }
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
        });
      };
      runtime.ui.observer = new MutationObserver(() => schedule());
      runtime.ui.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: false });
      injectSettingsCategory();

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
            return true;
          }

          const started = startPlugin(def);
          if (!started) {
            runtime.plugins[idx] = { id: pluginId, instance: null, patcher: createPatcher(), enabled: false };
            setPluginEnabled(pluginId, false);
            return false;
          }
          runtime.plugins[idx] = started;
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
    });

    window.addEventListener("beforeunload", () => {
      closePanel();
      if (runtime.ui.observer) {
        runtime.ui.observer.disconnect();
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

function patchPreload(preloadPath, backupPreloadPath, inlinePlugins, options = {}) {
  const source = fs.readFileSync(preloadPath, "utf8");
  if (!fs.existsSync(backupPreloadPath)) {
    fs.writeFileSync(backupPreloadPath, source, "utf8");
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
  getDefaultInstallRoots,
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
  buildStoreIndexSnapshot,
  patchPreload,
  unpatchPreload,
  patchMainIpcHandlers,
  unpatchMainIpcHandlers
};
