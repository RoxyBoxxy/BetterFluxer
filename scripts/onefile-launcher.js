const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

if (process.platform !== "win32") {
  console.error("[BetterFluxer OneFile] Windows only.");
  process.exit(1);
}

const APP_EXE_NAME = "BetterFluxerInjector.exe";
const LOG_PATH = path.join(os.tmpdir(), "BetterFluxer-OneFile", "launcher.log");
const SPLASH_DIR = path.join(os.tmpdir(), "BetterFluxer-OneFile");
const SPLASH_STATUS_PATH = path.join(SPLASH_DIR, "splash-status.txt");
const SPLASH_DONE_PATH = path.join(SPLASH_DIR, "splash-done.flag");
const SPLASH_SCRIPT_PATH = path.join(SPLASH_DIR, "splash.ps1");

function fileSha1(filePath) {
  const hash = crypto.createHash("sha1");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex").slice(0, 12);
}

function ensureExtracted(zipPath) {
  const sig = fileSha1(zipPath);
  const baseDir = path.join(os.tmpdir(), "BetterFluxer-OneFile");
  const extractDir = path.join(baseDir, sig);
  const marker = path.join(extractDir, ".ready");
  const zipTemp = path.join(baseDir, `${sig}.zip`);

  if (fs.existsSync(marker)) {
    return extractDir;
  }

  fs.mkdirSync(baseDir, { recursive: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  fs.writeFileSync(zipTemp, fs.readFileSync(zipPath));

  const psCommand = [
    "$ErrorActionPreference = 'Stop'",
    `Expand-Archive -LiteralPath '${zipTemp.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
  ].join("; ");

  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand], {
    windowsHide: true,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`Expand-Archive failed: ${String(result.stderr || result.stdout || "").trim()}`);
  }

  fs.writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
  return extractDir;
}

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch (_) {}
}

function writeSplashStatus(text) {
  try {
    fs.mkdirSync(SPLASH_DIR, { recursive: true });
    fs.writeFileSync(SPLASH_STATUS_PATH, String(text || ""), "utf8");
  } catch (_) {}
}

function createSplashScript() {
  const esc = (value) => String(value || "").replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    `$statusPath = '${esc(SPLASH_STATUS_PATH)}'`,
    `$donePath = '${esc(SPLASH_DONE_PATH)}'`,
    "$form = New-Object System.Windows.Forms.Form",
    "$form.Text = 'BetterFluxer'",
    "$form.StartPosition = 'CenterScreen'",
    "$form.Size = New-Object System.Drawing.Size(420,120)",
    "$form.FormBorderStyle = 'FixedDialog'",
    "$form.MaximizeBox = $false",
    "$form.MinimizeBox = $false",
    "$form.TopMost = $true",
    "$form.ShowInTaskbar = $false",
    "$label = New-Object System.Windows.Forms.Label",
    "$label.AutoSize = $false",
    "$label.TextAlign = 'MiddleCenter'",
    "$label.Dock = 'Fill'",
    "$label.Font = New-Object System.Drawing.Font('Segoe UI',10,[System.Drawing.FontStyle]::Regular)",
    "$label.Text = 'Starting BetterFluxer...'",
    "$form.Controls.Add($label)",
    "$timer = New-Object System.Windows.Forms.Timer",
    "$timer.Interval = 180",
    "$timer.Add_Tick({",
    "  if (Test-Path -LiteralPath $donePath) {",
    "    $timer.Stop()",
    "    $form.Close()",
    "    return",
    "  }",
    "  if (Test-Path -LiteralPath $statusPath) {",
    "    try {",
    "      $text = Get-Content -LiteralPath $statusPath -Raw",
    "      if ($text) { $label.Text = $text.Trim() }",
    "    } catch {}",
    "  }",
    "})",
    "$form.Add_Shown({ $timer.Start() })",
    "[void]$form.ShowDialog()"
  ].join("\n");

  fs.mkdirSync(SPLASH_DIR, { recursive: true });
  fs.writeFileSync(SPLASH_SCRIPT_PATH, `${script}\n`, "utf8");
}

function startSplash() {
  try {
    fs.mkdirSync(SPLASH_DIR, { recursive: true });
    fs.rmSync(SPLASH_DONE_PATH, { force: true });
    createSplashScript();
    writeSplashStatus("Preparing BetterFluxer...");
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SPLASH_SCRIPT_PATH], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  } catch (error) {
    appendLog(`Splash failed to start: ${error && error.message ? error.message : String(error)}`);
  }
}

function stopSplash() {
  try {
    fs.mkdirSync(SPLASH_DIR, { recursive: true });
    fs.writeFileSync(SPLASH_DONE_PATH, "1\n", "utf8");
  } catch (_) {}
}

function collectExeFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectExeFiles(p, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
      out.push(p);
    }
  }
  return out;
}

function resolveAppExePath(extractDir) {
  const direct = path.join(extractDir, APP_EXE_NAME);
  if (fs.existsSync(direct)) return direct;

  const allExes = collectExeFiles(extractDir, []);
  if (allExes.length === 0) return "";

  const preferred = allExes.find((p) => path.basename(p).toLowerCase() === APP_EXE_NAME);
  if (preferred) return preferred;

  const nonRuntime = allExes.find((p) => {
    const n = path.basename(p).toLowerCase();
    return ![
      "notification_helper.exe",
      "crashpad_handler.exe"
    ].includes(n);
  });
  return nonRuntime || allExes[0];
}

function main() {
  startSplash();
  const zipCandidates = [
    path.join(__dirname, "nw-win64.zip"),
    path.join(__dirname, "..", "dist", "nw-win64.zip"),
    path.join(process.cwd(), "nw-win64.zip")
  ];
  const zipPath = zipCandidates.find((p) => fs.existsSync(p));
  if (!zipPath) {
    writeSplashStatus("Runtime package missing.");
    throw new Error(`Embedded runtime zip missing. Checked: ${zipCandidates.join(" | ")}`);
  }
  writeSplashStatus("Extracting runtime...");
  const extractDir = ensureExtracted(zipPath);
  writeSplashStatus("Preparing application...");
  const exePath = resolveAppExePath(extractDir);
  if (!exePath) {
    writeSplashStatus("Application executable missing.");
    throw new Error(`Extractor succeeded but no app exe found under: ${extractDir}`);
  }
  const args = process.argv.slice(2);
  writeSplashStatus("Launching injector...");
  appendLog(`Launching ${exePath}`);
  const child = spawn(exePath, args, {
    cwd: path.dirname(exePath),
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  stopSplash();
}

try {
  main();
} catch (error) {
  writeSplashStatus("Failed to launch. See launcher log.");
  appendLog(`Launch failed: ${error && error.message ? error.message : String(error)}`);
  console.error("[BetterFluxer OneFile] Launch failed:", error && error.message ? error.message : error);
  console.error(`[BetterFluxer OneFile] See log: ${LOG_PATH}`);
  setTimeout(() => {
    stopSplash();
  }, 1500);
  process.exit(1);
}
