#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const readline = require("readline");
const { WebSocket } = require("undici");

const ROOT = path.resolve(__dirname, "..");
const APP_NAME = "BetterFluxer";

function loadDotEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = String(fs.readFileSync(filePath, "utf8") || "");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = String(line || "").trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || process.env[key] != null) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (_) {}
}

function loadBridgeEnv() {
  loadDotEnvFile(path.join(ROOT, ".env"));
  loadDotEnvFile(path.join(ROOT, "bridge", ".env"));
}

loadBridgeEnv();

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
const CUSTOM_APPS_FILE = path.join(DATA_DIR, "custom-apps.json");

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.BF_BRIDGE_PORT || "21864", 10);
const BRIDGE_VERSION = "2026-03-07-p2p-v1";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.BF_BRIDGE_TIMEOUT_MS || "12000", 10);
const DEFAULT_TTL_SECONDS = Number.parseInt(process.env.BF_BRIDGE_DEFAULT_TTL || "120", 10);
const MAX_TTL_SECONDS = Number.parseInt(process.env.BF_BRIDGE_MAX_TTL || "1800", 10);
const STARTUP_VBS_NAME = "BetterFluxerBridge.vbs";
const P2P_NODE_ID_FILE = path.join(DATA_DIR, "p2p-node-id.txt");

const DEFAULT_ALLOWLIST = [
  "raw.githubusercontent.com",
  "api.github.com",
  "githubusercontent.com",
  "web.fluxer.app",
  "*.fluxer.app",
  "*.fluxer.media"
];

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

function getMasterRelayConfig() {
  const url = String(process.env.BF_MASTER_WS_URL || "").trim();
  const token = String(process.env.BF_MASTER_WS_TOKEN || "").trim();
  const userId = String(process.env.BF_MASTER_USER_ID || process.env.BF_USER_ID || "").trim();
  const enabled = Boolean(url);
  return { enabled, url, token, userId };
}

function parseHostPort(value, defaultPort) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  if (idx <= 0) return null;
  const host = raw.slice(0, idx).trim();
  const portRaw = raw.slice(idx + 1).trim();
  const port = Number.parseInt(portRaw || String(defaultPort || ""), 10);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

function getP2PConfig() {
  const enabledRaw = String(process.env.BF_P2P_ENABLED || "").trim().toLowerCase();
  const enabled = enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "yes" || enabledRaw === "on";
  const host = String(process.env.BF_P2P_HOST || "0.0.0.0").trim();
  const port = Number.parseInt(String(process.env.BF_P2P_PORT || "21911"), 10);
  const announceHost = String(process.env.BF_P2P_ANNOUNCE_HOST || "").trim();
  const peers = String(process.env.BF_P2P_PEERS || "")
    .split(",")
    .map((v) => parseHostPort(v, port))
    .filter(Boolean);
  const userId = String(process.env.BF_MASTER_USER_ID || process.env.BF_USER_ID || "").trim();
  const gossipTtlSec = Math.max(5, Math.min(300, Number.parseInt(String(process.env.BF_P2P_GOSSIP_TTL_SEC || "30"), 10) || 30));
  return {
    enabled,
    host: host || "0.0.0.0",
    port: Number.isFinite(port) && port > 0 ? port : 21911,
    announceHost,
    peers,
    userId,
    gossipTtlSec
  };
}

function parseMultiaddrsCsv(value) {
  return String(value || "")
    .split(",")
    .map((v) => String(v || "").trim())
    .filter(Boolean);
}

function getLibp2pConfig() {
  const enabledRaw = String(process.env.BF_LIBP2P_ENABLED || "").trim().toLowerCase();
  const enabled = enabledRaw === "1" || enabledRaw === "true" || enabledRaw === "yes" || enabledRaw === "on";
  const tcpHost = String(process.env.BF_LIBP2P_HOST || "0.0.0.0").trim();
  const tcpPort = Number.parseInt(String(process.env.BF_LIBP2P_PORT || "21921"), 10);
  const bootstrap = parseMultiaddrsCsv(process.env.BF_LIBP2P_BOOTSTRAP || "");
  const relays = parseMultiaddrsCsv(process.env.BF_LIBP2P_RELAYS || "");
  const topic = String(process.env.BF_LIBP2P_TOPIC || "betterfluxer/activity/1").trim();
  const userId = String(process.env.BF_MASTER_USER_ID || process.env.BF_USER_ID || "").trim();
  return {
    enabled,
    host: tcpHost || "0.0.0.0",
    port: Number.isFinite(tcpPort) && tcpPort > 0 ? tcpPort : 21921,
    bootstrap,
    relays,
    topic: topic || "betterfluxer/activity/1",
    userId
  };
}

function readOrCreateP2PNodeId() {
  ensureDataDir();
  if (fs.existsSync(P2P_NODE_ID_FILE)) {
    const existing = String(fs.readFileSync(P2P_NODE_ID_FILE, "utf8") || "").trim();
    if (existing) return existing;
  }
  const generated = crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(P2P_NODE_ID_FILE, `${generated}\n`, "utf8");
  return generated;
}

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

