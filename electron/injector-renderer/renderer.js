const installRootEl = document.getElementById("installRoot");
const versionEl = document.getElementById("version");
const appPathEl = document.getElementById("appPath");
const splashIconBase64El = document.getElementById("splashIconBase64");
const closeFirstEl = document.getElementById("closeFirst");
const statusGridEl = document.getElementById("statusGrid");
const logEl = document.getElementById("log");
const modeSimpleBtn = document.getElementById("modeSimpleBtn");
const modeAdvancedBtn = document.getElementById("modeAdvancedBtn");

const checkBtn = document.getElementById("checkBtn");
const closeBtn = document.getElementById("closeBtn");
const installLatestBtn = document.getElementById("installLatestBtn");
const injectBtn = document.getElementById("injectBtn");
const uninjectBtn = document.getElementById("uninjectBtn");

const UI_MODE_KEY = "betterfluxer:injectorMode";
const SPLASH_ICON_KEY = "betterfluxer:splashIconBase64";
let supportsAutoClose = true;
let promptedAppImagePath = null;
let isLinux = false;
let linuxLatestAppImageUrl = null;
let currentMode = "simple";
let lastStatus = null;

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  logEl.textContent += `[${timestamp}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function getOptions() {
  const splashIconBase64 = splashIconBase64El ? splashIconBase64El.value.trim() : "";
  return {
    installRoot: installRootEl.value.trim(),
    version: versionEl.value.trim() || undefined,
    appPath: appPathEl.value.trim() || undefined,
    closeFluxerFirst: closeFirstEl.checked,
    splashIconBase64: splashIconBase64 || undefined
  };
}

function statusFields(status) {
  const processInfo = status.process || {};
  if (currentMode === "simple") {
    return [
      ["App Path", status.appPath || "Unknown"],
      ["Fluxer Running", status.fluxerRunning ? "Yes" : "No"],
      ["Injected", status.injected ? "Yes" : "No"],
      ["App Path Writable", status.appPath ? (status.appPathWritable ? "Yes" : "No") : "Unknown"],
      ["Resolve Error", status.resolveError || "None"]
    ];
  }

  return [
    ["App Path", status.appPath || "Unknown"],
    ["Installed Versions", status.versions?.join(", ") || "None found"],
    ["Fluxer Running", status.fluxerRunning ? "Yes" : "No"],
    ["Fluxer PID(s)", processInfo.pids?.join(", ") || "None"],
    ["Detected AppImage", processInfo.appImagePath || "Unknown"],
    ["Detected Process App Path", processInfo.appPath || "Unknown"],
    ["App Path Writable", status.appPath ? (status.appPathWritable ? "Yes" : "No") : "Unknown"],
    ["Preload Exists", status.preloadExists ? "Yes" : "No"],
    ["Backup Exists", status.backupExists ? "Yes" : "No"],
    ["Runtime Folder Exists", status.runtimeExists ? "Yes" : "No"],
    ["Injected", status.injected ? "Yes" : "No"],
    ["Resolve Error", status.resolveError || "None"]
  ];
}

function renderStatus(status) {
  lastStatus = status;
  statusGridEl.innerHTML = "";
  for (const [key, value] of statusFields(status)) {
    const card = document.createElement("div");
    card.className = "status";
    card.innerHTML = `<div class="k">${key}</div><div class="v">${value}</div>`;
    statusGridEl.appendChild(card);
  }
}

function applyMode(mode) {
  currentMode = mode === "advanced" ? "advanced" : "simple";
  document.body.setAttribute("data-mode", currentMode);
  modeSimpleBtn.setAttribute("aria-pressed", String(currentMode === "simple"));
  modeAdvancedBtn.setAttribute("aria-pressed", String(currentMode === "advanced"));
  modeSimpleBtn.classList.toggle("active", currentMode === "simple");
  modeAdvancedBtn.classList.toggle("active", currentMode === "advanced");
  localStorage.setItem(UI_MODE_KEY, currentMode);
  if (lastStatus) {
    renderStatus(lastStatus);
  }
}

function needsAppImageInstallPrompt(status) {
  const processInfo = status.process || {};
  if (!processInfo.appImagePath) return false;
  if (!status.fluxerRunning) return false;
  return !status.appPath || !status.appPathWritable;
}

async function showAppImageInstallPrompt(status) {
  const processInfo = status.process || {};
  const appImagePath = processInfo.appImagePath;
  if (!appImagePath) return;
  if (promptedAppImagePath === appImagePath) return;

  const shouldInstall = window.confirm(
    "Fluxer is running from an AppImage. This is usually read-only at runtime, so BetterFluxer cannot patch it persistently.\n\nUse the 'Install Latest Fluxer (Linux)' button to install a writable copy to ~/.fluxer.\n\nPress OK to dismiss."
  );
  promptedAppImagePath = appImagePath;
  if (shouldInstall) return;
}

async function refreshStatus() {
  try {
    const status = await window.InjectorApi.getStatus(getOptions());
    renderStatus(status);
    if (needsAppImageInstallPrompt(status)) {
      await showAppImageInstallPrompt(status);
    }
    if (status.resolveError) {
      log(`Target resolve warning: ${status.resolveError}`);
    }
    log(`Status refreshed for ${status.appPath}`);
    return status;
  } catch (error) {
    log(`Status error: ${error.message}`);
    throw error;
  }
}

async function setBusy(isBusy) {
  checkBtn.disabled = isBusy;
  closeBtn.disabled = isBusy || !supportsAutoClose || currentMode !== "advanced";
  installLatestBtn.disabled = isBusy || !isLinux;
  injectBtn.disabled = isBusy;
  uninjectBtn.disabled = isBusy;
}

async function initDefaults() {
  try {
    const defaults = await window.InjectorApi.getDefaults();
    if (!installRootEl.value.trim()) {
      installRootEl.value = defaults.defaultInstallRoot || "";
    }
    isLinux = defaults.platform === "linux";
    linuxLatestAppImageUrl = defaults.linuxLatestAppImageUrl || null;
    supportsAutoClose = Boolean(defaults.supportsAutoClose);
    closeBtn.disabled = !supportsAutoClose;
    installLatestBtn.hidden = !isLinux;
    installLatestBtn.disabled = !isLinux;
    if (isLinux && linuxLatestAppImageUrl) {
      installLatestBtn.title = `Download: ${linuxLatestAppImageUrl}`;
    } else {
      installLatestBtn.title = "";
    }
    if (!supportsAutoClose) {
      closeBtn.title = "Automatic close is not supported on this OS";
      log("Automatic close is unavailable on this OS. Close Fluxer manually before inject/uninject.");
    } else {
      closeBtn.title = "";
    }
    if (splashIconBase64El && !splashIconBase64El.value.trim()) {
      const saved = localStorage.getItem(SPLASH_ICON_KEY) || "";
      splashIconBase64El.value = saved;
    }
  } catch (error) {
    log(`Defaults error: ${error.message}`);
  }
}

if (splashIconBase64El) {
  splashIconBase64El.addEventListener("input", () => {
    localStorage.setItem(SPLASH_ICON_KEY, splashIconBase64El.value || "");
  });
}

checkBtn.addEventListener("click", async () => {
  await refreshStatus();
});

closeBtn.addEventListener("click", async () => {
  await setBusy(true);
  try {
    const result = await window.InjectorApi.closeFluxer();
    log(result.message);
    await refreshStatus();
  } catch (error) {
    log(`Close error: ${error.message}`);
  } finally {
    await setBusy(false);
  }
});

installLatestBtn.addEventListener("click", async () => {
  await setBusy(true);
  try {
    log(`Downloading latest Fluxer AppImage from ${linuxLatestAppImageUrl || "configured URL"}...`);
    const result = await window.InjectorApi.installLatestLinuxAppImage();
    appPathEl.value = result.appPath || "";
    installRootEl.value = result.installRoot || installRootEl.value;
    log(`Downloaded AppImage to ${result.downloadedPath}`);
    log(`Installed Fluxer to ${result.appPath}`);
    log(`Desktop entry written to ${result.desktopEntryPath}`);
    window.alert("Latest Fluxer installed to ~/.fluxer and added to your app menu.");
    await refreshStatus();
  } catch (error) {
    log(`Install latest error: ${error.message}`);
    window.alert(`Install latest failed:\n${error.message}`);
  } finally {
    await setBusy(false);
  }
});

injectBtn.addEventListener("click", async () => {
  await setBusy(true);
  try {
    const result = await window.InjectorApi.inject(getOptions());
    log(result.changed ? "Inject complete. Preload patched." : "Inject complete. Preload already patched.");
    renderStatus(result.status);
  } catch (error) {
    log(`Inject error: ${error.message}`);
  } finally {
    await setBusy(false);
  }
});

uninjectBtn.addEventListener("click", async () => {
  await setBusy(true);
  try {
    const result = await window.InjectorApi.uninject(getOptions());
    log("Uninject complete.");
    renderStatus(result.status);
  } catch (error) {
    log(`Uninject error: ${error.message}`);
  } finally {
    await setBusy(false);
  }
});

modeSimpleBtn.addEventListener("click", () => applyMode("simple"));
modeAdvancedBtn.addEventListener("click", () => applyMode("advanced"));

initDefaults().finally(() => {
  applyMode(localStorage.getItem(UI_MODE_KEY) || "simple");
  refreshStatus();
});
