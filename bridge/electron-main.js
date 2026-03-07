const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require("electron");

let mainWindow = null;
let tray = null;
let bridgeProc = null;
let bridgePort = Number.parseInt(process.env.BF_BRIDGE_PORT || "21864", 10);
const APP_NAME = "BetterFluxer";
const KNOWN_GAME_EXECUTABLES = {
  cs2: "Counter-Strike 2",
  dota2: "Dota 2",
  apex: "Apex Legends",
  r5apex: "Apex Legends",
  valorant: "VALORANT",
  "valorant-win64-shipping": "VALORANT",
  fortniteclientwin64shipping: "Fortnite",
  rocketleague: "Rocket League",
  leagueoflegends: "League of Legends",
  gta5: "Grand Theft Auto V",
  eldenring: "Elden Ring",
  witcher3: "The Witcher 3",
  cyberpunk2077: "Cyberpunk 2077",
  wow: "World of Warcraft",
  overwatch: "Overwatch",
  osclient: "Old School RuneScape",
  runelite: "RuneLite",
  minecraftlauncher: "Minecraft",
  robloxplayerbeta: "Roblox",
  starrail: "Honkai: Star Rail",
  genshinimpact: "Genshin Impact",
  zenlesszonezero: "Zenless Zone Zero"
};

function getAppDataHome() {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function getBridgeBaseDir() {
  const envDir = String(process.env.BF_HOME_DIR || "").trim();
  if (envDir) return envDir;
  return path.join(getAppDataHome(), APP_NAME);
}

function getCustomAppsFile() {
  return path.join(getBridgeBaseDir(), "data", "custom-apps.json");
}

function loadCustomApps() {
  const file = getCustomAppsFile();
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => ({
        name: String((x && x.name) || "").trim(),
        exe: String((x && x.exe) || "").trim().toLowerCase().replace(/\.exe$/i, ""),
        path: String((x && x.path) || "").trim()
      }))
      .filter((x) => x.name && x.exe);
  } catch (_) {
    return [];
  }
}

function saveCustomApps(items) {
  const file = getCustomAppsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(items, null, 2), "utf8");
}

function addCustomApp(input) {
  const name = String((input && input.name) || "").trim();
  const exe = String((input && input.exe) || "").trim().toLowerCase().replace(/\.exe$/i, "");
  const appPath = String((input && input.path) || "").trim();
  if (!name || !exe) throw new Error("Custom app requires name and exe");
  const list = loadCustomApps().filter((x) => x.exe !== exe);
  list.push({ name, exe, path: appPath });
  list.sort((a, b) => a.name.localeCompare(b.name));
  saveCustomApps(list);
  return list;
}

function removeCustomApp(exeValue) {
  const exe = String(exeValue || "").trim().toLowerCase().replace(/\.exe$/i, "");
  const list = loadCustomApps().filter((x) => x.exe !== exe);
  saveCustomApps(list);
  return list;
}

function ensurePort(n) {
  const p = Number.parseInt(String(n || ""), 10);
  if (!Number.isFinite(p) || p <= 0) return 21864;
  return p;
}

function transparentIcon() {
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9p4lCB0AAAAASUVORK5CYII="
  );
}

function isBridgeRunning() {
  return Boolean(bridgeProc && !bridgeProc.killed);
}

function startBridgeService() {
  if (isBridgeRunning()) return true;
  const bridgePath = path.join(__dirname, "index.js");
  const env = { ...process.env, BF_BRIDGE_PORT: String(bridgePort) };
  bridgeProc = spawn(process.execPath, [bridgePath, "--hidden"], {
    cwd: path.resolve(__dirname, ".."),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  bridgeProc.stdout.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (text) console.log(`[Bridge] ${text}`);
  });
  bridgeProc.stderr.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (text) console.error(`[Bridge] ${text}`);
  });
  bridgeProc.on("exit", () => {
    bridgeProc = null;
  });
  return true;
}