function loadCustomApps() {
  ensureDataDir();
  if (!fs.existsSync(CUSTOM_APPS_FILE)) return [];
  try {
    const raw = fs.readFileSync(CUSTOM_APPS_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
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

function parseMasterMessageJson(rawData) {
  try {
    if (typeof rawData === "string") return JSON.parse(rawData);
    if (rawData == null) return null;
    if (Buffer.isBuffer(rawData)) return JSON.parse(rawData.toString("utf8"));
    if (rawData instanceof ArrayBuffer) return JSON.parse(Buffer.from(rawData).toString("utf8"));
    if (ArrayBuffer.isView(rawData)) {
      return JSON.parse(Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength).toString("utf8"));
    }
    return null;
  } catch (_) {
    return null;
  }
}

function extractMasterRelayNowPlaying(msg, relayConfig) {
  const m = msg && typeof msg === "object" ? msg : null;
  if (!m) return null;

  const userId = String(m.userId || m.user_id || (m.payload && m.payload.userId) || "").trim();
  if (relayConfig && relayConfig.userId && userId && userId !== relayConfig.userId) return null;

  const type = String(m.type || m.event || m.action || "").toLowerCase();
  if (type === "now_playing_clear" || type === "activity_clear") {
    return { clear: true, userId };
  }

  const cmd = String(m.cmd || "").toUpperCase();
  if (cmd === "CLEAR_ACTIVITY") {
    return { clear: true, userId };
  }

  let payload = null;
  if (cmd === "SET_ACTIVITY") {
    const args = m.args && typeof m.args === "object" ? m.args : {};
    const activity = args.activity && typeof args.activity === "object" ? args.activity : {};
    const details = String(activity.details || activity.name || "").trim();
    const stateText = String(activity.state || "").trim();
    const activityType = Number.isFinite(Number(activity.type)) ? Number(activity.type) : null;
    const kind = activityType === 0 ? "game" : "media";
    const timestamps = activity.timestamps && typeof activity.timestamps === "object" ? activity.timestamps : null;
    const startMs = timestamps && Number.isFinite(Number(timestamps.start)) ? Number(timestamps.start) : null;
    const endMs = timestamps && Number.isFinite(Number(timestamps.end)) ? Number(timestamps.end) : null;
    const now = Date.now();
    const positionMs = startMs != null ? Math.max(0, now - startMs) : null;
    const durationMs = startMs != null && endMs != null && endMs > startMs ? endMs - startMs : null;
    payload = normalizeNowPlayingPayload(
      {
        kind,
        activityType,
        title: [details, stateText].filter(Boolean).join(" - ") || details || stateText,
        artist: stateText,
        appId: String(activity.application_id || args.pid || ""),
        playbackStatus: "playing",
        positionMs,
        durationMs,
        name: String(activity.name || ""),
        details,
        state: stateText
      },
      "master-relay"
    );
    return { normalized: payload, raw: activity, userId };
  }

  if (m.nowPlaying && typeof m.nowPlaying === "object") payload = m.nowPlaying;
  else if (m.now_playing && typeof m.now_playing === "object") payload = m.now_playing;
  else if (m.activity && typeof m.activity === "object") payload = m.activity;
  else if (m.payload && typeof m.payload === "object") payload = m.payload;
  else if (typeof m.title === "string" || typeof m.artist === "string" || typeof m.details === "string") payload = m;

  if (!payload || typeof payload !== "object") return null;
  if (payload.clear === true) return { clear: true, userId };
  const normalized = normalizeNowPlayingPayload(payload, "master-relay");
  return { normalized, raw: payload, userId };
}

function scheduleMasterRelayReconnect(state, delayMs) {
  if (!state.masterRelayConfig || !state.masterRelayConfig.enabled) return;
  if (state.masterRelayReconnectTimer) return;
  const wait = Math.max(1000, Number(delayMs || 5000));
  state.masterRelayReconnectTimer = setTimeout(() => {
    state.masterRelayReconnectTimer = null;
    startMasterRelay(state);
  }, wait);
}

function stopMasterRelay(state) {
  if (state.masterRelayReconnectTimer) {
    clearTimeout(state.masterRelayReconnectTimer);
    state.masterRelayReconnectTimer = null;
  }
  if (state.masterRelaySocket) {
    try {
      state.masterRelaySocket.close();
    } catch (_) {}
    state.masterRelaySocket = null;
  }
  state.masterRelayConnected = false;
}

function sendMasterRelayJson(state, payload) {
  const ws = state.masterRelaySocket;
  if (!ws || ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    state.masterRelayLastError = String((error && error.message) || error || "send failed");
    return false;
  }
}

function buildMasterRelayPublishKey(np) {
  const n = np && typeof np === "object" ? np : {};
  return JSON.stringify({
    hasSession: Boolean(n.hasSession),
    kind: String(n.kind || ""),
    activityType: Number.isFinite(Number(n.activityType)) ? Number(n.activityType) : null,
    title: String(n.title || ""),
    artist: String(n.artist || ""),
    albumTitle: String(n.albumTitle || ""),
    appId: String(n.appId || ""),
    playbackStatus: String(n.playbackStatus || ""),
    name: String(n.name || ""),
    details: String(n.details || ""),
    state: String(n.state || "")
  });
}

function publishMasterRelayNowPlaying(state, nowPlaying) {
  if (!state.masterRelayConfig || !state.masterRelayConfig.enabled) return;
  if (!state.masterRelayConnected) return;
  const np = nowPlaying && typeof nowPlaying === "object" ? nowPlaying : null;
  if (!np || np.source === "master-relay") return;

  if (!np.ok || !np.hasSession) {
    if (state.masterRelayLastSentKey === "__clear__") return;
    const sent = sendMasterRelayJson(state, {
      type: "now_playing_clear",
      source: "betterfluxer-bridge",
      userId: state.masterRelayConfig.userId || null,
      ts: Date.now()
    });
    if (sent) {
      state.masterRelayLastSentKey = "__clear__";
      state.masterRelayLastSentAt = Date.now();
    }
    return;
  }

  const key = buildMasterRelayPublishKey(np);
  if (key === state.masterRelayLastSentKey) return;
  const sent = sendMasterRelayJson(state, {
    type: "now_playing",
    source: "betterfluxer-bridge",
    userId: state.masterRelayConfig.userId || null,
    ts: Date.now(),
    nowPlaying: {
      kind: np.kind || "media",
      activityType: Number.isFinite(Number(np.activityType)) ? Number(np.activityType) : null,
      title: String(np.title || ""),
      artist: String(np.artist || ""),
      albumTitle: String(np.albumTitle || ""),
      appId: String(np.appId || ""),
      playbackStatus: String(np.playbackStatus || ""),
      positionMs: Number.isFinite(Number(np.positionMs)) ? Number(np.positionMs) : null,
      durationMs: Number.isFinite(Number(np.durationMs)) ? Number(np.durationMs) : null,
      name: String(np.name || ""),
      details: String(np.details || ""),
      state: String(np.state || "")
    }
  });
  if (sent) {
    state.masterRelayLastSentKey = key;
    state.masterRelayLastSentAt = Date.now();
  }
}

function startMasterRelay(state) {
  const cfg = state.masterRelayConfig || getMasterRelayConfig();
  state.masterRelayConfig = cfg;
  if (!cfg.enabled) return;
  if (state.masterRelaySocket && state.masterRelaySocket.readyState === 1) return;

  let ws;
  try {
    ws = new WebSocket(cfg.url);
  } catch (error) {
    state.masterRelayLastError = String((error && error.message) || error || "connect failed");
    scheduleMasterRelayReconnect(state, 8000);
    return;
  }

  state.masterRelaySocket = ws;

  ws.addEventListener("open", () => {
    state.masterRelayConnected = true;
    state.masterRelayConnectedAt = Date.now();
    state.masterRelayLastError = "";
    sendMasterRelayJson(state, {
      type: "hello",
      role: "betterfluxer-bridge",
      version: BRIDGE_VERSION,
      userId: cfg.userId || null,
      token: cfg.token || null,
      platform: process.platform,
      host: os.hostname(),
      port: PORT
    });
    console.log(`[BetterFluxer Bridge] Master relay connected: ${cfg.url}`);
  });

  ws.addEventListener("message", (event) => {
    const parsed = parseMasterMessageJson(event && event.data);
    if (!parsed) return;
    state.masterRelayLastMessageAt = Date.now();
    const extracted = extractMasterRelayNowPlaying(parsed, cfg);
    if (!extracted) return;
    if (extracted.clear) {
      state.lastMasterActivity = null;
      state.lastMasterActivityAt = Date.now();
      return;
    }
    state.lastMasterActivity = {
      raw: extracted.raw && typeof extracted.raw === "object" ? extracted.raw : {},
      normalized: extracted.normalized && typeof extracted.normalized === "object" ? extracted.normalized : null,
      userId: extracted.userId || ""
    };
    state.lastMasterActivityAt = Date.now();
  });

  ws.addEventListener("error", (error) => {
    state.masterRelayLastError = String((error && error.message) || error || "master relay error");
  });

  ws.addEventListener("close", () => {
    state.masterRelayConnected = false;
    if (state.masterRelaySocket === ws) state.masterRelaySocket = null;
    scheduleMasterRelayReconnect(state, 5000);
  });
}

function p2pPeerKey(host, port) {
  return `${String(host || "").trim()}:${Number(port || 0)}`;
}

function pruneP2PTrafficSamples(state, nowMsValue) {
  const now = Number(nowMsValue || Date.now());
  const maxAgeMs = 60 * 1000;
  const inSamples = state.p2pInSamples || [];
  const outSamples = state.p2pOutSamples || [];
  state.p2pInSamples = inSamples.filter((x) => now - Number((x && x.ts) || 0) <= maxAgeMs);
  state.p2pOutSamples = outSamples.filter((x) => now - Number((x && x.ts) || 0) <= maxAgeMs);
}

function recordP2PTraffic(state, direction, bytes, peerKey) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return;
  const now = Date.now();
  if (direction === "in") {
    state.p2pBytesReceived = Number(state.p2pBytesReceived || 0) + n;
    if (!state.p2pInSamples) state.p2pInSamples = [];
    state.p2pInSamples.push({ ts: now, bytes: n });
  } else if (direction === "out") {
    state.p2pBytesSent = Number(state.p2pBytesSent || 0) + n;
    if (!state.p2pOutSamples) state.p2pOutSamples = [];
    state.p2pOutSamples.push({ ts: now, bytes: n });
  }
  if (peerKey && state.p2pPeerSockets && state.p2pPeerSockets.has(peerKey)) {
    const peer = state.p2pPeerSockets.get(peerKey);
    if (peer) {
      if (direction === "in") peer.bytesIn = Number(peer.bytesIn || 0) + n;
      if (direction === "out") peer.bytesOut = Number(peer.bytesOut || 0) + n;
    }
  }
  pruneP2PTrafficSamples(state, now);
}

function getP2PBandwidthStats(state) {
  const now = Date.now();
  pruneP2PTrafficSamples(state, now);
  const inSamples = state.p2pInSamples || [];
  const outSamples = state.p2pOutSamples || [];
  const inBytes1m = inSamples.reduce((acc, x) => acc + Number((x && x.bytes) || 0), 0);
  const outBytes1m = outSamples.reduce((acc, x) => acc + Number((x && x.bytes) || 0), 0);
  return {
    inBytes1m,
    outBytes1m,
    inBps1m: Math.round(inBytes1m / 60),
    outBps1m: Math.round(outBytes1m / 60),
    totalBytesIn: Number(state.p2pBytesReceived || 0),
    totalBytesOut: Number(state.p2pBytesSent || 0)
  };
}

function normalizeP2PNowPlayingMessage(payload, state) {
  const p = payload && typeof payload === "object" ? payload : {};
  const userId = String(p.userId || p.user_id || "").trim();
  const config = state.p2pConfig || {};
  if (config.userId && userId && userId !== config.userId) return null;
  const nowPlaying = p.nowPlaying && typeof p.nowPlaying === "object" ? p.nowPlaying : {};
  const normalized = normalizeNowPlayingPayload(nowPlaying, "p2p-gossip");
  return {
    normalized,
    raw: nowPlaying,
    userId
  };
}

function cleanupP2PSeen(state) {
  const now = Date.now();
  const seen = state.p2pSeenIds;
  if (!seen) return;
  for (const [mid, expiresAt] of seen.entries()) {
    if (Number(expiresAt || 0) <= now) seen.delete(mid);
  }
}

function markP2PSeen(state, mid, ttlSec) {
  if (!state.p2pSeenIds) state.p2pSeenIds = new Map();
  const ttlMs = Math.max(1000, (Number(ttlSec || 30) || 30) * 1000);
  state.p2pSeenIds.set(String(mid || ""), Date.now() + ttlMs);
  if (state.p2pSeenIds.size > 5000) cleanupP2PSeen(state);
}

function hasP2PSeen(state, mid) {
  if (!mid || !state.p2pSeenIds) return false;
  const expiresAt = Number(state.p2pSeenIds.get(String(mid)) || 0);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    state.p2pSeenIds.delete(String(mid));
    return false;
  }
  return true;
}

