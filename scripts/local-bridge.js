#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const APP_NAME = "BetterFluxer";

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

const BRIDGE_BASE_DIR = getBridgeBaseDir();
const DATA_DIR = path.join(BRIDGE_BASE_DIR, "data");
const TOKEN_FILE = path.join(DATA_DIR, "bridge-token.txt");
const CACHE_FILE = path.join(DATA_DIR, "bridge-cache.json");

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.BF_BRIDGE_PORT || "21864", 10);
const BRIDGE_VERSION = "2026-03-07-winrt-v3";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.BF_BRIDGE_TIMEOUT_MS || "12000", 10);
const DEFAULT_TTL_SECONDS = Number.parseInt(process.env.BF_BRIDGE_DEFAULT_TTL || "120", 10);
const MAX_TTL_SECONDS = Number.parseInt(process.env.BF_BRIDGE_MAX_TTL || "1800", 10);
const STARTUP_VBS_NAME = "BetterFluxerBridge.vbs";

const DEFAULT_ALLOWLIST = [
  "raw.githubusercontent.com",
  "api.github.com",
  "githubusercontent.com",
  "web.fluxer.app",
  "*.fluxer.app",
  "*.fluxer.media"
];

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readOrCreateToken() {
  ensureDataDir();
  const envToken = String(process.env.BF_BRIDGE_TOKEN || "").trim();
  if (envToken) return envToken;
  if (fs.existsSync(TOKEN_FILE)) {
    const existing = String(fs.readFileSync(TOKEN_FILE, "utf8") || "").trim();
    if (existing) return existing;
  }
  const generated = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(TOKEN_FILE, `${generated}\n`, "utf8");
  return generated;
}

function parseAllowlist() {
  const raw = String(process.env.BF_BRIDGE_ALLOWLIST || "").trim();
  if (!raw) return DEFAULT_ALLOWLIST;
  return raw
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatchesRule(hostname, rule) {
  const host = String(hostname || "").toLowerCase();
  const r = String(rule || "").toLowerCase();
  if (!host || !r) return false;
  if (r.startsWith("*.")) {
    const suffix = r.slice(1);
    return host.endsWith(suffix);
  }
  return host === r;
}

function isAllowedUrl(url, allowlist) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return (allowlist || []).some((rule) => hostMatchesRule(parsed.hostname, rule));
  } catch (_) {
    return false;
  }
}

function nowMs() {
  return Date.now();
}

function normalizeTtlSeconds(input) {
  const n = Number.parseInt(String(input || ""), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SECONDS;
  return Math.max(1, Math.min(MAX_TTL_SECONDS, n));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk || "");
      if (raw.length > 1024 * 1024) {
        raw = "";
        resolve(null);
      }
    });
    req.on("end", () => {
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function saveCache(cache) {
  ensureDataDir();
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

function parseArgv(argv) {
  const out = {};
  for (const item of argv || []) {
    if (!item || !String(item).startsWith("--")) continue;
    const raw = String(item).slice(2);
    const [k, ...rest] = raw.split("=");
    const key = String(k || "").trim();
    const value = rest.length ? rest.join("=") : true;
    if (key) out[key] = value;
  }
  return out;
}

function getWindowsStartupFolder() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

function isPackagedExe() {
  return process.platform === "win32" && String(path.extname(process.execPath || "")).toLowerCase() === ".exe";
}

function installWindowsStartup() {
  if (process.platform !== "win32") {
    console.log("[BetterFluxer Bridge] Startup install is only supported on Windows.");
    return 1;
  }

  const startupDir = getWindowsStartupFolder();
  fs.mkdirSync(startupDir, { recursive: true });
  const vbsPath = path.join(startupDir, STARTUP_VBS_NAME);
  const installDir = path.join(BRIDGE_BASE_DIR, "bridge");
  fs.mkdirSync(installDir, { recursive: true });

  let runTarget = process.execPath;
  if (isPackagedExe()) {
    const installedExePath = path.join(installDir, "BetterFluxerBridge.exe");
    if (path.resolve(process.execPath) !== path.resolve(installedExePath)) {
      fs.copyFileSync(process.execPath, installedExePath);
    }
    runTarget = installedExePath;
  }

  let runCommand = "";
  if (isPackagedExe()) {
    runCommand = `""${runTarget}" --hidden"`;
  } else {
    const scriptPath = path.resolve(__filename);
    runCommand = `""${process.execPath}" "${scriptPath}" --hidden"`;
  }

  const vbs = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.CurrentDirectory = "${installDir.replace(/"/g, '""')}"`,
    `WshShell.Run "${runCommand.replace(/"/g, '""')}", 0, False`
  ].join("\r\n");

  fs.writeFileSync(vbsPath, `${vbs}\r\n`, "utf8");
  console.log(`[BetterFluxer Bridge] Startup enabled: ${vbsPath}`);
  return 0;
}

