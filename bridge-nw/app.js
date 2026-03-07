const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(process.cwd(), "..");
const BRIDGE_URL = "http://127.0.0.1:21864";
const APP_NAME = "BetterFluxer";

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const healthBtn = document.getElementById("healthBtn");
const probeBtn = document.getElementById("probeBtn");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

let bridgeProc = null;
let tray = null;
let isQuitting = false;

function getBundleRoot() {
  try {
    if (typeof nw !== "undefined" && nw && nw.App && nw.App.startPath) {
      return String(nw.App.startPath);
    }
  } catch (_) {}
  return process.cwd();
}

function getTrayIconPath() {
  const bundleRoot = getBundleRoot();
  const candidates = [
    path.join(bundleRoot, "bridge-nw", "assets", "betterfluxertransicon.ico"),
    path.join(bundleRoot, "bridge-nw", "assets", "betterfluxertransicon.png"),
    path.join(bundleRoot, "package.nw", "bridge-nw", "assets", "betterfluxertransicon.ico"),
    path.join(bundleRoot, "package.nw", "bridge-nw", "assets", "betterfluxertransicon.png"),
    path.join(path.dirname(process.execPath), "package.nw", "bridge-nw", "assets", "betterfluxertransicon.ico"),
    path.join(path.dirname(process.execPath), "package.nw", "bridge-nw", "assets", "betterfluxertransicon.png")
  ];
  return candidates.find((p) => fs.existsSync(p)) || "";
}

function resolveNodeExec() {
  const npmNode = String(process.env.npm_node_execpath || "").trim();
  if (npmNode && fs.existsSync(npmNode)) return npmNode;
  if (process.platform === "win32") {
    const localNodeCandidates = [
      path.join(path.resolve(process.cwd(), ".."), "node.exe"),
      path.join(path.dirname(process.execPath), "node.exe")
    ];
    const existing = localNodeCandidates.find((p) => fs.existsSync(p));
    if (existing) return existing;
  }
  return "node";
}

function getAppDataHome() {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function readBridgeToken() {
  try {
    const tokenPath = path.join(getAppDataHome(), APP_NAME, "data", "bridge-token.txt");
    if (!fs.existsSync(tokenPath)) return "";
    return String(fs.readFileSync(tokenPath, "utf8") || "").trim();
  } catch (_) {
    return "";
  }
}

function getBridgeRuntimeRoot() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "BetterFluxer", "bridge");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "BetterFluxer", "bridge");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "BetterFluxer", "bridge");
}

function getBundledBridgeScriptPath() {
  const bundleRoot = getBundleRoot();
  const candidates = [
    path.join(bundleRoot, "bridge-nw", "scripts", "local-bridge.js"),
    path.join(bundleRoot, "package.nw", "bridge-nw", "scripts", "local-bridge.js"),
    path.join(path.dirname(process.execPath), "package.nw", "bridge-nw", "scripts", "local-bridge.js"),
    path.join(bundleRoot, "scripts", "local-bridge.js"),
    path.join(bundleRoot, "package.nw", "scripts", "local-bridge.js"),
    path.join(path.dirname(process.execPath), "package.nw", "scripts", "local-bridge.js"),
    path.join(ROOT, "scripts", "local-bridge.js")
  ];
  return candidates.find((p) => fs.existsSync(p)) || "";
}

function getBundledBridgeExePath() {
  if (process.platform !== "win32") return "";
  const runtimeRoot = getBridgeRuntimeRoot();
  const bundleRoot = getBundleRoot();
  const candidates = [
    path.join(runtimeRoot, "BetterFluxerBridge.exe"),
    path.join(bundleRoot, "bridge-nw", "BetterFluxerBridge.exe"),
    path.join(path.dirname(process.execPath), "BetterFluxerBridge.exe")
  ];
  return candidates.find((p) => fs.existsSync(p)) || "";
}

function materializeBridgeRuntimeFiles() {
  const sourceBridgeScript = getBundledBridgeScriptPath();
  if (!sourceBridgeScript) return "";
  const bundleRoot = getBundleRoot();

  const runtimeRoot = getBridgeRuntimeRoot();
  const runtimeScriptsDir = path.join(runtimeRoot, "scripts");
  fs.mkdirSync(runtimeScriptsDir, { recursive: true });
  const runtimeBridgeScript = path.join(runtimeScriptsDir, "local-bridge.js");
  fs.copyFileSync(sourceBridgeScript, runtimeBridgeScript);

  const bundledEnvCandidates = [
    path.join(bundleRoot, "bridge-nw", ".env"),
    path.join(bundleRoot, "package.nw", "bridge-nw", ".env"),
    path.join(path.dirname(process.execPath), "package.nw", "bridge-nw", ".env"),
    path.join(ROOT, "bridge-nw", ".env"),
    path.join(bundleRoot, "bridge", ".env"),
    path.join(ROOT, "bridge", ".env")
  ];
  const bundledEnv = bundledEnvCandidates.find((p) => fs.existsSync(p));
  if (bundledEnv) {
    const runtimeBridgeEnvDir = path.join(runtimeRoot, "bridge");
    fs.mkdirSync(runtimeBridgeEnvDir, { recursive: true });
    fs.copyFileSync(bundledEnv, path.join(runtimeBridgeEnvDir, ".env"));
  }

  return runtimeBridgeScript;
}