function writeP2PLine(state, socket, obj, peerKey) {
  if (!socket || socket.destroyed) return false;
  try {
    const line = `${JSON.stringify(obj)}\n`;
    socket.write(line);
    recordP2PTraffic(state, "out", Buffer.byteLength(line, "utf8"), peerKey);
    return true;
  } catch (_) {
    return false;
  }
}

function broadcastP2PMessage(state, message, excludeKey) {
  const peers = state.p2pPeerSockets || new Map();
  let sent = 0;
  for (const [key, peer] of peers.entries()) {
    if (!peer || !peer.socket || peer.socket.destroyed) continue;
    if (excludeKey && key === excludeKey) continue;
    if (writeP2PLine(state, peer.socket, message, key)) sent += 1;
  }
  state.p2pSentCount = Number(state.p2pSentCount || 0) + sent;
  return sent;
}

function handleP2PInboundMessage(state, message, fromPeerKey) {
  const msg = message && typeof message === "object" ? message : null;
  if (!msg) return;
  const kind = String(msg.type || "").toLowerCase();
  const mid = String(msg.mid || "").trim();
  if (!mid) return;
  if (hasP2PSeen(state, mid)) return;
  markP2PSeen(state, mid, msg.ttlSec || (state.p2pConfig && state.p2pConfig.gossipTtlSec) || 30);
  state.p2pReceivedCount = Number(state.p2pReceivedCount || 0) + 1;
  state.p2pLastMessageAt = Date.now();

  if (kind === "now_playing_clear") {
    const userId = String(msg.userId || "").trim();
    const cfgUser = String((state.p2pConfig && state.p2pConfig.userId) || "");
    if (!cfgUser || !userId || cfgUser === userId) {
      state.lastP2PActivity = null;
      state.lastP2PActivityAt = Date.now();
    }
  } else if (kind === "now_playing") {
    const extracted = normalizeP2PNowPlayingMessage(msg, state);
    if (extracted && extracted.normalized) {
      state.lastP2PActivity = extracted;
      state.lastP2PActivityAt = Date.now();
    }
  }

  const hops = Number.isFinite(Number(msg.hops)) ? Number(msg.hops) : 0;
  if (hops >= 4) return;
  const relay = { ...msg, hops: hops + 1 };
  broadcastP2PMessage(state, relay, fromPeerKey);
}

function attachP2PSocket(state, socket, peerHost, peerPort, outbound) {
  const key = p2pPeerKey(peerHost, peerPort);
  if (!state.p2pPeerSockets) state.p2pPeerSockets = new Map();

  const existing = state.p2pPeerSockets.get(key);
  if (existing && existing.socket && !existing.socket.destroyed) {
    try {
      socket.destroy();
    } catch (_) {}
    return;
  }

  const peer = {
    key,
    host: peerHost,
    port: peerPort,
    outbound: Boolean(outbound),
    socket,
    connectedAt: Date.now(),
    bytesIn: 0,
    bytesOut: 0
  };
  state.p2pPeerSockets.set(key, peer);
  state.p2pConnectedPeers = state.p2pPeerSockets.size;

  const hello = {
    type: "hello",
    nodeId: state.p2pNodeId,
    listen: {
      host: (state.p2pConfig && state.p2pConfig.announceHost) || "",
      port: (state.p2pConfig && state.p2pConfig.port) || 0
    },
    ts: Date.now()
  };
  writeP2PLine(state, socket, hello, key);

  let buffer = "";
  socket.on("data", (chunk) => {
    const bytes = Number((chunk && chunk.length) || 0);
    if (bytes > 0) recordP2PTraffic(state, "in", bytes, key);
    buffer += String(chunk || "");
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try {
          const msg = JSON.parse(line);
          if (msg && msg.type === "hello") {
            const listen = msg.listen && typeof msg.listen === "object" ? msg.listen : {};
            const announcedHost = String(listen.host || "").trim();
            const announcedPort = Number.parseInt(String(listen.port || ""), 10);
            if (announcedHost && Number.isFinite(announcedPort) && announcedPort > 0) {
              const announcedKey = p2pPeerKey(announcedHost, announcedPort);
              if (!state.p2pKnownPeers.has(announcedKey) && announcedHost !== "0.0.0.0") {
                state.p2pKnownPeers.set(announcedKey, { host: announcedHost, port: announcedPort, lastSeenAt: Date.now() });
              }
            }
          } else {
            handleP2PInboundMessage(state, msg, key);
          }
        } catch (_) {}
      }
      idx = buffer.indexOf("\n");
    }
  });

  const onEnd = () => {
    const current = state.p2pPeerSockets.get(key);
    if (current && current.socket === socket) state.p2pPeerSockets.delete(key);
    state.p2pConnectedPeers = state.p2pPeerSockets.size;
  };
  socket.on("error", (error) => {
    state.p2pLastError = String((error && error.message) || error || "socket error");
  });
  socket.on("close", onEnd);
  socket.on("end", onEnd);
}