function removeWindowsStartup() {
  if (process.platform !== "win32") {
    console.log("[BetterFluxer Bridge] Startup remove is only supported on Windows.");
    return 1;
  }
  const vbsPath = path.join(getWindowsStartupFolder(), STARTUP_VBS_NAME);
  if (fs.existsSync(vbsPath)) {
    fs.unlinkSync(vbsPath);
    console.log(`[BetterFluxer Bridge] Startup disabled: ${vbsPath}`);
  } else {
    console.log("[BetterFluxer Bridge] Startup entry not found.");
  }
  return 0;
}

function getTunaJsonPath() {
  const envPath = String(process.env.BF_TUNA_JSON_PATH || "").trim();
  if (envPath) return envPath;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Tuna", "current.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Tuna", "current.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Tuna", "current.json");
}

function normalizeNowPlayingPayload(payload, source) {
  const p = payload && typeof payload === "object" ? payload : {};
  const title = String(p.title || p.track || p.song || "").trim();
  const artist = String(p.artist || p.artists || p.author || "").trim();
  const albumTitle = String(p.albumTitle || p.album || "").trim();
  const appId = String(p.appId || p.app || p.player || "").trim();
  const playbackStatus = String(p.playbackStatus || p.status || "").trim();
  const positionRaw = p.positionMs != null ? p.positionMs : p.position;
  const durationRaw = p.durationMs != null ? p.durationMs : p.duration != null ? p.duration : p.length;
  const positionMs = Number.isFinite(Number(positionRaw)) ? Math.max(0, Number(positionRaw)) : null;
  const durationMs = Number.isFinite(Number(durationRaw)) ? Math.max(0, Number(durationRaw)) : null;
  const hasSession = Boolean(title || artist || albumTitle);
  return {
    ok: true,
    hasSession,
    source: String(source || "unknown"),
    kind: String(p.kind || "media"),
    activityType: Number.isFinite(Number(p.activityType)) ? Number(p.activityType) : null,
    title,
    artist,
    albumTitle,
    appId,
    playbackStatus,
    positionMs,
    durationMs,
    name: String(p.name || "").trim(),
    details: String(p.details || "").trim(),
    state: String(p.state || "").trim()
  };
}

function makeRpcFrame(op, payloadObject) {
  const payload = Buffer.from(JSON.stringify(payloadObject || {}), "utf8");
  const frame = Buffer.allocUnsafe(8 + payload.length);
  frame.writeInt32LE(Number(op || 1), 0);
  frame.writeInt32LE(payload.length, 4);
  payload.copy(frame, 8);
  return frame;
}

function decodeRpcFrames(buffer, onFrame) {
  let cursor = 0;
  while (buffer.length - cursor >= 8) {
    const op = buffer.readInt32LE(cursor);
    const len = buffer.readInt32LE(cursor + 4);
    if (len < 0 || len > 16 * 1024 * 1024) {
      throw new Error("Invalid RPC frame length");
    }
    if (buffer.length - cursor - 8 < len) break;
    const raw = buffer.slice(cursor + 8, cursor + 8 + len).toString("utf8");
    let msg = null;
    try {
      msg = raw ? JSON.parse(raw) : null;
    } catch (_) {
      msg = null;
    }
    onFrame(op, msg);
    cursor += 8 + len;
  }
  return buffer.slice(cursor);
}

