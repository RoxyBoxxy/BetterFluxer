const fs = require("fs");
const path = require("path");

const nwWindow = nw.Window.get();
const nwApp = nw.App;

const DEFAULT_CLIENT_URL = "https://fluxer.app";

function resolveArgUrl() {
  const argv = nwApp.argv || process.argv;
  const arg = argv.find((item) => item.startsWith("--url="));
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
  
  nwWindow.loadURL(clientUrl);  
}

nwWindow.on('loaded', () => { 
  createMainWindow();
});

nwWindow.on('restore', () => {
  nwWindow.focus();
});

nwWindow.on('close', () => {
  if (nwApp.manifest.window?.minimize || process.platform === 'darwin') {
    nwWindow.minimize();
  } else {
    nwApp.quit();
  }
});
