const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const DEFAULT_CLIENT_URL = "https://fluxer.app";

function resolveArgUrl() {
  const arg = process.argv.find((item) => item.startsWith("--url="));
  if (!arg) return null;
  const value = arg.slice("--url=".length).trim();
  return value || null;
}

function resolveConfigUrl() {
  const configPath = path.join(__dirname, "fluxer.config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config.clientUrl || null;
  } catch (_) {
    return null;
  }
}

function resolveClientUrl() {
  return process.env.FLUXER_CLIENT_URL || resolveArgUrl() || resolveConfigUrl() || DEFAULT_CLIENT_URL;
}

function createMainWindow() {
  const clientUrl = resolveClientUrl();
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Fluxer + BetterFluxer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  window.loadURL(clientUrl);
}

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