function sendJson(res, status, payload, origin) {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-BetterFluxer-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function runCommand(command, args, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
      reject(new Error(`Command timeout: ${command}`));
    }, Math.max(1000, Number(timeoutMs || 6000)));

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: Number(code || 0),
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function runPowerShellJson(script, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true }
    );

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
      reject(new Error("PowerShell timeout"));
    }, Math.max(1000, Number(timeoutMs || 6000)));

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`PowerShell exited ${code}: ${stderr.trim() || "unknown error"}`));
        return;
      }
      const raw = String(stdout || "").trim();
      if (!raw) {
        reject(new Error("PowerShell returned empty output"));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`PowerShell JSON parse failed: ${String((error && error.message) || error)}`));
      }
    });
  });
}

async function queryWindowsMedia() {
  if (process.platform !== "win32") {
    return { ok: false, error: "Windows only", platform: process.platform };
  }

  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {",
    "  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1",
    "} | Select-Object -First 1)",
    "if ($null -eq $asTask) { throw 'System.WindowsRuntimeSystemExtensions.AsTask generic overload not found' }",
    "function Await-WinRTTyped($op, [Type]$resultType) {",
    "  if ($null -eq $op) { return $null }",
    "  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($op))",
    "  try {",
    "    return $task.GetAwaiter().GetResult()",
    "  } catch {",
    "    $msg = [string]$_.Exception",
    "    if ($_.Exception -and $_.Exception.InnerException) {",
    "      $msg = $msg + ' | inner: ' + [string]$_.Exception.InnerException",
    "      if ($_.Exception.InnerException.InnerException) {",
    "        $msg = $msg + ' | inner2: ' + [string]$_.Exception.InnerException.InnerException",
    "      }",
    "    }",
    "    throw $msg",
    "  }",
    "}",
    "$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]",
    "$mgrOp = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()",
    "$mgr = Await-WinRTTyped $mgrOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
    "$session = $mgr.GetCurrentSession()",
    "if ($null -eq $session) {",
    "  @{ ok = $true; hasSession = $false } | ConvertTo-Json -Compress",
    "  exit 0",
    "}",
    "$propsOp = $session.TryGetMediaPropertiesAsync()",
    "$props = Await-WinRTTyped $propsOp ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])",
    "$info = $session.GetPlaybackInfo()",
    "$timeline = $session.GetTimelineProperties()",
    "@{",
    "  ok = $true;",
    "  hasSession = $true;",
    "  title = [string]$props.Title;",
    "  artist = [string]$props.Artist;",
    "  albumTitle = [string]$props.AlbumTitle;",
    "  appId = [string]$session.SourceAppUserModelId;",
    "  playbackStatus = [string]$info.PlaybackStatus;",
    "  positionMs = [int64]$timeline.Position.TotalMilliseconds;",
    "  durationMs = [int64]$timeline.EndTime.TotalMilliseconds",
    "} | ConvertTo-Json -Compress"
  ].join("\n");

  try {
    return await runPowerShellJson(ps, 7000);
  } catch (error) {
    const msg = String((error && error.message) || error || "unknown");
    if (/Class not registered/i.test(msg)) {
      return {
        ok: false,
        error: "Windows GSMTC unavailable (Class not registered)"
      };
    }
    return { ok: false, error: msg };
  }
}

async function queryTunaNowPlaying(state) {
  const filePath = getTunaJsonPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: `Tuna file not found: ${filePath}` };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = raw ? JSON.parse(raw) : null;
    const tuna = parsed && typeof parsed === "object" ? parsed : {};
    const merged = {
      ...tuna,
      positionMs:
        tuna.positionMs != null
          ? tuna.positionMs
          : tuna.currentTimeMs != null
            ? tuna.currentTimeMs
            : tuna.current != null
              ? tuna.current
              : null,
      durationMs:
        tuna.durationMs != null
          ? tuna.durationMs
          : tuna.totalTimeMs != null
            ? tuna.totalTimeMs
            : tuna.duration != null
              ? tuna.duration
              : null
    };
    const normalized = normalizeNowPlayingPayload(merged, "tuna-file");
    state.tunaPath = filePath;
    if (normalized.hasSession) {
      state.lastTuna = normalized;
      state.lastTunaAt = Date.now();
    }
    return normalized;
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error || "Tuna parse failed") };
  }
}