function stopBridgeService() {
  if (!bridgeProc) return true;
  try {
    bridgeProc.kill();
  } catch (_) {}
  bridgeProc = null;
  return true;
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function collectFiles(rootDir, opts, out) {
  const maxDepth = Number(opts && opts.maxDepth != null ? opts.maxDepth : 2);
  const includeExts = Array.isArray(opts && opts.includeExts) ? opts.includeExts : [".exe"];
  const maxItems = Number(opts && opts.maxItems != null ? opts.maxItems : 3000);
  const stack = [{ dir: rootDir, depth: 0 }];
  const seen = new Set();
  while (stack.length && out.length < maxItems) {
    const item = stack.pop();
    const entries = safeReadDir(item.dir);
    for (const entry of entries) {
      const full = path.join(item.dir, entry.name);
      if (seen.has(full)) continue;
      seen.add(full);
      if (entry.isDirectory()) {
        if (item.depth < maxDepth) stack.push({ dir: full, depth: item.depth + 1 });
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (includeExts.includes(ext)) out.push(full);
    }
  }
}

function displayNameFromPath(filePath) {
  return path
    .basename(String(filePath || ""), path.extname(String(filePath || "")))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getWindowsDriveRoots() {
  const roots = [];
  for (let i = 67; i <= 90; i += 1) {
    const letter = String.fromCharCode(i);
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) roots.push(root);
    } catch (_) {}
  }
  if (!roots.length) roots.push("C:\\");
  return roots;
}

function searchGames(queryText) {
  const query = String(queryText || "").trim().toLowerCase();
  const results = [];
  const seen = new Set();
  const push = (filePath, source) => {
    if (!filePath || seen.has(filePath)) return;
    seen.add(filePath);
    const name = displayNameFromPath(filePath);
    if (query && !name.toLowerCase().includes(query) && !filePath.toLowerCase().includes(query)) return;
    results.push({ name, path: filePath, source });
  };

  if (process.platform === "win32") {
    const roots = getWindowsDriveRoots();
    const files = [];
    for (const root of roots) collectFiles(root, { maxDepth: 5, includeExts: [".exe", ".lnk"], maxItems: 20000 }, files);
    for (const filePath of files) {
      const source = filePath.toLowerCase().endsWith(".lnk") ? "start-menu" : "install-dir";
      const exeName = path.basename(filePath, path.extname(filePath)).toLowerCase();
      if (source !== "start-menu" && !KNOWN_GAME_EXECUTABLES[exeName]) continue;
      push(filePath, source);
      if (results.length >= 150) break;
    }
  }

  for (const item of loadCustomApps()) {
    const fakePath = item.path || item.exe;
    if (!fakePath) continue;
    if (query) {
      const hay = `${item.name} ${item.exe} ${fakePath}`.toLowerCase();
      if (!hay.includes(query)) continue;
    }
    if (seen.has(fakePath)) continue;
    seen.add(fakePath);
    results.push({ name: item.name, path: fakePath, source: "custom", exe: item.exe });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results.slice(0, 150);
}

async function getBridgeHealth() {
  const url = `http://127.0.0.1:${bridgePort}/health`;
  try {
    const res = await fetch(url);
    if (!res || !res.ok) return { ok: false, error: `HTTP ${res ? res.status : "unknown"}` };
    return await res.json();
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error || "unknown") };
  }
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function hideWindow() {
  if (!mainWindow) return;
  mainWindow.hide();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 700,
    show: false,
    title: "BetterFluxer Bridge",
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      hideWindow();
    }
  });
}

function createTray() {
  tray = new Tray(transparentIcon());
  tray.setToolTip("BetterFluxer Bridge");
  tray.on("double-click", () => showWindow());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Bridge", click: () => showWindow() },
      { type: "separator" },
      {
        label: "Start Bridge Service",
        click: () => startBridgeService()
      },
      {
        label: "Stop Bridge Service",
        click: () => stopBridgeService()
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.isQuiting = true;
          stopBridgeService();
          app.quit();
        }
      }
    ])
  );
}

ipcMain.handle("bridge:status", async () => {
  const health = await getBridgeHealth();
  return {
    running: isBridgeRunning(),
    port: bridgePort,
    health
  };
});

ipcMain.handle("bridge:start", async (_event, payload) => {
  if (payload && payload.port != null) {
    bridgePort = ensurePort(payload.port);
  }
  startBridgeService();
  return { ok: true, running: isBridgeRunning(), port: bridgePort };
});

ipcMain.handle("bridge:stop", async () => {
  stopBridgeService();
  return { ok: true, running: isBridgeRunning(), port: bridgePort };
});

ipcMain.handle("bridge:search-games", async (_event, payload) => {
  return searchGames(payload && payload.query);
});
ipcMain.handle("bridge:get-custom-apps", async () => loadCustomApps());
ipcMain.handle("bridge:add-custom-app", async (_event, payload) => addCustomApp(payload || {}));
ipcMain.handle("bridge:remove-custom-app", async (_event, payload) => removeCustomApp(payload && payload.exe));

app.whenReady().then(() => {
  createWindow();
  createTray();
  startBridgeService();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});