function connectP2PPeer(state, host, port) {
  const key = p2pPeerKey(host, port);
  if (!state.p2pKnownPeers) state.p2pKnownPeers = new Map();
  state.p2pKnownPeers.set(key, { host, port, lastSeenAt: Date.now() });

  const active = state.p2pPeerSockets && state.p2pPeerSockets.get(key);
  if (active && active.socket && !active.socket.destroyed) return;

  const pending = state.p2pPendingConnect || new Set();
  state.p2pPendingConnect = pending;
  if (pending.has(key)) return;
  pending.add(key);

  try {
    const socket = net.createConnection({ host, port }, () => {
      pending.delete(key);
      attachP2PSocket(state, socket, host, port, true);
    });
    socket.setNoDelay(true);
    socket.setTimeout(10000, () => {
      try {
        socket.destroy();
      } catch (_) {}
    });
    socket.on("error", () => {
      pending.delete(key);
    });
    socket.on("close", () => {
      pending.delete(key);
    });
  } catch (error) {
    pending.delete(key);
    state.p2pLastError = String((error && error.message) || error || "connect failed");
  }
}

function startP2PBridge(state) {
  const cfg = state.p2pConfig || getP2PConfig();
  state.p2pConfig = cfg;
  if (!cfg.enabled) return;
  if (state.p2pStarted) return;
  state.p2pStarted = true;
  state.p2pNodeId = readOrCreateP2PNodeId();
  if (!state.p2pKnownPeers) state.p2pKnownPeers = new Map();
  if (!state.p2pPeerSockets) state.p2pPeerSockets = new Map();
  if (!state.p2pSeenIds) state.p2pSeenIds = new Map();

  for (const peer of cfg.peers || []) {
    const key = p2pPeerKey(peer.host, peer.port);
    state.p2pKnownPeers.set(key, { host: peer.host, port: peer.port, lastSeenAt: 0 });
  }

  state.p2pServer = net.createServer((socket) => {
    const host = String(socket.remoteAddress || "").replace(/^::ffff:/, "");
    const port = Number(socket.remotePort || 0);
    if (!host || !port) {
      try {
        socket.destroy();
      } catch (_) {}
      return;
    }
    attachP2PSocket(state, socket, host, port, false);
  });

  state.p2pServer.on("error", (error) => {
    state.p2pLastError = String((error && error.message) || error || "p2p server error");
  });
  state.p2pServer.listen(cfg.port, cfg.host, () => {
    const addr = state.p2pServer.address();
    const host = typeof addr === "object" && addr ? addr.address : cfg.host;
    const port = typeof addr === "object" && addr ? addr.port : cfg.port;
    console.log(`[BetterFluxer Bridge] P2P listening on ${host}:${port} (nodeId=${state.p2pNodeId})`);
  });

  state.p2pBootstrapTimer = setInterval(() => {
    cleanupP2PSeen(state);
    for (const peer of Array.from(state.p2pKnownPeers.values())) {
      if (!peer || !peer.host || !peer.port) continue;
      if (peer.host === "127.0.0.1" && Number(peer.port) === Number(cfg.port)) continue;
      if (peer.host === "localhost" && Number(peer.port) === Number(cfg.port)) continue;
      connectP2PPeer(state, peer.host, peer.port);
    }
    state.p2pConnectedPeers = state.p2pPeerSockets.size;
  }, 5000);
}

function stopP2PBridge(state) {
  if (state.p2pBootstrapTimer) {
    clearInterval(state.p2pBootstrapTimer);
    state.p2pBootstrapTimer = null;
  }
  if (state.p2pPeerSockets) {
    for (const peer of state.p2pPeerSockets.values()) {
      try {
        if (peer && peer.socket) peer.socket.destroy();
      } catch (_) {}
    }
    state.p2pPeerSockets.clear();
  }
  if (state.p2pServer) {
    try {
      state.p2pServer.close();
    } catch (_) {}
    state.p2pServer = null;
  }
  state.p2pConnectedPeers = 0;
  state.p2pStarted = false;
}

function publishP2PNowPlaying(state, nowPlaying) {
  if (!state.p2pConfig || !state.p2pConfig.enabled) return;
  if (!state.p2pStarted) return;
  const np = nowPlaying && typeof nowPlaying === "object" ? nowPlaying : null;
  if (!np || np.source === "p2p-gossip") return;

  let msg;
  if (!np.ok || !np.hasSession) {
    msg = {
      type: "now_playing_clear",
      mid: `bfp2p-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
      nodeId: state.p2pNodeId,
      userId: (state.p2pConfig && state.p2pConfig.userId) || "",
      ttlSec: (state.p2pConfig && state.p2pConfig.gossipTtlSec) || 30,
      hops: 0,
      ts: Date.now()
    };
  } else {
    const key = buildMasterRelayPublishKey(np);
    if (key === state.p2pLastSentKey) return;
    msg = {
      type: "now_playing",
      mid: `bfp2p-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
      nodeId: state.p2pNodeId,
      userId: (state.p2pConfig && state.p2pConfig.userId) || "",
      ttlSec: (state.p2pConfig && state.p2pConfig.gossipTtlSec) || 30,
      hops: 0,
      ts: Date.now(),
      nowPlaying: {
        kind: np.kind || "media",
        activityType: Number.isFinite(Number(np.activityType)) ? Number(np.activityType) : null,
        title: String(np.title || ""),
        artist: String(np.artist || ""),
        albumTitle: String(np.albumTitle || ""),
        appId: String(np.appId || ""),
        playbackStatus: String(np.playbackStatus || ""),
        positionMs: Number.isFinite(Number(np.positionMs)) ? Number(np.positionMs) : null,
        durationMs: Number.isFinite(Number(np.durationMs)) ? Number(np.durationMs) : null,
        name: String(np.name || ""),
        details: String(np.details || ""),
        state: String(np.state || "")
      }
    };
    state.p2pLastSentKey = key;
  }

  markP2PSeen(state, msg.mid, msg.ttlSec);
  const sent = broadcastP2PMessage(state, msg, null);
  if (sent > 0) state.p2pLastSentAt = Date.now();
}