function handleDiscordRpcMessage(message, state, socket) {
  const msg = message && typeof message === "object" ? message : {};
  const cmd = String(msg.cmd || "").toUpperCase();
  const nonce = msg.nonce != null ? msg.nonce : null;

  if (cmd === "SET_ACTIVITY") {
    const args = msg.args && typeof msg.args === "object" ? msg.args : {};
    const activity = args.activity && typeof args.activity === "object" ? args.activity : {};
    const name = String(activity.name || "").trim();
    const details = String(activity.details || "").trim();
    const stateText = String(activity.state || "").trim();
    const activityType = Number.isFinite(Number(activity.type)) ? Number(activity.type) : null;
    const kind = activityType === 0 ? "game" : "media";
    const timestamps = activity.timestamps && typeof activity.timestamps === "object" ? activity.timestamps : null;
    const startMs = timestamps && Number.isFinite(Number(timestamps.start)) ? Number(timestamps.start) : null;
    const endMs = timestamps && Number.isFinite(Number(timestamps.end)) ? Number(timestamps.end) : null;
    const now = Date.now();
    const positionMs = startMs != null ? Math.max(0, now - startMs) : null;
    const durationMs = startMs != null && endMs != null && endMs > startMs ? endMs - startMs : null;
    const text = [details || name, stateText].filter(Boolean).join(" - ");
    const payload = normalizeNowPlayingPayload(
      {
        kind,
        activityType,
        title: text || name || details || stateText,
        artist: stateText,
        albumTitle: "",
        appId: String(activity.application_id || args.pid || ""),
        playbackStatus: "playing",
        positionMs,
        durationMs,
        name,
        details,
        state: stateText
      },
      "discord-rpc-pipe"
    );
    state.lastRpcActivity = {
      raw: activity,
      normalized: payload
    };
    state.lastRpcActivityAt = Date.now();
    console.log(`[BetterFluxer Bridge] RPC activity captured: ${formatNowPlayingForLog(payload)}`);
    if (socket && !socket.destroyed) {
      socket.write(makeRpcFrame(1, { cmd: "SET_ACTIVITY", data: {}, evt: null, nonce }));
    }
    return;
  }

  if (cmd === "CLEAR_ACTIVITY") {
    state.lastRpcActivity = null;
    state.lastRpcActivityAt = Date.now();
    if (socket && !socket.destroyed) {
      socket.write(makeRpcFrame(1, { cmd: "CLEAR_ACTIVITY", data: {}, evt: null, nonce }));
    }
    return;
  }

  if (socket && !socket.destroyed && nonce != null && cmd) {
    socket.write(makeRpcFrame(1, { cmd, data: {}, evt: null, nonce }));
  }
}

function startDiscordRpcCapture(state) {
  if (process.platform !== "win32") return;
  if (state.rpcServers && state.rpcServers.length) return;
  state.rpcServers = [];
  state.rpcBindErrors = [];

  for (let i = 0; i < 10; i += 1) {
    const pipeName = `\\\\.\\pipe\\discord-ipc-${i}`;
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        try {
          buf = Buffer.concat([buf, Buffer.from(chunk)]);
          buf = decodeRpcFrames(buf, (op, msg) => {
            if (op === 0) {
              socket.write(
                makeRpcFrame(1, {
                  cmd: "DISPATCH",
                  evt: "READY",
                  data: {
                    v: 1,
                    config: {},
                    user: { id: "0", username: "BetterFluxer", discriminator: "0000", avatar: null }
                  },
                  nonce: null
                })
              );
              return;
            }
            if (op === 1) {
              handleDiscordRpcMessage(msg, state, socket);
            }
          });
        } catch (error) {
          socket.destroy(error);
        }
      });
    });

    server.on("error", (error) => {
      state.rpcBindErrors.push({ pipe: pipeName, error: String((error && error.message) || error || "unknown") });
    });

    try {
      server.listen(pipeName, () => {
        state.rpcServers.push({ pipe: pipeName, server });
      });
    } catch (error) {
      state.rpcBindErrors.push({ pipe: pipeName, error: String((error && error.message) || error || "unknown") });
    }
  }
}

