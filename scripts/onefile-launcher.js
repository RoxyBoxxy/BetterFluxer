const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

if (process.platform !== "win32") {
  console.error("[BetterFluxer OneFile] Windows only.");
  process.exit(1);
}

const EMBEDDED_ZIP_PATH = path.join(__dirname, "..", "dist", "nw-win64.zip");
const APP_EXE_NAME = "betterfluxer-injector.exe";

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

  if (fs.existsSync(marker) && fs.existsSync(path.join(extractDir, APP_EXE_NAME))) {
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

function main() {
  if (!fs.existsSync(EMBEDDED_ZIP_PATH)) {
    throw new Error(`Embedded runtime zip missing: ${EMBEDDED_ZIP_PATH}`);
  }
  const extractDir = ensureExtracted(EMBEDDED_ZIP_PATH);
  const exePath = path.join(extractDir, APP_EXE_NAME);
  if (!fs.existsSync(exePath)) {
    throw new Error(`Extractor succeeded but app exe missing: ${exePath}`);
  }
  const args = process.argv.slice(2);
  const child = spawn(exePath, args, {
    cwd: extractDir,
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
}

try {
  main();
} catch (error) {
  console.error("[BetterFluxer OneFile] Launch failed:", error && error.message ? error.message : error);
  process.exit(1);
}