async function startLibp2pBridge(state) {
  const cfg = state.libp2pConfig || getLibp2pConfig();
  state.libp2pConfig = cfg;
  if (!cfg.enabled) return;
  if (state.libp2pStarted) return;

  try {
    const [{ createLibp2p }, { tcp }, { noise }, { mplex }, { bootstrap }, { identify }, { gossipsub }] =
      await Promise.all([
        import("libp2p"),
        import("@libp2p/tcp"),
        import("@chainsafe/libp2p-noise"),
        import("@libp2p/mplex"),
        import("@libp2p/bootstrap"),
        import("@libp2p/identify"),
        import("@chainsafe/libp2p-gossipsub")
      ]);

    const peerDiscovery = [];
    const bootstrapList = [...cfg.bootstrap, ...cfg.relays].filter(Boolean);
    if (bootstrapList.length) {
      peerDiscovery.push(
        bootstrap({
          list: bootstrapList,
          interval: 30e3
        })
      );
    }

    const node = await createLibp2p({
      addresses: {
        listen: [`/ip4/${cfg.host}/tcp/${cfg.port}`]
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [mplex()],
      peerDiscovery,
      services: {
        identify: identify(),
        pubsub: gossipsub({
          allowPublishToZeroPeers: true
        })
      }
    });

    state.libp2pNode = node;
    state.libp2pStarted = true;
    state.libp2pNodeId = String(node.peerId && node.peerId.toString ? node.peerId.toString() : "");
    state.libp2pLastError = "";

    node.addEventListener("peer:connect", () => {
      state.libp2pPeerCount = Number((node.getConnections && node.getConnections().length) || 0);
    });
    node.addEventListener("peer:disconnect", () => {
      state.libp2pPeerCount = Number((node.getConnections && node.getConnections().length) || 0);
    });

    const pubsub = node.services && node.services.pubsub ? node.services.pubsub : null;
    if (!pubsub) throw new Error("libp2p pubsub service unavailable");

    state.libp2pTopicHandler = (evt) => {
      try {
        const data = evt && evt.detail && evt.detail.data ? evt.detail.data : null;
        if (!data) return;
        const parsed = parseMasterMessageJson(Buffer.from(data));
        if (!parsed || typeof parsed !== "object") return;
        const type = String(parsed.type || "").toLowerCase();
        const userId = String(parsed.userId || "").trim();
        if (cfg.userId && userId && userId !== cfg.userId) return;
        state.libp2pMessagesReceived = Number(state.libp2pMessagesReceived || 0) + 1;
        state.libp2pLastMessageAt = Date.now();
        const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
        state.libp2pBytesReceived = Number(state.libp2pBytesReceived || 0) + bytes;

        if (type === "now_playing_clear") {
          state.lastLibp2pActivity = null;
          state.lastLibp2pActivityAt = Date.now();
          return;
        }
        if (type === "now_playing" && parsed.nowPlaying && typeof parsed.nowPlaying === "object") {
          const normalized = normalizeNowPlayingPayload(parsed.nowPlaying, "libp2p-gossip");
          state.lastLibp2pActivity = {
            normalized,
            raw: parsed.nowPlaying,
            userId
          };
          state.lastLibp2pActivityAt = Date.now();
        }
      } catch (_) {}
    };

    pubsub.addEventListener("message", state.libp2pTopicHandler);
    await pubsub.subscribe(cfg.topic);
    state.libp2pSubscribed = true;
    state.libp2pPeerCount = Number((node.getConnections && node.getConnections().length) || 0);
    console.log(`[BetterFluxer Bridge] libp2p started nodeId=${state.libp2pNodeId} topic=${cfg.topic}`);
  } catch (error) {
    state.libp2pStarted = false;
    state.libp2pLastError =
      String((error && error.message) || error || "libp2p start failed") +
      " (install deps: libp2p @libp2p/tcp @chainsafe/libp2p-noise @libp2p/mplex @libp2p/bootstrap @libp2p/identify @chainsafe/libp2p-gossipsub)";
    console.warn(`[BetterFluxer Bridge] libp2p disabled: ${state.libp2pLastError}`);
  }
}

async function stopLibp2pBridge(state) {
  try {
    if (state.libp2pNode && state.libp2pSubscribed) {
      const pubsub = state.libp2pNode.services && state.libp2pNode.services.pubsub ? state.libp2pNode.services.pubsub : null;
      if (pubsub && state.libp2pTopicHandler) {
        pubsub.removeEventListener("message", state.libp2pTopicHandler);
      }
      if (pubsub && state.libp2pConfig && state.libp2pConfig.topic) {
        await pubsub.unsubscribe(state.libp2pConfig.topic);
      }
    }
  } catch (_) {}
  try {
    if (state.libp2pNode) await state.libp2pNode.stop();
  } catch (_) {}
  state.libp2pNode = null;
  state.libp2pTopicHandler = null;
  state.libp2pStarted = false;
  state.libp2pSubscribed = false;
  state.libp2pPeerCount = 0;
}

async function publishLibp2pNowPlaying(state, nowPlaying) {
  if (!state.libp2pConfig || !state.libp2pConfig.enabled) return;
  if (!state.libp2pStarted || !state.libp2pNode) return;
  const np = nowPlaying && typeof nowPlaying === "object" ? nowPlaying : null;
  if (!np || np.source === "libp2p-gossip") return;
  const pubsub = state.libp2pNode.services && state.libp2pNode.services.pubsub ? state.libp2pNode.services.pubsub : null;
  if (!pubsub) return;

  let payload;
  if (!np.ok || !np.hasSession) {
    payload = {
      type: "now_playing_clear",
      userId: (state.libp2pConfig && state.libp2pConfig.userId) || "",
      ts: Date.now()
    };
  } else {
    const key = buildMasterRelayPublishKey(np);
    if (key === state.libp2pLastSentKey) return;
    payload = {
      type: "now_playing",
      userId: (state.libp2pConfig && state.libp2pConfig.userId) || "",
      ts: Date.now(),
      nowPlaying: {
        kind: np.kind || "media",
        activityType: Number.isFinite(Number(np.activityType)) ? Number(np.activityType) : null,
        title: String(np.title || ""),
        artist: String(np.artist || ""),
        albumTitle: String(np.albumTitle || ""),
        appId: String(np.appId || ""),
        playbackStatus: String(np.playbackStatus || ""),
        positionMs: Number.isFinite(Number(np.positionMs)) ? Number(np.positionMs) : null,
        durationMs: Number.isFinite(Number(np.durationMs)) ? Number(np.durationMs) : null,
        name: String(np.name || ""),
        details: String(np.details || ""),
        state: String(np.state || "")
      }
    };
    state.libp2pLastSentKey = key;
  }

  try {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8");
    await pubsub.publish(state.libp2pConfig.topic, encoded);
    state.libp2pMessagesSent = Number(state.libp2pMessagesSent || 0) + 1;
    state.libp2pBytesSent = Number(state.libp2pBytesSent || 0) + encoded.length;
    state.libp2pLastSentAt = Date.now();
  } catch (error) {
    state.libp2pLastError = String((error && error.message) || error || "libp2p publish failed");
  }
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
        if (item.depth < maxDepth) {
          stack.push({ dir: full, depth: item.depth + 1 });
        }
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (includeExts.includes(ext)) {
        out.push(full);
        if (out.length >= maxItems) break;
      }
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

function shouldIgnoreProcessName(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return true;
  const ignore = [
    "fluxer",
    "betterfluxerinjector",
    "betterfluxerbridge",
    "discord",
    "node",
    "electron",
    "chrome",
    "steam",
    "epicgameslauncher",
    "goggalaxy",
    "explorer"
  ];
  return ignore.includes(n);
}

function updateInstalledAppIndex(state) {
  const now = Date.now();
  const ttlMs = 5 * 60 * 1000;
  if (state.installedAppIndex && now - Number(state.installedAppIndexAt || 0) < ttlMs) {
    return state.installedAppIndex;
  }

  const index = {};
  for (const item of loadCustomApps()) {
    index[item.exe] = {
      name: item.name,
      path: item.path || ""
    };
  }
  if (process.platform === "win32") {
    const roots = getWindowsDriveRoots();
    const files = [];
    for (const root of roots) {
      collectFiles(root, { maxDepth: 5, includeExts: [".exe"], maxItems: 20000 }, files);
    }
    for (const filePath of files) {
      const exeName = path.basename(filePath, path.extname(filePath)).toLowerCase();
      if (!exeName || shouldIgnoreProcessName(exeName)) continue;
      const knownName = KNOWN_GAME_EXECUTABLES[exeName];
      if (!knownName) continue;
      if (!index[exeName]) {
        index[exeName] = {
          name: knownName,
          path: filePath
        };
      }
    }
  }

  state.installedAppIndex = index;
  state.installedAppIndexAt = now;
  return index;
}

async function queryInstalledRunningApp(state) {
  if (process.platform !== "win32") {
    return { ok: false, error: "Installed app process source is Windows-only" };
  }
  const index = updateInstalledAppIndex(state);
  const keys = Object.keys(index);
  if (!keys.length) {
    return { ok: false, error: "No installed app index entries" };
  }

  try {
    const result = await runCommand("tasklist", ["/FO", "CSV", "/NH"], 6000);
    if (!result || result.code !== 0) {
      return { ok: false, error: String((result && result.stderr) || "tasklist failed") };
    }
    const lines = String(result.stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const cols = line.split('","').map((v) => v.replace(/^"/, "").replace(/"$/, ""));
      const image = String(cols[0] || "").trim();
      if (!image) continue;
      const exeName = path.basename(image, path.extname(image)).toLowerCase();
      if (!exeName || shouldIgnoreProcessName(exeName)) continue;
      const hit = index[exeName];
      if (!hit) continue;
      return normalizeNowPlayingPayload(
        {
          kind: "game",
          activityType: 0,
          title: hit.name || exeName,
          appId: exeName,
          playbackStatus: "playing",
          name: hit.name || exeName,
          details: hit.name || exeName
        },
        "installed-app-process"
      );
    }
    return { ok: true, hasSession: false, source: "installed-app-process" };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error || "tasklist failed") };
  }
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

function bindDiscordRpcPipe(state, index) {
  if (process.platform !== "win32") return;
  if (!state.rpcServerMap) state.rpcServerMap = new Map();
  if (!state.rpcRetryAt) state.rpcRetryAt = {};
  if (state.rpcServerMap.has(index)) return;

  const pipeName = `\\\\.\\pipe\\discord-ipc-${index}`;
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

  const scheduleRetry = (ms) => {
    const waitMs = Number(ms || 5000);
    state.rpcRetryAt[index] = Date.now() + waitMs;
  };

  server.on("error", (error) => {
    const message = String((error && error.message) || error || "unknown");
    state.rpcBindErrors.push({ pipe: pipeName, error: message });
    state.rpcServerMap.delete(index);
    if (state.rpcBindErrors.length > 50) state.rpcBindErrors = state.rpcBindErrors.slice(-50);
    scheduleRetry(5000);
  });

  server.on("close", () => {
    state.rpcServerMap.delete(index);
    scheduleRetry(3000);
  });

  try {
    server.listen(pipeName, () => {
      state.rpcRetryAt[index] = 0;
      state.rpcServerMap.set(index, { pipe: pipeName, server });
      state.rpcServers = Array.from(state.rpcServerMap.values());
    });
  } catch (error) {
    const message = String((error && error.message) || error || "unknown");
    state.rpcBindErrors.push({ pipe: pipeName, error: message });
    if (state.rpcBindErrors.length > 50) state.rpcBindErrors = state.rpcBindErrors.slice(-50);
    scheduleRetry(5000);
  }
}

function startDiscordRpcCapture(state) {
  if (process.platform !== "win32") return;
  if (state.rpcCaptureStarted) return;
  state.rpcCaptureStarted = true;
  state.rpcServers = [];
  state.rpcBindErrors = [];
  state.rpcServerMap = new Map();
  state.rpcRetryAt = {};

  const tick = () => {
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) {
      const retryAt = Number(state.rpcRetryAt[i] || 0);
      if (retryAt > now) continue;
      bindDiscordRpcPipe(state, i);
    }
    state.rpcServers = Array.from((state.rpcServerMap || new Map()).values());
  };

  tick();
  state.rpcBindTimer = setInterval(tick, 4000);
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
  if (state && state.lastMasterActivity && now - Number(state.lastMasterActivityAt || 0) < 180000) {
    const raw = state.lastMasterActivity.raw && typeof state.lastMasterActivity.raw === "object" ? state.lastMasterActivity.raw : {};
    const base =
      state.lastMasterActivity.normalized && typeof state.lastMasterActivity.normalized === "object"
        ? { ...state.lastMasterActivity.normalized }
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

  if (state && state.lastP2PActivity && now - Number(state.lastP2PActivityAt || 0) < 180000) {
    const raw = state.lastP2PActivity.raw && typeof state.lastP2PActivity.raw === "object" ? state.lastP2PActivity.raw : {};
    const base =
      state.lastP2PActivity.normalized && typeof state.lastP2PActivity.normalized === "object"
        ? { ...state.lastP2PActivity.normalized }
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

  if (state && state.lastLibp2pActivity && now - Number(state.lastLibp2pActivityAt || 0) < 180000) {
    const raw = state.lastLibp2pActivity.raw && typeof state.lastLibp2pActivity.raw === "object" ? state.lastLibp2pActivity.raw : {};
    const base =
      state.lastLibp2pActivity.normalized && typeof state.lastLibp2pActivity.normalized === "object"
        ? { ...state.lastLibp2pActivity.normalized }
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
    const runningInstalled = await queryInstalledRunningApp(state);
    if (runningInstalled && runningInstalled.ok && runningInstalled.hasSession) {
      publishMasterRelayNowPlaying(state, runningInstalled);
      publishP2PNowPlaying(state, runningInstalled);
      await publishLibp2pNowPlaying(state, runningInstalled);
      return runningInstalled;
    }
    const tuna = await queryTunaNowPlaying(state);
    if (tuna && tuna.ok && tuna.hasSession) {
      publishMasterRelayNowPlaying(state, tuna);
      publishP2PNowPlaying(state, tuna);
      await publishLibp2pNowPlaying(state, tuna);
      return tuna;
    }
    const fallback = tuna && tuna.ok ? tuna : runningInstalled.ok ? runningInstalled : { ok: false, error: "No active RPC, installed-app, or Tuna now-playing source" };
    publishMasterRelayNowPlaying(state, fallback);
    publishP2PNowPlaying(state, fallback);
    await publishLibp2pNowPlaying(state, fallback);
    return fallback;
  }
  if (process.platform === "linux") {
    const linux = await queryLinuxMedia();
    if (linux.ok && linux.hasSession) {
      publishMasterRelayNowPlaying(state, linux);
      publishP2PNowPlaying(state, linux);
      await publishLibp2pNowPlaying(state, linux);
      return linux;
    }
    const tuna = await queryTunaNowPlaying(state);
    if (tuna && tuna.ok && tuna.hasSession) {
      publishMasterRelayNowPlaying(state, tuna);
      publishP2PNowPlaying(state, tuna);
      await publishLibp2pNowPlaying(state, tuna);
      return tuna;
    }
    const fallback = linux.ok ? linux : tuna.ok ? tuna : linux;
    publishMasterRelayNowPlaying(state, fallback);
    publishP2PNowPlaying(state, fallback);
    await publishLibp2pNowPlaying(state, fallback);
    return fallback;
  }
  if (process.platform === "darwin") {
    const mac = await queryMacMedia();
    if (mac.ok && mac.hasSession) {
      publishMasterRelayNowPlaying(state, mac);
      publishP2PNowPlaying(state, mac);
      await publishLibp2pNowPlaying(state, mac);
      return mac;
    }
    const tuna = await queryTunaNowPlaying(state);
    if (tuna && tuna.ok && tuna.hasSession) {
      publishMasterRelayNowPlaying(state, tuna);
      publishP2PNowPlaying(state, tuna);
      await publishLibp2pNowPlaying(state, tuna);
      return tuna;
    }
    const fallback = mac.ok ? mac : tuna.ok ? tuna : mac;
    publishMasterRelayNowPlaying(state, fallback);
    publishP2PNowPlaying(state, fallback);
    await publishLibp2pNowPlaying(state, fallback);
    return fallback;
  }
  const unsupported = { ok: false, error: `Unsupported platform: ${process.platform}` };
  publishMasterRelayNowPlaying(state, unsupported);
  publishP2PNowPlaying(state, unsupported);
  await publishLibp2pNowPlaying(state, unsupported);
  return unsupported;
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
    console.log("[BetterFluxer Bridge] Console commands: help, probe, last, watch on, watch off, watch status, rpc status, master status, p2p status, libp2p status, tuna path");
  };

  const runProbe = async () => {
    try {
      const nowPlaying = await queryUniversalNowPlaying(state);
      state.lastNowPlaying = nowPlaying;
      state.lastNowPlayingAt = Date.now();
      console.log(`[BetterFluxer Bridge] Probe: ${formatNowPlayingForLog(nowPlaying)}`);
    } catch (error) {
      console.warn("[BetterFluxer Bridge] Probe error:", String((error && error.message) || error || "unknown"));
    }
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
    } else if (cmd === "master status") {
      const hasRecentMaster = Boolean(state.lastMasterActivity && Date.now() - Number(state.lastMasterActivityAt || 0) < 180000);
      console.log(
        `[BetterFluxer Bridge] Master relay enabled=${Boolean(state.masterRelayConfig && state.masterRelayConfig.enabled)} connected=${Boolean(state.masterRelayConnected)} recentActivity=${hasRecentMaster}`
      );
      if (state.masterRelayLastError) {
        console.log(`[BetterFluxer Bridge] Master relay last error: ${state.masterRelayLastError}`);
      }
    } else if (cmd === "p2p status") {
      const recentP2P = Boolean(state.lastP2PActivity && Date.now() - Number(state.lastP2PActivityAt || 0) < 180000);
      const bw = getP2PBandwidthStats(state);
      console.log(
        `[BetterFluxer Bridge] P2P enabled=${Boolean(state.p2pConfig && state.p2pConfig.enabled)} started=${Boolean(state.p2pStarted)} peers=${Number(state.p2pConnectedPeers || 0)} recentActivity=${recentP2P}`
      );
      console.log(
        `[BetterFluxer Bridge] P2P nodeId=${String(state.p2pNodeId || "")} sent=${Number(state.p2pSentCount || 0)} recv=${Number(state.p2pReceivedCount || 0)}`
      );
      console.log(
        `[BetterFluxer Bridge] P2P bandwidth in=${bw.inBps1m} B/s out=${bw.outBps1m} B/s (1m avg) totalIn=${bw.totalBytesIn} B totalOut=${bw.totalBytesOut} B`
      );
      if (state.p2pPeerSockets && state.p2pPeerSockets.size) {
        for (const peer of state.p2pPeerSockets.values()) {
          console.log(
            `  - ${peer.key} in=${Number(peer.bytesIn || 0)} B out=${Number(peer.bytesOut || 0)} B connectedAt=${new Date(Number(peer.connectedAt || 0)).toISOString()}`
          );
        }
      }
      if (state.p2pLastError) {
        console.log(`[BetterFluxer Bridge] P2P last error: ${state.p2pLastError}`);
      }
    } else if (cmd === "libp2p status") {
      console.log(
        `[BetterFluxer Bridge] libp2p enabled=${Boolean(state.libp2pConfig && state.libp2pConfig.enabled)} started=${Boolean(state.libp2pStarted)} subscribed=${Boolean(state.libp2pSubscribed)} peers=${Number(state.libp2pPeerCount || 0)}`
      );
      console.log(
        `[BetterFluxer Bridge] libp2p nodeId=${String(state.libp2pNodeId || "")} topic=${String((state.libp2pConfig && state.libp2pConfig.topic) || "")}`
      );
      console.log(
        `[BetterFluxer Bridge] libp2p sent=${Number(state.libp2pMessagesSent || 0)} recv=${Number(state.libp2pMessagesReceived || 0)} bytesIn=${Number(state.libp2pBytesReceived || 0)} bytesOut=${Number(state.libp2pBytesSent || 0)}`
      );
      if (state.libp2pLastError) {
        console.log(`[BetterFluxer Bridge] libp2p last error: ${state.libp2pLastError}`);
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
    tunaPath: getTunaJsonPath(),
    masterRelayConfig: getMasterRelayConfig(),
    masterRelaySocket: null,
    masterRelayReconnectTimer: null,
    masterRelayConnected: false,
    masterRelayConnectedAt: 0,
    masterRelayLastMessageAt: 0,
    masterRelayLastError: "",
    masterRelayLastSentKey: "",
    masterRelayLastSentAt: 0,
    lastMasterActivity: null,
    lastMasterActivityAt: 0,
    p2pConfig: getP2PConfig(),
    p2pStarted: false,
    p2pNodeId: "",
    p2pServer: null,
    p2pBootstrapTimer: null,
    p2pPeerSockets: new Map(),
    p2pKnownPeers: new Map(),
    p2pPendingConnect: new Set(),
    p2pConnectedPeers: 0,
    p2pSeenIds: new Map(),
    p2pLastError: "",
    p2pLastMessageAt: 0,
    p2pLastSentAt: 0,
    p2pLastSentKey: "",
    p2pSentCount: 0,
    p2pReceivedCount: 0,
    p2pBytesSent: 0,
    p2pBytesReceived: 0,
    p2pInSamples: [],
    p2pOutSamples: [],
    lastP2PActivity: null,
    lastP2PActivityAt: 0,
    libp2pConfig: getLibp2pConfig(),
    libp2pStarted: false,
    libp2pSubscribed: false,
    libp2pNode: null,
    libp2pTopicHandler: null,
    libp2pNodeId: "",
    libp2pPeerCount: 0,
    libp2pLastError: "",
    libp2pLastMessageAt: 0,
    libp2pLastSentAt: 0,
    libp2pMessagesSent: 0,
    libp2pMessagesReceived: 0,
    libp2pBytesSent: 0,
    libp2pBytesReceived: 0,
    libp2pLastSentKey: "",
    lastLibp2pActivity: null,
    lastLibp2pActivityAt: 0
  };
  startDiscordRpcCapture(bridgeState);
  startMasterRelay(bridgeState);
  startP2PBridge(bridgeState);
  await startLibp2pBridge(bridgeState);

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
          rpcCaptureStarted: Boolean(bridgeState.rpcCaptureStarted),
          masterRelay: {
            enabled: Boolean(bridgeState.masterRelayConfig && bridgeState.masterRelayConfig.enabled),
            connected: Boolean(bridgeState.masterRelayConnected),
            url: bridgeState.masterRelayConfig && bridgeState.masterRelayConfig.url ? bridgeState.masterRelayConfig.url : "",
            userId: bridgeState.masterRelayConfig && bridgeState.masterRelayConfig.userId ? bridgeState.masterRelayConfig.userId : "",
            lastConnectedAt: Number(bridgeState.masterRelayConnectedAt || 0),
            lastMessageAt: Number(bridgeState.masterRelayLastMessageAt || 0),
            lastError: String(bridgeState.masterRelayLastError || ""),
            lastSentAt: Number(bridgeState.masterRelayLastSentAt || 0),
            hasRecentActivity: Boolean(bridgeState.lastMasterActivity && Date.now() - Number(bridgeState.lastMasterActivityAt || 0) < 180000)
          },
          p2p: {
            enabled: Boolean(bridgeState.p2pConfig && bridgeState.p2pConfig.enabled),
            started: Boolean(bridgeState.p2pStarted),
            nodeId: String(bridgeState.p2pNodeId || ""),
            listenHost: String((bridgeState.p2pConfig && bridgeState.p2pConfig.host) || ""),
            listenPort: Number((bridgeState.p2pConfig && bridgeState.p2pConfig.port) || 0),
            announceHost: String((bridgeState.p2pConfig && bridgeState.p2pConfig.announceHost) || ""),
            userId: String((bridgeState.p2pConfig && bridgeState.p2pConfig.userId) || ""),
            bootstrapPeers: Array.isArray(bridgeState.p2pConfig && bridgeState.p2pConfig.peers)
              ? bridgeState.p2pConfig.peers.map((p) => `${p.host}:${p.port}`)
              : [],
            peersConnected: Number(bridgeState.p2pConnectedPeers || 0),
            messagesSent: Number(bridgeState.p2pSentCount || 0),
            messagesReceived: Number(bridgeState.p2pReceivedCount || 0),
            bytesSent: Number(bridgeState.p2pBytesSent || 0),
            bytesReceived: Number(bridgeState.p2pBytesReceived || 0),
            bandwidth: getP2PBandwidthStats(bridgeState),
            lastMessageAt: Number(bridgeState.p2pLastMessageAt || 0),
            lastSentAt: Number(bridgeState.p2pLastSentAt || 0),
            lastError: String(bridgeState.p2pLastError || ""),
            hasRecentActivity: Boolean(bridgeState.lastP2PActivity && Date.now() - Number(bridgeState.lastP2PActivityAt || 0) < 180000)
          },
          libp2p: {
            enabled: Boolean(bridgeState.libp2pConfig && bridgeState.libp2pConfig.enabled),
            started: Boolean(bridgeState.libp2pStarted),
            subscribed: Boolean(bridgeState.libp2pSubscribed),
            nodeId: String(bridgeState.libp2pNodeId || ""),
            host: String((bridgeState.libp2pConfig && bridgeState.libp2pConfig.host) || ""),
            port: Number((bridgeState.libp2pConfig && bridgeState.libp2pConfig.port) || 0),
            topic: String((bridgeState.libp2pConfig && bridgeState.libp2pConfig.topic) || ""),
            userId: String((bridgeState.libp2pConfig && bridgeState.libp2pConfig.userId) || ""),
            peersConnected: Number(bridgeState.libp2pPeerCount || 0),
            bootstrap: Array.isArray(bridgeState.libp2pConfig && bridgeState.libp2pConfig.bootstrap)
              ? bridgeState.libp2pConfig.bootstrap
              : [],
            relays: Array.isArray(bridgeState.libp2pConfig && bridgeState.libp2pConfig.relays)
              ? bridgeState.libp2pConfig.relays
              : [],
            messagesSent: Number(bridgeState.libp2pMessagesSent || 0),
            messagesReceived: Number(bridgeState.libp2pMessagesReceived || 0),
            bytesSent: Number(bridgeState.libp2pBytesSent || 0),
            bytesReceived: Number(bridgeState.libp2pBytesReceived || 0),
            lastMessageAt: Number(bridgeState.libp2pLastMessageAt || 0),
            lastSentAt: Number(bridgeState.libp2pLastSentAt || 0),
            lastError: String(bridgeState.libp2pLastError || ""),
            hasRecentActivity: Boolean(bridgeState.lastLibp2pActivity && Date.now() - Number(bridgeState.lastLibp2pActivityAt || 0) < 180000)
          },
          tunaPath: bridgeState.tunaPath,
          allowlist,
          uptimeSec: Math.floor(process.uptime())
        },
        origin || "*"
      );
    }

    if (url.pathname === "/windows/media" || url.pathname === "/windows/media/now-playing") {
      return sendJson(
        res,
        410,
        { ok: false, error: "Removed: Windows media API source is disabled. Use /now-playing (RPC/Tuna)." },
        origin || "*"
      );
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
      try {
        const nowPlaying = await queryUniversalNowPlaying(bridgeState);
        bridgeState.lastNowPlaying = nowPlaying;
        bridgeState.lastNowPlayingAt = Date.now();
        console.log(`[BetterFluxer Bridge] /now-playing -> ${formatNowPlayingForLog(nowPlaying)}`);
        return sendJson(res, nowPlaying && nowPlaying.ok ? 200 : 502, nowPlaying, origin || "*");
      } catch (error) {
        return sendJson(
          res,
          502,
          { ok: false, error: String((error && error.message) || error || "now-playing failed") },
          origin || "*"
        );
      }
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
    if (bridgeState.masterRelayConfig && bridgeState.masterRelayConfig.enabled) {
      console.log(`[BetterFluxer Bridge] Master relay URL: ${bridgeState.masterRelayConfig.url}`);
      console.log(`[BetterFluxer Bridge] Master relay userId: ${bridgeState.masterRelayConfig.userId || "(none)"}`);
    } else {
      console.log("[BetterFluxer Bridge] Master relay disabled (set BF_MASTER_WS_URL to enable)");
    }
    if (bridgeState.p2pConfig && bridgeState.p2pConfig.enabled) {
      console.log(
        `[BetterFluxer Bridge] P2P enabled on ${bridgeState.p2pConfig.host}:${bridgeState.p2pConfig.port} (nodeId=${bridgeState.p2pNodeId || "pending"})`
      );
      console.log(
        `[BetterFluxer Bridge] P2P bootstrap peers: ${bridgeState.p2pConfig.peers.map((p) => `${p.host}:${p.port}`).join(", ") || "(none)"}`
      );
      if (!bridgeState.p2pConfig.announceHost) {
        console.log("[BetterFluxer Bridge] P2P announce host not set (set BF_P2P_ANNOUNCE_HOST for remote peers).");
      }
    } else {
      console.log("[BetterFluxer Bridge] P2P disabled (set BF_P2P_ENABLED=1 to enable).");
    }
    if (bridgeState.libp2pConfig && bridgeState.libp2pConfig.enabled) {
      console.log(
        `[BetterFluxer Bridge] libp2p enabled on ${bridgeState.libp2pConfig.host}:${bridgeState.libp2pConfig.port} topic=${bridgeState.libp2pConfig.topic}`
      );
      if ((bridgeState.libp2pConfig.bootstrap || []).length) {
        console.log(`[BetterFluxer Bridge] libp2p bootstrap: ${bridgeState.libp2pConfig.bootstrap.join(", ")}`);
      }
      if ((bridgeState.libp2pConfig.relays || []).length) {
        console.log(`[BetterFluxer Bridge] libp2p relays: ${bridgeState.libp2pConfig.relays.join(", ")}`);
      }
    } else {
      console.log("[BetterFluxer Bridge] libp2p disabled (set BF_LIBP2P_ENABLED=1 to enable).");
    }
    setupConsoleControls(bridgeState, { hidden: Boolean(args.hidden) });
  });

  process.on("SIGINT", async () => {
    stopMasterRelay(bridgeState);
    stopP2PBridge(bridgeState);
    await stopLibp2pBridge(bridgeState);
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    stopMasterRelay(bridgeState);
    stopP2PBridge(bridgeState);
    await stopLibp2pBridge(bridgeState);
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("[BetterFluxer Bridge] Failed:", error && error.message ? error.message : error);
  process.exit(1);
});