async function queryLinuxMedia() {
  if (process.platform !== "linux") {
    return { ok: false, error: "Linux only", platform: process.platform };
  }

  const format = "{{title}}\t{{artist}}\t{{album}}\t{{playerName}}\t{{status}}";
  try {
    const result = await runCommand("playerctl", ["metadata", "--format", format], 4000);
    if (result.code !== 0) {
      const errText = (result.stderr || result.stdout || "").trim();
      if (/No players found/i.test(errText)) {
        return { ok: true, hasSession: false, source: "linux-mpris" };
      }
      return { ok: false, error: errText || `playerctl exited ${result.code}` };
    }

    const line = String(result.stdout || "").trim();
    if (!line) return { ok: true, hasSession: false, source: "linux-mpris" };
    const [title = "", artist = "", albumTitle = "", appId = "", playbackStatus = ""] = line.split("\t");
    return {
      ok: true,
      hasSession: Boolean(String(title).trim() || String(artist).trim()),
      source: "linux-mpris",
      title: String(title || "").trim(),
      artist: String(artist || "").trim(),
      albumTitle: String(albumTitle || "").trim(),
      appId: String(appId || "").trim(),
      playbackStatus: String(playbackStatus || "").trim()
    };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error || "playerctl failed") };
  }
}

async function queryMacMedia() {
  if (process.platform !== "darwin") {
    return { ok: false, error: "macOS only", platform: process.platform };
  }

  const script = [
    "set outTitle to \"\"",
    "set outArtist to \"\"",
    "set outAlbum to \"\"",
    "set outApp to \"\"",
    "set outState to \"\"",
    "try",
    "  tell application \"Spotify\"",
    "    if it is running then",
    "      if player state is playing then",
    "        set outTitle to name of current track",
    "        set outArtist to artist of current track",
    "        set outAlbum to album of current track",
    "        set outApp to \"Spotify\"",
    "        set outState to \"Playing\"",
    "      end if",
    "    end if",
    "  end tell",
    "end try",
    "if outTitle is \"\" then",
    "  try",
    "    tell application \"Music\"",
    "      if it is running then",
    "        if player state is playing then",
    "          set outTitle to name of current track",
    "          set outArtist to artist of current track",
    "          set outAlbum to album of current track",
    "          set outApp to \"Music\"",
    "          set outState to \"Playing\"",
    "        end if",
    "      end if",
    "    end tell",
    "  end try",
    "end if",
    "return outTitle & tab & outArtist & tab & outAlbum & tab & outApp & tab & outState"
  ].join("\n");

  try {
    const result = await runCommand("osascript", ["-e", script], 5000);
    if (result.code !== 0) {
      const errText = (result.stderr || result.stdout || "").trim();
      return { ok: false, error: errText || `osascript exited ${result.code}` };
    }
    const line = String(result.stdout || "").trim();
    if (!line) return { ok: true, hasSession: false, source: "macos-nowplaying" };
    const [title = "", artist = "", albumTitle = "", appId = "", playbackStatus = ""] = line.split("\t");
    return {
      ok: true,
      hasSession: Boolean(String(title).trim() || String(artist).trim()),
      source: "macos-nowplaying",
      title: String(title || "").trim(),
      artist: String(artist || "").trim(),
      albumTitle: String(albumTitle || "").trim(),
      appId: String(appId || "").trim(),
      playbackStatus: String(playbackStatus || "").trim()
    };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error || "osascript failed") };
  }
}

