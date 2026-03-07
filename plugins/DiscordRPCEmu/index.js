class MiniEmitter {
  constructor() {
    this._events = new Map();
  }

  on(event, handler) {
    if (typeof handler !== "function") return this;
    const key = String(event || "");
    if (!this._events.has(key)) this._events.set(key, new Set());
    this._events.get(key).add(handler);
    return this;
  }

  once(event, handler) {
    if (typeof handler !== "function") return this;
    const wrapped = (...args) => {
      this.off(event, wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  off(event, handler) {
    const key = String(event || "");
    const set = this._events.get(key);
    if (!set) return this;
    set.delete(handler);
    if (set.size === 0) this._events.delete(key);
    return this;
  }

  emit(event, ...args) {
    const key = String(event || "");
    const set = this._events.get(key);
    if (!set) return false;
    for (const handler of Array.from(set)) {
      try {
        handler(...args);
      } catch (_) {}
    }
    return true;
  }
}

module.exports = class DiscordRPCEmuPlugin {
  constructor(api) {
    this.api = api;
    this.previous = null;
    this.clients = new Set();
    this.globalClientId = this.api.storage.get("registeredClientId", "");
    this.bridgeSocket = null;
    this.bridgePort = null;
    this.bridgeReconnectTimer = null;
    this.bridgeStarted = false;
    this.bridgeNonce = 0;
    this.statusSyncEnabled = this.api.storage.get("statusSyncEnabled", true) !== false;
    this.statusPollTimer = null;
    this.lastBridgeActivity = null;
    this.lastBridgeActivityAt = 0;
    this.lastAppliedStatusText = "";
    this.lastStatusApplyAt = 0;
    this.cachedStatusEndpoint = this.api.storage.get("statusSyncEndpoint", null);
    this.captureStatusEndpointArmed = false;
    this.fetchRestore = null;
    this.localBridgeEnabled = this.api.storage.get("localBridgeEnabled", true) !== false;
    this.localBridgePort = Number.parseInt(String(this.api.storage.get("localBridgePort", "21864")), 10) || 21864;
    this.localBridgeToken = String(this.api.storage.get("localBridgeToken", "") || "");
    this.lastWindowsMedia = null;
    this.lastWindowsMediaAt = 0;
    this.lastWindowsMediaError = "";
    this.debugDetection = this.api.storage.get("debugDetection", false) === true;
    this.userStatusKnown = this.api.storage.get("manualStatusKnown", false) === true;
    this.userStatusText = String(this.api.storage.get("manualStatusText", "") || "");
    this.autoStatusActive = false;
    this.internalStatusWriteDepth = 0;
  }

  start() {
    const win = this.api.app.getWindow?.();
    if (!win) return;

    this.previous = win.DiscordRPC;
    const plugin = this;

    class DiscordRPCClient extends MiniEmitter {
      constructor(options = {}) {
        super();
        this.options = options || {};
        this.transport = this.options.transport || "ipc";
        this.clientId = "";
        this.user = {
          id: "betterfluxer-rpc-user",
          username: "BetterFluxer",
          discriminator: "0000",
          avatar: null
        };
        this._activity = plugin.api.storage.get("discordRpcEmu:lastActivity", null);
        this._connected = false;
        plugin.clients.add(this);
      }

      async login(data = {}) {
        this.clientId = String(data.clientId || plugin.globalClientId || "");
        if (this.clientId) {
          plugin.globalClientId = this.clientId;
          plugin.api.storage.set("registeredClientId", this.clientId);
        }
        this._connected = true;
        this.emit("connected");
        this.emit("ready");
        return { client_id: this.clientId };
      }

      async setActivity(activity = {}) {
        this._activity = activity && typeof activity === "object" ? { ...activity } : {};
        plugin.api.storage.set("discordRpcEmu:lastActivity", this._activity);
        this.emit("activityUpdate", this._activity);
        return true;
      }

      async clearActivity() {
        this._activity = null;
        plugin.api.storage.delete("discordRpcEmu:lastActivity");
        this.emit("activityUpdate", null);
        return true;
      }

      async request(command, args = {}) {
        const cmd = String(command || "").toUpperCase();
        if (cmd === "SET_ACTIVITY") {
          await this.setActivity(args.activity || args);
          return { ok: true };
        }
        if (cmd === "CLEAR_ACTIVITY") {
          await this.clearActivity();
          return { ok: true };
        }
        if (cmd === "GET_ACTIVITY") {
          return { activity: this._activity };
        }
        return { ok: true, command, args };
      }

      async subscribe() {
        return true;
      }

      async unsubscribe() {
        return true;
      }

      getActivity() {
        return this._activity;
      }

      async destroy() {
        this._connected = false;
        this.emit("disconnected");
        plugin.clients.delete(this);
        return true;
      }
    }

    win.DiscordRPC = {
      register: (clientId) => {
        const value = String(clientId || "");
        plugin.globalClientId = value;
        plugin.api.storage.set("registeredClientId", value);
      },
      Client: DiscordRPCClient
    };

    win.__betterFluxerDiscordRPCEmu = {
      getRegisteredClientId: () => plugin.globalClientId,
      getLastActivity: () => plugin.api.storage.get("discordRpcEmu:lastActivity", null),
      listClients: () =>
        Array.from(plugin.clients).map((client) => ({
          clientId: client.clientId || "",
          connected: Boolean(client._connected),
          transport: client.transport || "ipc"
        })),
      getBridgeState: () => ({
        connected: Boolean(plugin.bridgeSocket && plugin.bridgeSocket.readyState === 1),
        port: plugin.bridgePort,
        started: plugin.bridgeStarted
      }),
      getStatusSyncState: () => ({
        enabled: Boolean(plugin.statusSyncEnabled),
        lastAppliedStatusText: plugin.lastAppliedStatusText || "",
        lastStatusApplyAt: plugin.lastStatusApplyAt || 0,
        cachedEndpoint: plugin.cachedStatusEndpoint || null,
        localBridgeEnabled: Boolean(plugin.localBridgeEnabled),
        localBridgePort: plugin.localBridgePort,
        hasRecentWindowsMedia: Boolean(plugin.lastWindowsMedia && Date.now() - plugin.lastWindowsMediaAt < 30000),
        userStatusKnown: Boolean(plugin.userStatusKnown),
        userStatusText: plugin.userStatusText || "",
        autoStatusActive: Boolean(plugin.autoStatusActive)
      })
    };

    this.startBridge();
    this.installFetchStatusCapture();
    this.startStatusSync();
    this.api.logger.info("DiscordRPCEmu enabled.");
  }

  stop() {
    const win = this.api.app.getWindow?.();
    if (win) {
      for (const client of Array.from(this.clients)) {
        try {
          client.destroy();
        } catch (_) {}
      }
      this.clients.clear();

      try {
        delete win.__betterFluxerDiscordRPCEmu;
      } catch (_) {}

      if (this.previous === undefined || this.previous === null) {
        try {
          delete win.DiscordRPC;
        } catch (_) {}
      } else {
        win.DiscordRPC = this.previous;
      }
    }

    this.stopBridge();
    this.stopStatusSync();
    this.uninstallFetchStatusCapture();
    this.previous = null;
    this.api.patcher.unpatchAll();
    this.api.logger.info("DiscordRPCEmu disabled.");
  }

  debugLog(message, extra) {
    if (!this.debugDetection) return;
    if (typeof extra !== "undefined") {
      this.api.logger.info(`[debug] ${String(message || "")} ${JSON.stringify(extra)}`);
      return;
    }
    this.api.logger.info(`[debug] ${String(message || "")}`);
  }

  extractCustomStatusText(bodyJson) {
    const body = bodyJson && typeof bodyJson === "object" ? bodyJson : null;
    if (!body) return { has: false, text: "" };
    if (Object.prototype.hasOwnProperty.call(body, "custom_status")) {
      const cs = body.custom_status;
      if (cs == null) return { has: true, text: "" };
      if (typeof cs === "object") return { has: true, text: String(cs.text || "").trim() };
      return { has: true, text: String(cs || "").trim() };
    }
    if (body.status && typeof body.status === "object" && Object.prototype.hasOwnProperty.call(body.status, "custom_status")) {
      const cs = body.status.custom_status;
      if (cs == null) return { has: true, text: "" };
      if (typeof cs === "object") return { has: true, text: String(cs.text || "").trim() };
      return { has: true, text: String(cs || "").trim() };
    }
    return { has: false, text: "" };
  }

  installFetchStatusCapture() {
    const win = this.api.app.getWindow?.();
    if (!win || typeof win.fetch !== "function" || this.fetchRestore) return;

    const plugin = this;
    const originalFetch = win.fetch.bind(win);
    this.fetchRestore = () => {
      try {
        win.fetch = originalFetch;
      } catch (_) {}
      this.fetchRestore = null;
    };

    win.fetch = async function betterFluxerStatusCapture(input, init) {
      const method = String((init && init.method) || "GET").toUpperCase();
      const url = typeof input === "string" ? input : input && input.url ? String(input.url) : "";
      const bodyRaw = init && typeof init.body === "string" ? init.body : "";
      let bodyJson = null;

      if ((method === "PATCH" || method === "PUT" || method === "POST") && bodyRaw) {
        try {
          bodyJson = JSON.parse(bodyRaw);
        } catch (_) {
          bodyJson = null;
        }
      }

      let response;
      try {
        response = await originalFetch(input, init);
      } catch (err) {
        throw err;
      }

      if (response && response.ok && bodyJson && typeof bodyJson === "object") {
        const statusInfo = plugin.extractCustomStatusText(bodyJson);
        if (statusInfo.has) {
          // Auto-learn successful status endpoint from real app traffic.
          if (plugin.captureStatusEndpointArmed || !plugin.cachedStatusEndpoint) {
            plugin.cachedStatusEndpoint = { method, url, body: bodyJson };
            plugin.api.storage.set("statusSyncEndpoint", plugin.cachedStatusEndpoint);
            plugin.captureStatusEndpointArmed = false;
            plugin.api.logger.info(`DiscordRPCEmu: captured status endpoint ${method} ${url}`);
          }
          if (plugin.internalStatusWriteDepth <= 0) {
            plugin.userStatusKnown = true;
            plugin.userStatusText = String(statusInfo.text || "");
            plugin.api.storage.set("manualStatusKnown", true);
            plugin.api.storage.set("manualStatusText", plugin.userStatusText);
            plugin.debugLog("manual-status-captured", { text: plugin.userStatusText });
          }
        }
      }

      return response;
    };
  }

  uninstallFetchStatusCapture() {
    if (typeof this.fetchRestore === "function") {
      try {
        this.fetchRestore();
      } catch (_) {}
    }
    this.fetchRestore = null;
  }

  startStatusSync() {
    if (!this.statusSyncEnabled) return;
    if (this.statusPollTimer) return;
    this.statusPollTimer = setInterval(() => {
      this.applyNowPlayingFromSources().catch(() => {});
    }, 10000);
    this.applyNowPlayingFromSources().catch(() => {});
  }

  stopStatusSync() {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  getAuthToken() {
    const win = this.api.app.getWindow?.();
    const ls = win?.localStorage;
    if (!ls || typeof ls.getItem !== "function") return "";
    const raw = ls.getItem("token") || ls.getItem("fluxer_token") || ls.getItem("auth_token") || "";
    const token = String(raw || "").trim();
    if (!token) return "";
    if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  }

  formatClock(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return "";
    const totalSec = Math.floor(n / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  buildProgressSuffix(positionMs, durationMs) {
    const pos = Number(positionMs);
    if (!Number.isFinite(pos) || pos < 0) return "";
    const posText = this.formatClock(pos);
    const dur = Number(durationMs);
    if (Number.isFinite(dur) && dur > 0) {
      return ` (${posText}/${this.formatClock(dur)})`;
    }
    return ` (${posText})`;
  }

  buildNowPlayingTextFromActivity(activity) {
    const a = activity && typeof activity === "object" ? activity : {};
    const activityType = Number.isFinite(Number(a.type)) ? Number(a.type) : null;
    const isGame = activityType === 0;
    const details = String(a.details || a.name || "").trim();
    const state = String(a.state || "").trim();
    if (!details && !state) return "";
    let text = details;
    if (state) {
      text = text ? `${details} - ${state}` : state;
    }
    const ts = a.timestamps && typeof a.timestamps === "object" ? a.timestamps : null;
    const startMs = ts && Number.isFinite(Number(ts.start)) ? Number(ts.start) : null;
    const endMs = ts && Number.isFinite(Number(ts.end)) ? Number(ts.end) : null;
    const now = Date.now();
    const positionMs = startMs != null ? Math.max(0, now - startMs) : null;
    const durationMs = startMs != null && endMs != null && endMs > startMs ? endMs - startMs : null;
    text += this.buildProgressSuffix(positionMs, durationMs);
    text = `${isGame ? "🎮 Playing " : "🎵 Listening to "}${text}`.trim();
    if (text.length > 120) text = text.slice(0, 117) + "...";
    return text;
  }

  getMediaSessionNowPlayingText() {
    const win = this.api.app.getWindow?.();
    const md = win?.navigator?.mediaSession?.metadata;
    if (!md) return "";
    const title = String(md.title || "").trim();
    const artist = String(md.artist || "").trim();
    const album = String(md.album || "").trim();
    let text = title;
    if (artist) text = text ? `${title} - ${artist}` : artist;
    if (!text && album) text = album;
    if (!text) return "";
    text = `🎵 Listening to ${text}`;
    if (text.length > 120) text = text.slice(0, 117) + "...";
    return text;
  }

  buildNowPlayingTextFromWindowsMedia(media) {
    const m = media && typeof media === "object" ? media : null;
    if (!m || !m.ok || !m.hasSession) return "";
    const kind = String(m.kind || "").toLowerCase();
    const source = String(m.source || "").toLowerCase();
    const hasTrackMetadata = Boolean(String(m.title || "").trim() || String(m.artist || "").trim() || String(m.albumTitle || "").trim());
    const hasRpcGameMarkers = kind === "game";
    const hasExplicitGameType =
      (typeof m.activityType === "number" && Number.isFinite(m.activityType) && m.activityType === 0) ||
      (typeof m.activityType === "string" && m.activityType.trim() !== "" && Number(m.activityType) === 0);
    const isGame = hasRpcGameMarkers || (hasExplicitGameType && !hasTrackMetadata);
    const prefix = isGame ? "🎮 Playing " : "🎵 Listening to ";

    const name = String(m.name || "").trim();
    const details = String(m.details || "").trim();
    const state = String(m.state || "").trim();
    const title = String(m.title || "").trim();
    const artist = String(m.artist || "").trim();
    const album = String(m.albumTitle || "").trim();
    let text = details || title || name;
    if (state) text = text ? `${text} - ${state}` : state;
    if (!text && artist) text = artist;
    if (!text && title && artist) text = `${title} - ${artist}`;
    if (!text && album) text = album;
    if (!text) return "";
    text += this.buildProgressSuffix(m.positionMs, m.durationMs);
    text = `${prefix}${text}`;
    if (text.length > 120) text = text.slice(0, 117) + "...";
    return text;
  }

  async queryWindowsMediaNowPlayingText() {
    if (!this.localBridgeEnabled) return "";
    const port = Number(this.localBridgePort || 21864);
    if (!Number.isFinite(port) || port <= 0) return "";
    const tokenQuery = this.localBridgeToken ? `?token=${encodeURIComponent(this.localBridgeToken)}` : "";
    const urlCandidates = [
      `http://127.0.0.1:${port}/now-playing${tokenQuery}`,
      `http://127.0.0.1:${port}/windows/media${tokenQuery}`
    ];

    try {
      let payload = null;
      let lastError = "";
      for (const url of urlCandidates) {
        try {
          if (this.api.network && typeof this.api.network.fetchJson === "function") {
            // Use injector IPC-backed network helper when available (bypasses renderer CSP).
            try {
              payload = await this.api.network.fetchJson(url);
            } catch (_networkError) {
              payload = null;
            }
          }
          if (!payload) {
            const win = this.api.app.getWindow?.();
            if (!win || typeof win.fetch !== "function") return "";
            const res = await win.fetch(url);
            if (!res || !res.ok) {
              let bodyText = "";
              try {
                bodyText = await res.text();
              } catch (_) {
                bodyText = "";
              }
              let parsedError = "";
              if (bodyText) {
                try {
                  const parsed = JSON.parse(bodyText);
                  parsedError = String((parsed && parsed.error) || "");
                } catch (_) {
                  parsedError = "";
                }
              }
              lastError =
                `HTTP ${res ? res.status : "unknown"} for ${url}` +
                (parsedError ? ` | ${parsedError}` : "") +
                (bodyText && !parsedError ? ` | ${bodyText.slice(0, 240)}` : "");
              continue;
            }
            payload = await res.json();
          }
          if (payload) break;
        } catch (error) {
          lastError = String((error && error.message) || error || "unknown");
        }
      }
      if (!payload) {
        this.lastWindowsMediaError = lastError || "Bridge request failed";
        this.debugLog("windows-media-query-failed", { error: this.lastWindowsMediaError });
        return "";
      }
      const text = this.buildNowPlayingTextFromWindowsMedia(payload);
      this.lastWindowsMediaError = "";
      if (text) {
        this.lastWindowsMedia = payload;
        this.lastWindowsMediaAt = Date.now();
        this.debugLog("windows-media-detected", {
          title: String(payload && payload.title ? payload.title : ""),
          artist: String(payload && payload.artist ? payload.artist : ""),
          appId: String(payload && payload.appId ? payload.appId : "")
        });
      }
      if (payload && payload.ok === false) {
        this.lastWindowsMediaError = String(payload.error || "Bridge returned ok=false");
      } else if (!text) {
        this.lastWindowsMediaError = "No active Windows media session";
      }
      return text;
    } catch (error) {
      this.lastWindowsMediaError = String((error && error.message) || error || "unknown");
      this.debugLog("windows-media-query-failed", { error: this.lastWindowsMediaError });
      return "";
    }
  }

  async getPreferredNowPlayingText() {
    const now = Date.now();
    if (this.lastBridgeActivity && now - this.lastBridgeActivityAt < 120000) {
      const fromBridge = this.buildNowPlayingTextFromActivity(this.lastBridgeActivity);
      if (fromBridge) {
        this.debugLog("source-selected", { source: "discord-rpc-bridge", text: fromBridge });
        return fromBridge;
      }
    }
    const fromWindowsMedia = await this.queryWindowsMediaNowPlayingText();
    if (fromWindowsMedia) {
      this.debugLog("source-selected", { source: "windows-media", text: fromWindowsMedia });
      return fromWindowsMedia;
    }
    const fromMediaSession = this.getMediaSessionNowPlayingText();
    if (fromMediaSession) {
      this.debugLog("source-selected", { source: "navigator.mediaSession", text: fromMediaSession });
    } else {
      this.debugLog("source-selected", { source: "none" });
    }
    return fromMediaSession;
  }

  async applyNowPlayingFromSources() {
    if (!this.statusSyncEnabled) return false;
    const text = await this.getPreferredNowPlayingText();
    if (!text) {
      if (this.autoStatusActive && this.userStatusKnown) {
        const restoreText = String(this.userStatusText || "");
        const restored = await this.setFluxerCustomStatus(restoreText, { allowEmpty: true });
        if (restored) {
          this.autoStatusActive = false;
          this.lastAppliedStatusText = restoreText;
          this.lastStatusApplyAt = Date.now();
        }
        return restored;
      }
      return false;
    }
    if (text === this.lastAppliedStatusText) return true;
    const ok = await this.setFluxerCustomStatus(text);
    if (ok) {
      this.autoStatusActive = true;
      this.lastAppliedStatusText = text;
      this.lastStatusApplyAt = Date.now();
    }
    return ok;
  }

  async setFluxerCustomStatus(text, options = {}) {
    const win = this.api.app.getWindow?.();
    if (!win || typeof win.fetch !== "function") return false;
    const token = this.getAuthToken();
    const baseHeaders = {
      Accept: "application/json",
      "Content-Type": "application/json"
    };
    const headerVariants = [];
    headerVariants.push({ ...baseHeaders });
    if (token) {
      headerVariants.push({ ...baseHeaders, Authorization: token });
      headerVariants.push({ ...baseHeaders, Authorization: `Bearer ${token}` });
    }

    const statusText = String(text || "").trim();
    const isClear = statusText.length === 0;
    if (isClear && options.allowEmpty !== true) return false;

    const withStatusText = (body, value, clearMode) => {
      const input = body && typeof body === "object" ? JSON.parse(JSON.stringify(body)) : {};
      const out = input && typeof input === "object" ? input : {};
      if (clearMode) {
        if (Object.prototype.hasOwnProperty.call(out, "custom_status")) {
          out.custom_status = null;
          return out;
        }
        if (out.status && typeof out.status === "object" && Object.prototype.hasOwnProperty.call(out.status, "custom_status")) {
          out.status.custom_status = null;
          return out;
        }
        out.custom_status = null;
        return out;
      }
      if (out.custom_status && typeof out.custom_status === "object") {
        out.custom_status.text = value;
        return out;
      }
      if (out.status && typeof out.status === "object") {
        if (!out.status.custom_status || typeof out.status.custom_status !== "object") {
          out.status.custom_status = {};
        }
        out.status.custom_status.text = value;
        return out;
      }
      out.custom_status = { text: value };
      return out;
    };

    const requestDefs = [];
    if (this.cachedStatusEndpoint && this.cachedStatusEndpoint.url && this.cachedStatusEndpoint.method) {
      requestDefs.push({
        method: this.cachedStatusEndpoint.method,
        url: this.cachedStatusEndpoint.url,
        body: withStatusText(this.cachedStatusEndpoint.body, statusText, isClear)
      });
    }
    if (isClear) {
      requestDefs.push(
        { method: "PATCH", url: "/api/v1/users/@me/settings", body: { custom_status: null } },
        { method: "PATCH", url: "/api/v1/users/@me/settings", body: { custom_status: { text: "" } } },
        { method: "PATCH", url: "/api/v1/users/@me", body: { custom_status: null } },
        { method: "PATCH", url: "/api/v1/users/@me/profile", body: { custom_status: null } },
        { method: "PATCH", url: "https://web.fluxer.app/api/v1/users/@me/settings", body: { custom_status: null } },
        { method: "PATCH", url: "https://web.fluxer.app/api/v1/users/@me/settings", body: { custom_status: { text: "" } } },
        { method: "PATCH", url: "https://web.fluxer.app/api/v1/users/@me", body: { custom_status: null } },
        { method: "PATCH", url: "https://web.fluxer.app/api/v1/users/@me/profile", body: { custom_status: null } },
        { method: "PATCH", url: "/api/v1/users/@me/settings", body: { status: { custom_status: null } } }
      );
    } else {
      requestDefs.push(
        { method: "PATCH", url: "/api/v1/users/@me/settings", body: { custom_status: { text: statusText } } },
        { method: "PATCH", url: "/api/v1/users/@me", body: { custom_status: { text: statusText } } },
        { method: "PATCH", url: "/api/v1/users/@me/profile", body: { custom_status: { text: statusText } } },
        { method: "PATCH", url: "https://web.fluxer.app/api/v1/users/@me/settings", body: { custom_status: { text: statusText } } },
        { method: "PATCH", url: "https://web.fluxer.app/api/v1/users/@me", body: { custom_status: { text: statusText } } },
        { method: "PATCH", url: "https://web.fluxer.app/api/v1/users/@me/profile", body: { custom_status: { text: statusText } } },
        { method: "PATCH", url: "/api/v1/users/@me/settings", body: { status: { custom_status: { text: statusText } } } }
      );
    }

    const seen = new Set();
    for (const def of requestDefs) {
      if (!def || !def.url || !def.method) continue;
      const key = `${def.method}|${def.url}|${JSON.stringify(def.body || {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const headers of headerVariants) {
        try {
          this.internalStatusWriteDepth += 1;
          const res = await win.fetch(def.url, {
            method: def.method,
            credentials: "include",
            headers,
            body: JSON.stringify(def.body || {})
          });
          if (!res) continue;
          if (res.ok) {
            this.cachedStatusEndpoint = { method: def.method, url: def.url, body: def.body };
            this.api.storage.set("statusSyncEndpoint", this.cachedStatusEndpoint);
            return true;
          }
        } catch (_) {
        } finally {
          this.internalStatusWriteDepth = Math.max(0, this.internalStatusWriteDepth - 1);
        }
      }
    }
    return false;
  }

  getBridgeState() {
    return {
      connected: Boolean(this.bridgeSocket && this.bridgeSocket.readyState === 1),
      port: this.bridgePort,
      started: this.bridgeStarted
    };
  }

  getStatusSyncState() {
    return {
      enabled: Boolean(this.statusSyncEnabled),
      lastAppliedStatusText: this.lastAppliedStatusText || "",
      lastStatusApplyAt: this.lastStatusApplyAt || 0,
      cachedEndpoint: this.cachedStatusEndpoint || null,
      hasRecentBridgeActivity: Boolean(this.lastBridgeActivity && Date.now() - this.lastBridgeActivityAt < 120000),
      captureArmed: Boolean(this.captureStatusEndpointArmed),
      userStatusKnown: Boolean(this.userStatusKnown),
      userStatusText: this.userStatusText || "",
      autoStatusActive: Boolean(this.autoStatusActive)
    };
  }

  async syncNowPlayingNow() {
    return this.applyNowPlayingFromSources();
  }

  setDebugDetection(enabled) {
    this.debugDetection = Boolean(enabled);
    this.api.storage.set("debugDetection", this.debugDetection);
    return this.debugDetection;
  }

  getDetectionDebug() {
    const mediaSessionText = this.getMediaSessionNowPlayingText();
    const bridgeText =
      this.lastBridgeActivity && Date.now() - this.lastBridgeActivityAt < 120000
        ? this.buildNowPlayingTextFromActivity(this.lastBridgeActivity)
        : "";
    const windowsText = this.buildNowPlayingTextFromWindowsMedia(this.lastWindowsMedia);
    return {
      debugDetection: Boolean(this.debugDetection),
      bridge: {
        connected: Boolean(this.bridgeSocket && this.bridgeSocket.readyState === 1),
        hasRecentActivity: Boolean(this.lastBridgeActivity && Date.now() - this.lastBridgeActivityAt < 120000),
        activityText: bridgeText || "",
        lastActivityAt: this.lastBridgeActivityAt || 0
      },
      windowsMedia: {
        enabled: Boolean(this.localBridgeEnabled),
        port: this.localBridgePort,
        tokenSet: Boolean(this.localBridgeToken),
        hasRecentData: Boolean(this.lastWindowsMedia && Date.now() - this.lastWindowsMediaAt < 30000),
        text: windowsText || "",
        lastAt: this.lastWindowsMediaAt || 0,
        lastError: this.lastWindowsMediaError || ""
      },
      mediaSession: {
        text: mediaSessionText || ""
      },
      status: {
        lastAppliedStatusText: this.lastAppliedStatusText || "",
        lastStatusApplyAt: this.lastStatusApplyAt || 0,
        cachedEndpoint: this.cachedStatusEndpoint || null
      }
    };
  }

  armStatusEndpointCapture() {
    this.captureStatusEndpointArmed = true;
    return true;
  }

  configureLocalBridge(options) {
    const opt = options && typeof options === "object" ? options : {};
    if (Object.prototype.hasOwnProperty.call(opt, "enabled")) {
      this.localBridgeEnabled = Boolean(opt.enabled);
      this.api.storage.set("localBridgeEnabled", this.localBridgeEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(opt, "port")) {
      const port = Number.parseInt(String(opt.port || ""), 10);
      if (Number.isFinite(port) && port > 0) {
        this.localBridgePort = port;
        this.api.storage.set("localBridgePort", port);
      }
    }
    if (Object.prototype.hasOwnProperty.call(opt, "token")) {
      this.localBridgeToken = String(opt.token || "");
      this.api.storage.set("localBridgeToken", this.localBridgeToken);
    }
    return {
      enabled: this.localBridgeEnabled,
      port: this.localBridgePort,
      tokenSet: Boolean(this.localBridgeToken)
    };
  }

  clearCachedStatusEndpoint() {
    this.cachedStatusEndpoint = null;
    this.api.storage.delete("statusSyncEndpoint");
    return true;
  }

  async setStatusTextNow(text) {
    const value = String(text || "").trim();
    const ok = await this.setFluxerCustomStatus(value, { allowEmpty: true });
    if (ok) {
      this.autoStatusActive = false;
      this.lastAppliedStatusText = value;
      this.lastStatusApplyAt = Date.now();
    }
    return ok;
  }

  nextNonce() {
    this.bridgeNonce += 1;
    return `bf-rpc-${Date.now()}-${this.bridgeNonce}`;
  }

  startBridge() {
    this.bridgeStarted = true;
    this.connectBridge();
  }

  stopBridge() {
    this.bridgeStarted = false;
    if (this.bridgeReconnectTimer) {
      clearTimeout(this.bridgeReconnectTimer);
      this.bridgeReconnectTimer = null;
    }
    if (this.bridgeSocket) {
      try {
        this.bridgeSocket.close();
      } catch (_) {}
      this.bridgeSocket = null;
    }
    this.bridgePort = null;
  }

  scheduleBridgeReconnect(delayMs) {
    if (!this.bridgeStarted) return;
    if (this.bridgeReconnectTimer) return;
    this.bridgeReconnectTimer = setTimeout(() => {
      this.bridgeReconnectTimer = null;
      this.connectBridge();
    }, Math.max(1000, Number(delayMs || 5000)));
  }

  getBridgeUrls() {
    const win = this.api.app.getWindow?.();
    if (!win) return [];
    const wsProxyBase =
      (win.electron && typeof win.electron.getWsProxyUrl === "function" && win.electron.getWsProxyUrl()) || "";
    if (!wsProxyBase) return [];

    const clientId = this.globalClientId || "betterfluxer-rpc-emu";
    const urls = [];
    for (let port = 6463; port <= 6472; port += 1) {
      const target = `ws://127.0.0.1:${port}/?v=1&client_id=${encodeURIComponent(clientId)}`;
      urls.push({
        port,
        url: `${wsProxyBase}?target=${encodeURIComponent(target)}`
      });
    }
    return urls;
  }

  broadcastEvent(event, payload) {
    for (const client of Array.from(this.clients)) {
      try {
        client.emit(event, payload);
      } catch (_) {}
    }
  }

  maybeCaptureActivity(message) {
    const data = message && typeof message === "object" ? message.data || message : null;
    const activity =
      (data && data.activity) ||
      (data && data.activities && Array.isArray(data.activities) && data.activities[0]) ||
      null;
    if (!activity || typeof activity !== "object") return;
    this.lastBridgeActivity = activity;
    this.lastBridgeActivityAt = Date.now();
    this.api.storage.set("discordRpcEmu:lastActivity", activity);
    this.broadcastEvent("activityUpdate", activity);
    this.applyNowPlayingFromSources().catch(() => {});
  }

  connectBridge() {
    if (!this.bridgeStarted) return;
    if (this.bridgeSocket && this.bridgeSocket.readyState === 1) return;

    const urls = this.getBridgeUrls();
    if (!urls.length) {
      this.scheduleBridgeReconnect(10000);
      return;
    }

    const tryIndex = (index) => {
      if (!this.bridgeStarted) return;
      if (index >= urls.length) {
        this.api.logger.debug("DiscordRPCEmu: Discord RPC bridge not found, retrying.");
        this.scheduleBridgeReconnect(8000);
        return;
      }

      const candidate = urls[index];
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(candidate.url);
      } catch (_) {
        tryIndex(index + 1);
        return;
      }

      const fail = () => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch (_) {}
        tryIndex(index + 1);
      };

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        this.bridgeSocket = ws;
        this.bridgePort = candidate.port;
        this.api.logger.info(`DiscordRPCEmu: connected Discord RPC bridge on port ${candidate.port}`);
        try {
          ws.send(
            JSON.stringify({
              cmd: "SUBSCRIBE",
              evt: "ACTIVITY_JOIN",
              args: {},
              nonce: this.nextNonce()
            })
          );
        } catch (_) {}
      });

      ws.addEventListener("message", (event) => {
        try {
          const raw = typeof event.data === "string" ? event.data : "";
          if (!raw) return;
          const msg = JSON.parse(raw);
          this.broadcastEvent("discordRpcEvent", msg);
          this.maybeCaptureActivity(msg);
        } catch (_) {}
      });

      ws.addEventListener("error", () => {
        fail();
      });

      ws.addEventListener("close", () => {
        if (!settled) {
          fail();
          return;
        }
        if (this.bridgeSocket === ws) {
          this.bridgeSocket = null;
          this.bridgePort = null;
        }
        this.scheduleBridgeReconnect(5000);
      });

      setTimeout(() => {
        if (!settled) fail();
      }, 1800);
    };

    tryIndex(0);
  }
};