function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
}

function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += String(chunk || "");
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
  });
}

function startBridge() {
  if (bridgeProc) {
    log("Bridge already running in this app session.");
    return;
  }
  try {
    const runtimeBridgeScript = materializeBridgeRuntimeFiles();
    const runtimeRoot = getBridgeRuntimeRoot();
    const bundledExe = getBundledBridgeExePath();
    if (!bundledExe && (!runtimeBridgeScript || !fs.existsSync(runtimeBridgeScript))) {
      log(`Missing bridge script: ${path.join(getBridgeRuntimeRoot(), "scripts", "local-bridge.js")}`);
      return;
    }

    let launchCmd = "";
    let launchArgs = [];
    if (bundledExe) {
      launchCmd = bundledExe;
      launchArgs = [];
    } else {
      const nodeExec = resolveNodeExec();
      launchCmd = nodeExec;
      launchArgs = [runtimeBridgeScript];
    }

    bridgeProc = spawn(launchCmd, launchArgs, {
      cwd: runtimeRoot,
      env: process.env,
      windowsHide: false
    });
    setStatus("starting...");
    bridgeProc.stdout.on("data", (chunk) => log(String(chunk).trimEnd()));
    bridgeProc.stderr.on("data", (chunk) => log(String(chunk).trimEnd()));
    bridgeProc.on("error", (err) => {
      log(`Bridge launch failed: ${err && err.message ? err.message : String(err)}`);
      bridgeProc = null;
      setStatus("failed");
    });
    bridgeProc.on("exit", (code) => {
      log(`Bridge exited with code ${code}`);
      bridgeProc = null;
      setStatus("stopped");
    });
    log("Bridge process started.");
  } catch (err) {
    log(`Start handler error: ${err && err.message ? err.message : String(err)}`);
    setStatus("failed");
  }
}

function stopBridge() {
  if (!bridgeProc) {
    log("Bridge not running in this app session.");
    return;
  }
  try {
    bridgeProc.kill();
    log("Sent stop signal to bridge process.");
  } catch (err) {
    log(`Failed to stop bridge: ${err.message}`);
  }
}

async function checkHealth() {
  try {
    const health = await httpJson(`${BRIDGE_URL}/health`);
    setStatus(health && health.ok ? "running" : "degraded");
    log(`Health: ${JSON.stringify(health)}`);
  } catch (err) {
    setStatus("offline");
    log(`Health check failed: ${err.message}`);
  }
}

async function probeNowPlaying() {
  const token = readBridgeToken();
  if (!token) {
    log("Bridge token not found. Start bridge first.");
    return;
  }
  try {
    const np = await httpJson(`${BRIDGE_URL}/now-playing?token=${encodeURIComponent(token)}`);
    log(`NowPlaying: ${JSON.stringify(np)}`);
  } catch (err) {
    log(`Probe failed: ${err.message}`);
  }
}

startBtn.addEventListener("click", startBridge);
stopBtn.addEventListener("click", stopBridge);
healthBtn.addEventListener("click", checkHealth);
probeBtn.addEventListener("click", probeNowPlaying);

window.addEventListener("beforeunload", () => {
  if (bridgeProc) {
    try {
      bridgeProc.kill();
    } catch (_) {}
    bridgeProc = null;
  }
});

function setupTrayBehavior() {
  if (typeof nw === "undefined" || !nw || !nw.Window) return;
  const win = nw.Window.get();
  const iconPath = getTrayIconPath();

  try {
    tray = new nw.Tray({
      title: "BetterFluxer Bridge",
      icon: iconPath || undefined
    });
  } catch (_) {
    return;
  }

  const menu = new nw.Menu();
  menu.append(
    new nw.MenuItem({
      label: "Open BetterFluxer Bridge",
      click: () => {
        try {
          win.show();
          if (typeof win.restore === "function") {
            win.restore();
          }
          win.focus();
        } catch (_) {}
      }
    })
  );
  menu.append(new nw.MenuItem({ type: "separator" }));
  menu.append(
    new nw.MenuItem({
      label: "Exit",
      click: () => {
        try {
          isQuitting = true;
          if (tray) {
            tray.remove();
            tray = null;
          }
          if (typeof nw !== "undefined" && nw && nw.App && typeof nw.App.quit === "function") {
            nw.App.quit();
            return;
          }
          win.close(true);
        } catch (_) {}
      }
    })
  );
  tray.menu = menu;
  tray.on("click", () => {
    try {
      win.show();
      if (typeof win.restore === "function") {
        win.restore();
      }
      win.focus();
    } catch (_) {}
  });

  win.on("minimize", function () {
    this.hide();
  });

  win.on("close", function () {
    if (isQuitting) {
      try {
        if (tray) {
          tray.remove();
          tray = null;
        }
      } catch (_) {}
      if (typeof nw !== "undefined" && nw && nw.App && typeof nw.App.quit === "function") {
        nw.App.quit();
        return;
      }
      this.close(true);
      return;
    }
    this.hide();
  });
}

setStatus("idle");
log("Bridge NW app ready.");
setupTrayBehavior();