async function queryUniversalNowPlaying(state) {
  const now = Date.now();
  if (state && state.lastRpcActivity && now - Number(state.lastRpcActivityAt || 0) < 180000) {
    const raw = state.lastRpcActivity.raw && typeof state.lastRpcActivity.raw === "object" ? state.lastRpcActivity.raw : {};
    const base = state.lastRpcActivity.normalized && typeof state.lastRpcActivity.normalized === "object"
      ? { ...state.lastRpcActivity.normalized }
      : {};
    const ts = raw.timestamps && typeof raw.timestamps === "object" ? raw.timestamps : null;
    const startMs = ts && Number.isFinite(Number(ts.start)) ? Number(ts.start) : null;
    const endMs = ts && Number.isFinite(Number(ts.end)) ? Number(ts.end) : null;
    if (startMs != null) {
      base.positionMs = Math.max(0, now - startMs);
    }
    if (startMs != null && endMs != null && endMs > startMs) {
      base.durationMs = endMs - startMs;
    }
    return base;
  }

  if (process.platform === "win32") {
    const win = await queryWindowsMedia();
    const normalizedWin = { ...win, source: win && win.source ? win.source : "windows-gsmtc" };
    if (normalizedWin.ok && normalizedWin.hasSession) return normalizedWin;
    const tuna = await queryTunaNowPlaying(state);
    if (tuna && tuna.ok && tuna.hasSession) return tuna;
    return normalizedWin.ok ? normalizedWin : tuna.ok ? tuna : normalizedWin;
  }
  if (process.platform === "linux") {
    const linux = await queryLinuxMedia();
    if (linux.ok && linux.hasSession) return linux;
    const tuna = await queryTunaNowPlaying(state);
    if (tuna && tuna.ok && tuna.hasSession) return tuna;
    return linux.ok ? linux : tuna.ok ? tuna : linux;
  }
  if (process.platform === "darwin") {
    const mac = await queryMacMedia();
    if (mac.ok && mac.hasSession) return mac;
    const tuna = await queryTunaNowPlaying(state);
    if (tuna && tuna.ok && tuna.hasSession) return tuna;
    return mac.ok ? mac : tuna.ok ? tuna : mac;
  }
  return { ok: false, error: `Unsupported platform: ${process.platform}` };
}

function formatNowPlayingForLog(np) {
  if (!np || np.ok !== true) return `error=${String((np && np.error) || "unknown")}`;
  if (!np.hasSession) return `source=${String(np.source || "unknown")} no-active-session`;
  return `source=${String(np.source || "unknown")} title="${String(np.title || "")}" artist="${String(np.artist || "")}" app="${String(np.appId || "")}" status="${String(np.playbackStatus || "")}"`;
}

