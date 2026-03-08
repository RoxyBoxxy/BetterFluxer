const installRootEl = document.getElementById("installRoot");
const versionEl = document.getElementById("version");
const appPathEl = document.getElementById("appPath");
const customSplashIconDataUrlEl = document.getElementById("customSplashIconDataUrl");
const customSplashPulseColorEl = document.getElementById("customSplashPulseColor");
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
const CUSTOM_SPLASH_ICON_KEY = "betterfluxer:customSplashIconDataUrl";
const CUSTOM_SPLASH_PULSE_COLOR_KEY = "betterfluxer:customSplashPulseColor";
let supportsAutoClose = true;
let promptedAppImagePath = null;
let isLinux = false;
let linuxLatestAppImageUrl = null;
let currentMode = "simple";
let lastStatus = null;
let autoInjectAttempted = false;
let startupWakeInProgress = false;

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  logEl.textContent += `[${timestamp}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusCardsRendered() {
  return Boolean(statusGridEl && statusGridEl.children && statusGridEl.children.length > 0);
}

function ensureInjectorApi() {
  if (window.InjectorApi) return true;
  log("Injector API not ready yet.");
  return false;
}

async function waitForInjectorApi(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (window.InjectorApi) return true;
    await delay(120);
  }
  return Boolean(window.InjectorApi);
}

function getOptions() {
  return {
    installRoot: installRootEl.value.trim(),
    version: versionEl.value.trim() || undefined,
    appPath: appPathEl.value.trim() || undefined,
    closeFluxerFirst: closeFirstEl.checked,
    customSplashIconDataUrl: customSplashIconDataUrlEl ? customSplashIconDataUrlEl.value.trim() || undefined : undefined,
    customSplashPulseColor: customSplashPulseColorEl ? customSplashPulseColorEl.value.trim() || undefined : undefined
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
  localStorage.setItem(UI_MODE_KEY, currentMode);

  const isAdvanced = currentMode === "advanced";

  document.querySelectorAll("[data-advanced]").forEach(el => {
    if (el.id === "installLatestBtn") return;
    el.classList.toggle("hidden", !isAdvanced);
  });

  modeSimpleBtn.className = `px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
    !isAdvanced ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"
  }`;
  modeAdvancedBtn.className = `px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
    isAdvanced ? "bg-white/10 text-white" : "text-gray-400 hover:text-white"
  }`;

  if (lastStatus) renderStatus(lastStatus);
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

async function maybeAutoInject(status) {
  if (autoInjectAttempted) return status;
  if (!status || status.injected) return status;
  if (!window.InjectorApi || typeof window.InjectorApi.inject !== "function") return status;
  autoInjectAttempted = true;

  log("Auto-inject: BetterFluxer not detected, running inject...");
  try {
    const autoOptions = {
      ...getOptions(),
      closeFluxerFirst: false
    };
    const result = await window.InjectorApi.inject(autoOptions);
    log(result.changed ? "Auto-inject complete. Preload patched." : "Auto-inject complete. Preload already patched.");
    if (result && result.relaunch) {
      log(`Auto-inject relaunch: ${result.relaunch.message}`);
    }
    if (result && result.status) {
      renderStatus(result.status);
      return result.status;
    }
  } catch (error) {
    log(`Auto-inject skipped: ${error.message}`);
  }
  return status;
}

async function runStatusPipeline() {
  const status = await refreshStatus();
  const afterInject = await maybeAutoInject(status);
  if (afterInject && afterInject !== status) {
    return afterInject;
  }
  if (status && status.injected) {
    return status;
  }
  // Re-read status after auto-inject attempt so UI always reflects final state.
  try {
    return await refreshStatus();
  } catch (_) {
    return status;
  }
}

async function startupStatusAndAutoInject() {
  const attempts = 4;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await runStatusPipeline();
      return;
    } catch (error) {
      log(`Startup check retry ${i + 1}/${attempts}: ${error.message}`);
      await delay(700);
    }
  }
  log("Startup check failed after retries. Use Check Status to retry manually.");
}

function startStartupWakeLoop() {
  if (startupWakeInProgress) return;
  startupWakeInProgress = true;
  let attempts = 0;
  const maxAttempts = 15;
  const timer = setInterval(async () => {
    attempts += 1;
    try {
      await runStatusPipeline();
      if (statusCardsRendered()) {
        clearInterval(timer);
        startupWakeInProgress = false;
        log("Startup wake: status cards ready.");
        return;
      }
    } catch (_) {}
    if (attempts >= maxAttempts) {
      clearInterval(timer);
      startupWakeInProgress = false;
      log("Startup wake: timed out. Use Check Status.");
    }
  }, 700);
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
    if (customSplashIconDataUrlEl && !customSplashIconDataUrlEl.value.trim()) {
      customSplashIconDataUrlEl.value = defaults.defaultCustomSplashIconDataUrl || "";
    }
    if (customSplashPulseColorEl && !customSplashPulseColorEl.value.trim()) {
      customSplashPulseColorEl.value = defaults.defaultCustomSplashPulseColor || "";
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
  } catch (error) {
    log(`Defaults error: ${error.message}`);
  }
}

checkBtn.addEventListener("click", async () => {
  await runStatusPipeline();
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
    if (result && result.relaunch) {
      log(`Relaunch: ${result.relaunch.message}`);
    }
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
  try {
    if (customSplashIconDataUrlEl) {
      customSplashIconDataUrlEl.value = localStorage.getItem(CUSTOM_SPLASH_ICON_KEY) || "";
      customSplashIconDataUrlEl.addEventListener("input", () => {
        localStorage.setItem(CUSTOM_SPLASH_ICON_KEY, customSplashIconDataUrlEl.value || "");
      });
    }
    if (customSplashPulseColorEl) {
      customSplashPulseColorEl.value = localStorage.getItem(CUSTOM_SPLASH_PULSE_COLOR_KEY) || "";
      customSplashPulseColorEl.addEventListener("input", () => {
        localStorage.setItem(CUSTOM_SPLASH_PULSE_COLOR_KEY, customSplashPulseColorEl.value || "");
      });
    }
  } catch (_) {}

  applyMode(localStorage.getItem(UI_MODE_KEY) || "simple");
  waitForInjectorApi(8000).then((ready) => {
    if (!ready) {
      log("Injector API unavailable after startup wait. Use Check Status once API appears.");
      return;
    }
    // Mirror the known-working manual path: trigger Check Status automatically.
    const tryAutoCheck = async (attempt = 1) => {
      try {
        checkBtn.click();
      } catch (_) {
        await startupStatusAndAutoInject();
      }
      if (!statusCardsRendered() && attempt < 4) {
        await delay(900);
        return tryAutoCheck(attempt + 1);
      }
      // Keep existing auto pipeline as a fallback/second pass.
      if (!statusCardsRendered()) {
        await startupStatusAndAutoInject();
      }
    };
    tryAutoCheck();
    startStartupWakeLoop();
  });
});