function setupConsoleControls(state, options = {}) {
  if (options.hidden) return;
  if (!process.stdin || !process.stdin.isTTY) return;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "bridge> "
  });

  const printHelp = () => {
    console.log("[BetterFluxer Bridge] Console commands: help, probe, last, watch on, watch off, watch status, rpc status, tuna path");
  };

  const runProbe = async () => {
    const nowPlaying = await queryUniversalNowPlaying(state);
    state.lastNowPlaying = nowPlaying;
    state.lastNowPlayingAt = Date.now();
    console.log(`[BetterFluxer Bridge] Probe: ${formatNowPlayingForLog(nowPlaying)}`);
  };

  const setWatch = (enabled) => {
    state.watchEnabled = Boolean(enabled);
    if (state.watchTimer) {
      clearInterval(state.watchTimer);
      state.watchTimer = null;
    }
    if (state.watchEnabled) {
      state.watchTimer = setInterval(async () => {
        try {
          const np = await queryUniversalNowPlaying(state);
          state.lastNowPlaying = np;
          state.lastNowPlayingAt = Date.now();
          console.log(`[BetterFluxer Bridge] Watch: ${formatNowPlayingForLog(np)}`);
        } catch (error) {
          console.warn("[BetterFluxer Bridge] Watch error:", String((error && error.message) || error || "unknown"));
        }
      }, 4000);
    }
    console.log(`[BetterFluxer Bridge] Watch ${state.watchEnabled ? "enabled" : "disabled"}`);
  };

  printHelp();
  rl.prompt();
  rl.on("line", async (line) => {
    const cmd = String(line || "").trim().toLowerCase();
    if (!cmd || cmd === "help") {
      printHelp();
    } else if (cmd === "probe") {
      await runProbe();
    } else if (cmd === "last") {
      if (!state.lastNowPlaying) {
        console.log("[BetterFluxer Bridge] Last: none");
      } else {
        console.log(`[BetterFluxer Bridge] Last: ${formatNowPlayingForLog(state.lastNowPlaying)} at ${new Date(state.lastNowPlayingAt).toISOString()}`);
      }
    } else if (cmd === "watch on") {
      setWatch(true);
    } else if (cmd === "watch off") {
      setWatch(false);
    } else if (cmd === "watch status") {
      console.log(`[BetterFluxer Bridge] Watch ${state.watchEnabled ? "on" : "off"}`);
    } else if (cmd === "rpc status") {
      const recentRpc = Boolean(state.lastRpcActivity && Date.now() - Number(state.lastRpcActivityAt || 0) < 180000);
      console.log(
        `[BetterFluxer Bridge] RPC pipes=${(state.rpcServers || []).length} bindErrors=${(state.rpcBindErrors || []).length} recentActivity=${recentRpc}`
      );
      if ((state.rpcBindErrors || []).length) {
        for (const item of state.rpcBindErrors.slice(0, 10)) {
          console.log(`  - ${item.pipe}: ${item.error}`);
        }
      }
    } else if (cmd === "tuna path") {
      console.log(`[BetterFluxer Bridge] Tuna JSON path: ${state.tunaPath}`);
    } else {
      console.log(`[BetterFluxer Bridge] Unknown command: ${cmd}`);
      printHelp();
    }
    rl.prompt();
  });
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args["startup-install"]) {
    process.exit(installWindowsStartup());
    return;
  }
  if (args["startup-remove"]) {
    process.exit(removeWindowsStartup());
    return;
  }

  const token = readOrCreateToken();
  const allowlist = parseAllowlist();
  const cache = loadCache();
  const bridgeState = {
    watchEnabled: false,
    watchTimer: null,
    lastNowPlaying: null,
    lastNowPlayingAt: 0,
    lastRpcActivity: null,
    lastRpcActivityAt: 0,
    rpcServers: [],
    rpcBindErrors: [],
    lastTuna: null,
    lastTunaAt: 0,
    tunaPath: getTunaJsonPath()
  };
  startDiscordRpcCapture(bridgeState);

  const server = http.createServer(async (req, res) => {
    const origin = String(req.headers.origin || "");

    if (req.method === "OPTIONS") {
      return sendJson(res, 204, { ok: true }, origin || "*");
    }

    const remoteAddress = String(req.socket.remoteAddress || "");
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) {
      return sendJson(res, 403, { ok: false, error: "Localhost only" }, origin || "*");
    }

    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (url.pathname === "/health") {
      return sendJson(
        res,
        200,
        {
          ok: true,
          service: "BetterFluxer Local Bridge",
          version: BRIDGE_VERSION,
          port: PORT,
          rpcPipesListening: (bridgeState.rpcServers || []).length,
          rpcPipeErrors: (bridgeState.rpcBindErrors || []).length,
          tunaPath: bridgeState.tunaPath,
          allowlist,
          uptimeSec: Math.floor(process.uptime())
        },
        origin || "*"
      );
    }

    if (url.pathname === "/windows/media" || url.pathname === "/windows/media/now-playing") {
      const authHeader = String(req.headers.authorization || "");
      const headerToken = String(req.headers["x-betterfluxer-token"] || "").trim();
      const queryToken = String(url.searchParams.get("token") || "").trim();
      const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
      const suppliedToken = headerToken || bearer || queryToken;
      if (!suppliedToken || suppliedToken !== token) {
        return sendJson(res, 401, { ok: false, error: "Invalid token" }, origin || "*");
      }
      const media = await queryWindowsMedia();
      bridgeState.lastNowPlaying = media;
      bridgeState.lastNowPlayingAt = Date.now();
      try {
        if (media && media.ok && media.hasSession) {
          console.log(
            `[BetterFluxer Bridge] Windows media: title="${String(media.title || "")}" artist="${String(media.artist || "")}" appId="${String(media.appId || "")}" status="${String(media.playbackStatus || "")}"`
          );
        } else if (media && media.ok) {
          console.log("[BetterFluxer Bridge] Windows media: no active session");
        } else {
          console.warn("[BetterFluxer Bridge] Windows media query failed:", String((media && media.error) || "unknown"));
        }
      } catch (_) {}
      return sendJson(res, media && media.ok ? 200 : 502, media, origin || "*");
    }

    if (url.pathname === "/now-playing" || url.pathname === "/nowplaying") {
      const authHeader = String(req.headers.authorization || "");
      const headerToken = String(req.headers["x-betterfluxer-token"] || "").trim();
      const queryToken = String(url.searchParams.get("token") || "").trim();
      const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
      const suppliedToken = headerToken || bearer || queryToken;
      if (!suppliedToken || suppliedToken !== token) {
        return sendJson(res, 401, { ok: false, error: "Invalid token" }, origin || "*");
      }
      const nowPlaying = await queryUniversalNowPlaying(bridgeState);
      bridgeState.lastNowPlaying = nowPlaying;
      bridgeState.lastNowPlayingAt = Date.now();
      console.log(`[BetterFluxer Bridge] /now-playing -> ${formatNowPlayingForLog(nowPlaying)}`);
      return sendJson(res, nowPlaying && nowPlaying.ok ? 200 : 502, nowPlaying, origin || "*");
    }

    if (url.pathname !== "/fetch") {
      return sendJson(res, 404, { ok: false, error: "Not found" }, origin || "*");
    }

    const authHeader = String(req.headers.authorization || "");
    const headerToken = String(req.headers["x-betterfluxer-token"] || "").trim();
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const suppliedToken = headerToken || bearer;
    if (!suppliedToken || suppliedToken !== token) {
      return sendJson(res, 401, { ok: false, error: "Invalid token" }, origin || "*");
    }

    const body = req.method === "POST" ? await readJsonBody(req) : null;
    const targetUrl = String(url.searchParams.get("url") || (body && body.url) || "").trim();
    const responseType = String(url.searchParams.get("type") || (body && body.type) || "json").toLowerCase();
    const ttlSeconds = normalizeTtlSeconds(url.searchParams.get("ttl") || (body && body.ttl));

    if (!targetUrl) {
      return sendJson(res, 400, { ok: false, error: "Missing url" }, origin || "*");
    }
    if (!isAllowedUrl(targetUrl, allowlist)) {
      return sendJson(res, 403, { ok: false, error: "URL is not allowlisted" }, origin || "*");
    }
    if (responseType !== "json" && responseType !== "text") {
      return sendJson(res, 400, { ok: false, error: "type must be json or text" }, origin || "*");
    }

    const cacheKey = `${responseType}|${targetUrl}`;
    const cached = cache[cacheKey];
    const current = nowMs();
    if (cached && Number(cached.expiresAt || 0) > current) {
      return sendJson(
        res,
        200,
        { ok: true, cached: true, status: cached.status, data: cached.data, fetchedAt: cached.fetchedAt },
        origin || "*"
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const upstream = await fetch(targetUrl, {
        method: "GET",
        headers: { Accept: responseType === "json" ? "application/json" : "text/plain,*/*" },
        signal: controller.signal
      });
      const status = Number(upstream.status || 0);
      const text = await upstream.text();
      let data = text;
      if (responseType === "json") {
        try {
          data = text ? JSON.parse(text) : null;
        } catch (_) {
          return sendJson(res, 502, { ok: false, error: "Upstream JSON parse failed", status, text }, origin || "*");
        }
      }

      const payload = { ok: upstream.ok, cached: false, status, data, fetchedAt: new Date().toISOString() };
      cache[cacheKey] = {
        status,
        data,
        fetchedAt: payload.fetchedAt,
        expiresAt: nowMs() + ttlSeconds * 1000
      };
      saveCache(cache);
      return sendJson(res, upstream.ok ? 200 : 502, payload, origin || "*");
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: String(error && error.message ? error.message : error) }, origin || "*");
    } finally {
      clearTimeout(timeout);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[BetterFluxer Bridge] Listening on http://${HOST}:${PORT}`);
    console.log(`[BetterFluxer Bridge] Version: ${BRIDGE_VERSION}`);
    console.log(`[BetterFluxer Bridge] Token: ${token}`);
    console.log(`[BetterFluxer Bridge] Token file: ${TOKEN_FILE}`);
    console.log(`[BetterFluxer Bridge] Home dir: ${BRIDGE_BASE_DIR}`);
    console.log(`[BetterFluxer Bridge] Allowlist: ${allowlist.join(", ")}`);
    setupConsoleControls(bridgeState, { hidden: Boolean(args.hidden) });
  });
}

main().catch((error) => {
  console.error("[BetterFluxer Bridge] Failed:", error && error.message ? error.message : error);
  process.exit(1);
});
