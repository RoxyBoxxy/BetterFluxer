class BetterFluxerUserData {
  constructor(payload) {
    this.payload = payload && typeof payload === "object" ? payload : {};
  }

  get(path, fallback = null) {
    const parts = String(path || "").split(".").filter(Boolean);
    let cur = this.payload;
    for (const part of parts) {
      if (!cur || typeof cur !== "object") return fallback;
      cur = cur[part];
    }
    return cur == null ? fallback : cur;
  }

  getImageUrl() {
    const userId = String(this.get("user.id", "") || "");
    const avatar = String(this.get("user.avatar", "") || "");
    if (!userId || !avatar) return "";
    return `https://cdn.fluxer.app/avatars/${userId}/${avatar}.png?size=128`;
  }

  GetUser(key) {
    const field = String(key || "").trim().toLowerCase();
    if (!field) return null;
    if (field === "image" || field === "avatar" || field === "avatarurl") {
      return this.getImageUrl() || this.get("user.avatar", "");
    }
    if (field === "pronouns") {
      return this.get("user_profile.pronouns", "") || this.get("profile.pronouns", "");
    }
    if (field === "bio") {
      return this.get("user_profile.bio", "") || this.get("profile.bio", "");
    }
    if (field === "username") {
      return this.get("user.username", "");
    }
    if (field === "global_name" || field === "displayname") {
      return this.get("user.global_name", "") || this.get("user.username", "");
    }
    if (field === "id" || field === "userid") {
      return this.get("user.id", "");
    }
    return this.get(field, null);
  }
}

module.exports = class PronounsInChatPlugin {
  constructor(api) {
    this.api = api;
    this.styleId = "betterfluxer-pronouns-style";
    this.badgeClass = "betterfluxer-pronouns-badge";
    this.badgeAttr = "data-bf-pronouns-badge";
    this.scanAttr = "data-bf-pronouns-scanned";
    this.observer = null;
    this.cache = new Map();
    this.profileCache = new Map();
    this.pending = new Map();
    this.lastKey = null;
    this.globalAccessorKey = "__betterFluxerUserAccessor";
    this.authBlockedUntil = 0;
    this.authWarned = false;
    this.remoteAuthWarned = false;
    this.retryTimers = new WeakMap();
    this.retryDelayMs = 30000;
    this.globalUserKeySuffix = "*";
    this.maxCacheEntries = 2500;
    this.maxProfileEntries = 1000;
    this.fetchWrapped = false;
    this.originalFetch = null;
    this.fetchWrapper = null;
    this.flushTimer = null;
    this.lastFlushAt = 0;
    this.profileUnsubscribe = null;
  }

  start() {
    const doc = this.api.app.getDocument?.();
    if (!doc) return;
    this.loadConfig();
    this.loadPersistentCaches();
    this.injectStyle(doc);
    this.exposeGlobalAccessor();
    this.installProfileCapture();
    this.scan(doc);
    this.installObserver(doc);
    this.api.logger.info("PronounsInChat enabled.");
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    const doc = this.api.app.getDocument?.();
    const style = doc?.getElementById(this.styleId);
    if (style) style.remove();
    const badges = doc?.querySelectorAll(`.${this.badgeClass}[${this.badgeAttr}='1']`) || [];
    for (const badge of badges) {
      badge.remove();
    }
    const marked = doc?.querySelectorAll(`[${this.scanAttr}='1']`) || [];
    for (const node of marked) {
      node.removeAttribute(this.scanAttr);
    }
    this.pending.clear();
    this.cache.clear();
    this.profileCache.clear();
    this.lastKey = null;
    this.authBlockedUntil = 0;
    this.authWarned = false;
    this.remoteAuthWarned = false;
    this.clearRetryTimers();
    this.uninstallProfileCapture();
    this.flushPersistentCaches(true);
    this.unexposeGlobalAccessor();
    this.api.logger.info("PronounsInChat disabled.");
  }

  injectStyle(doc) {
    if (doc.getElementById(this.styleId)) return;
    const style = doc.createElement("style");
    style.id = this.styleId;
    style.textContent = [
      `.${this.badgeClass}{`,
      "  margin-left:0;",
      "  display:inline-flex;",
      "  align-items:center;",
      "  vertical-align:middle;",
      "  opacity:0.9;",
      "}",
      `.${this.badgeClass} .betterfluxer-pronouns-text{`,
      "  color:var(--text-muted, rgba(255,255,255,0.65));",
      "  font-weight:500;",
      "}",
      `.${this.badgeClass} .betterfluxer-pronouns-sep{`,
      "  margin:0 2px;",
      "  color:var(--text-muted, rgba(255,255,255,0.65));",
      "}",
      `.${this.badgeClass}:empty{display:none;}`
    ].join("\n");
    doc.head.appendChild(style);
  }

  installObserver(doc) {
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes || []) {
          if (!node || node.nodeType !== 1) continue;
          this.scan(node);
        }
      }
    });
    this.observer.observe(doc.documentElement || doc.body, { childList: true, subtree: true });
  }

  scan(root) {
    if (!root || !root.querySelectorAll) return;
    const spans = root.querySelectorAll("span[data-user-id], span[class*='MemberListItem'][class*='name']");
    for (const span of spans) {
      const cls = String(span.className || "").toLowerCase();
      const isMessageUsername = cls.includes("message") && cls.includes("username");
      const isMemberListName = cls.includes("memberlistitem") && cls.includes("name");
      if (!isMessageUsername && !isMemberListName) continue;
      if (span.getAttribute(this.scanAttr) === "1") continue;
      span.setAttribute(this.scanAttr, "1");
      this.attachPronouns(span);
    }
  }

  resolveUserId(span) {
    const direct = span?.getAttribute?.("data-user-id");
    if (direct) return String(direct);

    const attrCarrier = span?.closest?.("[data-user-id]");
    const fromCarrier = attrCarrier?.getAttribute?.("data-user-id");
    if (fromCarrier) return String(fromCarrier);

    const idCarrier = span?.closest?.("[id]");
    const rawId = String(idCarrier?.id || "");
    const idMatch = rawId.match(/(\d{16,21})/);
    if (idMatch && idMatch[1]) return String(idMatch[1]);

    return "";
  }

  getKey(userId, guildId) {
    const uid = String(userId || "");
    const gid = String(guildId || "") || this.globalUserKeySuffix;
    return `${uid}:${gid}`;
  }

  extractPronouns(payload) {
    if (!payload || typeof payload !== "object") return "";
    const value =
      payload.guild_member_profile?.pronouns ||
      payload.user_profile?.pronouns ||
      payload.profile?.pronouns ||
      payload.guild_member?.pronouns ||
      payload.user?.pronouns ||
      payload.pronouns ||
      "";
    return String(value || "").trim();
  }

  parseProfileRoute(urlLike) {
    try {
      const raw = String((urlLike && urlLike.url) || urlLike || "");
      if (!raw) return null;
      const win = this.api.app.getWindow?.();
      const parsed = new URL(raw, win?.location?.origin || "https://web.fluxer.app");
      const path = String(parsed.pathname || "");
      if (!/\/users\/[^/]+\/profile$/i.test(path)) return null;
      const match = path.match(/\/users\/([^/]+)\/profile$/i);
      const userId = match && match[1] ? decodeURIComponent(match[1]) : "";
      const guildId = parsed.searchParams.get("guild_id") || "";
      return {
        userId: String(userId || ""),
        guildId: String(guildId || ""),
        url: parsed.toString()
      };
    } catch (_e) {
      return null;
    }
  }

  getUserIdFromPayload(payload) {
    if (!payload || typeof payload !== "object") return "";
    const direct =
      payload.user?.id ||
      payload.id ||
      payload.member?.user?.id ||
      payload.guild_member?.user?.id ||
      payload.profile?.id ||
      "";
    return String(direct || "");
  }

  trimMap(map, maxEntries) {
    if (!map || typeof map.size !== "number") return;
    const limit = Number(maxEntries || 0);
    if (!limit || map.size <= limit) return;
    const removeCount = map.size - limit;
    let i = 0;
    for (const key of map.keys()) {
      map.delete(key);
      i += 1;
      if (i >= removeCount) break;
    }
  }

  queueFlush() {
    const now = Date.now();
    if (now - this.lastFlushAt > 5000) {
      this.flushPersistentCaches();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPersistentCaches();
    }, 1500);
  }

  flushPersistentCaches(force) {
    if (!this.api?.storage) return;
    if (this.flushTimer && force) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.trimMap(this.cache, this.maxCacheEntries);
      this.trimMap(this.profileCache, this.maxProfileEntries);
      this.api.storage.set(
        "pronounsByKey",
        Object.fromEntries(Array.from(this.cache.entries()).filter((entry) => entry[0] && typeof entry[1] === "string"))
      );
      this.api.storage.set(
        "profileByKey",
        Object.fromEntries(Array.from(this.profileCache.entries()).filter((entry) => entry[0] && entry[1] && typeof entry[1] === "object"))
      );
      this.lastFlushAt = Date.now();
    } catch (_e) {}
  }

  loadPersistentCaches() {
    if (!this.api?.storage) return;
    try {
      const pronounsRaw = this.api.storage.get("pronounsByKey", {});
      if (pronounsRaw && typeof pronounsRaw === "object") {
        for (const [k, v] of Object.entries(pronounsRaw)) {
          if (!k) continue;
          const value = String(v || "").trim();
          this.cache.set(k, value);
        }
      }
    } catch (_e) {}
    try {
      const profilesRaw = this.api.storage.get("profileByKey", {});
      if (profilesRaw && typeof profilesRaw === "object") {
        for (const [k, v] of Object.entries(profilesRaw)) {
          if (!k || !v || typeof v !== "object") continue;
          this.profileCache.set(k, v);
        }
      }
    } catch (_e) {}
    this.trimMap(this.cache, this.maxCacheEntries);
    this.trimMap(this.profileCache, this.maxProfileEntries);
  }

  cachePayload(payload, hintedUserId, hintedGuildId, source) {
    if (!payload || typeof payload !== "object") return;
    const pronouns = this.extractPronouns(payload);
    const userId = String(hintedUserId || this.getUserIdFromPayload(payload) || "");
    const guildId = String(hintedGuildId || "");
    if (!userId) return;

    const scopedKey = this.getKey(userId, guildId);
    const globalKey = this.getKey(userId, this.globalUserKeySuffix);

    this.profileCache.set(globalKey, payload);
    this.profileCache.set(scopedKey, payload);
    if (pronouns) {
      this.cache.set(globalKey, pronouns);
      this.cache.set(scopedKey, pronouns);
    } else if (!this.cache.has(scopedKey)) {
      this.cache.set(scopedKey, "");
    }

    this.lastKey = scopedKey;
    this.queueFlush();

    if (source && pronouns) {
      this.api.logger.debug?.(`PronounsInChat cache hit from ${source}: ${userId} (${guildId || "*"}) -> ${pronouns}`);
    }
  }

  installProfileCapture() {
    const win = this.api.app.getWindow?.();
    if (!win) return;

    const originalFetch = win.fetch;
    if (typeof originalFetch === "function" && !this.fetchWrapped) {
      const plugin = this;
      this.originalFetch = originalFetch;
      this.fetchWrapper = async function pronounsCacheFetchWrapper(...args) {
        const response = await originalFetch.apply(this, args);
        try {
          const route = plugin.parseProfileRoute(args && args[0]);
          if (route && response && typeof response.clone === "function" && response.ok) {
            response
              .clone()
              .json()
              .then((json) => plugin.cachePayload(json, route.userId, route.guildId, "fetch-profile"))
              .catch(() => {});
          }
        } catch (_e) {}
        return response;
      };
      win.fetch = this.fetchWrapper;
      this.fetchWrapped = true;
    }

    const userProfile = this.api?.ui?.userProfile;
    if (userProfile && typeof userProfile.onUpdate === "function") {
      this.profileUnsubscribe = userProfile.onUpdate((snapshot) => {
        const data = snapshot?.data;
        this.cachePayload(data, data?.id || data?.user?.id || "", "", "ui-userProfile");
      });
    }
  }

  uninstallProfileCapture() {
    const win = this.api.app.getWindow?.();
    if (this.fetchWrapped && win && this.originalFetch && win.fetch === this.fetchWrapper) {
      win.fetch = this.originalFetch;
    }
    this.fetchWrapped = false;
    this.originalFetch = null;
    this.fetchWrapper = null;
    if (typeof this.profileUnsubscribe === "function") {
      try {
        this.profileUnsubscribe();
      } catch (_e) {}
    }
    this.profileUnsubscribe = null;
  }

  clearRetryTimers() {
    const doc = this.api.app.getDocument?.();
    if (!doc || !doc.querySelectorAll) return;
    const marked = doc.querySelectorAll(`[${this.scanAttr}='1']`);
    for (const node of marked) {
      const timer = this.retryTimers.get(node);
      if (timer) {
        clearTimeout(timer);
        this.retryTimers.delete(node);
      }
    }
  }

  scheduleRetry(span) {
    if (!span || !span.isConnected) return;
    const existing = this.retryTimers.get(span);
    if (existing) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(span);
      if (!span.isConnected) return;
      span.removeAttribute(this.scanAttr);
      this.scan(span.parentElement || span);
    }, this.retryDelayMs);
    this.retryTimers.set(span, timer);
  }

  resolveGuildId(span) {
    const direct = span?.getAttribute?.("data-guild-id");
    if (direct) return String(direct);
    const fromParent = span?.closest?.("[data-guild-id]")?.getAttribute?.("data-guild-id");
    if (fromParent) return String(fromParent);
    const win = this.api.app.getWindow?.();
    const path = String(win?.location?.pathname || "");
    const match = path.match(/\/channels\/(\d+)\//);
    if (path.includes("/channels/@me/")) return "";
    return match && match[1] ? String(match[1]) : "";
  }

  exposeGlobalAccessor() {
    const win = this.api.app.getWindow?.();
    if (!win) return;
    const plugin = this;
    win[this.globalAccessorKey] = {
      get(userId, guildId) {
        const key = plugin.getKey(userId, guildId);
        const payload = plugin.profileCache.get(key);
        return new BetterFluxerUserData(payload || {});
      },
      fromPayload(payload) {
        return new BetterFluxerUserData(payload || {});
      },
      GetUser(field, userId, guildId) {
        const key = userId ? plugin.getKey(userId, guildId) : plugin.lastKey;
        const payload = key ? plugin.profileCache.get(key) : null;
        const accessor = new BetterFluxerUserData(payload || {});
        return accessor.GetUser(field);
      }
    };
    win.GetUser = (field, userId, guildId) => win[this.globalAccessorKey].GetUser(field, userId, guildId);
  }

  unexposeGlobalAccessor() {
    const win = this.api.app.getWindow?.();
    if (!win) return;
    try {
      if (win.GetUser) delete win.GetUser;
    } catch (_) {}
    try {
      if (win[this.globalAccessorKey]) delete win[this.globalAccessorKey];
    } catch (_) {}
  }

  getAuthToken() {
    const win = this.api.app.getWindow?.();
    const ls = win?.localStorage;
    if (!ls || typeof ls.getItem !== "function") return "";
    const raw =
      ls.getItem("token") ||
      ls.getItem("fluxer_token") ||
      ls.getItem("auth_token") ||
      "";
    const token = String(raw || "").trim();
    if (!token) return "";
    if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  }

  buildAuthHeaders() {
    const token = this.getAuthToken();
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = token;
    return headers;
  }

  async fetchPronouns(userId, guildId) {
    const key = this.getKey(userId, guildId);
    if (this.cache.has(key)) return this.cache.get(key);
    const userFallbackKey = this.getKey(userId, this.globalUserKeySuffix);
    if (this.cache.has(userFallbackKey)) return this.cache.get(userFallbackKey);
    if (this.pending.has(key)) return this.pending.get(key);
    if (Date.now() < this.authBlockedUntil) return "";

    const win = this.api.app.getWindow?.();
    const user = encodeURIComponent(String(userId || ""));
    const guild = encodeURIComponent(String(guildId || ""));
    const apiBase = "https://web.fluxer.app/api/v1";
    const urls = [
      `${apiBase}/users/${user}/profile?guild_id=${guild}&with_mutual_friends=true&with_mutual_guilds=true`,
      `${apiBase}/users/${user}/profile?guild_id=${guild}&with_mutual_friends=false&with_mutual_guilds=false`,
      `${apiBase}/users/${user}/profile`,
      `/api/v1/users/${user}/profile?guild_id=${guild}&with_mutual_friends=true&with_mutual_guilds=true`,
      `/api/v1/users/${user}/profile?guild_id=${guild}&with_mutual_friends=false&with_mutual_guilds=false`,
      `/api/v1/users/${user}/profile?guild_id=${guild}`,
      `/api/v1/users/${user}/profile`
    ];

    const task = (async () => {
      const headers = this.buildAuthHeaders();
      if (!headers.Authorization && !this.authWarned) {
        this.api.logger.warn("PronounsInChat: auth token not found; profile endpoint likely returns 401.");
        this.authWarned = true;
      }
      let sawAuthError = false;
      for (const url of urls) {
        try {
          const res = await win.fetch(url, {
            method: "GET",
            credentials: "include",
            headers
          });
          if (!res) continue;
          if (res.status === 401 || res.status === 403) {
            sawAuthError = true;
            this.authBlockedUntil = Date.now() + 30000;
            if (!this.remoteAuthWarned) {
              this.api.logger.warn("PronounsInChat: profile API unauthorized; backing off remote fetch and retrying later.");
              this.remoteAuthWarned = true;
            }
            break;
          }
          if (!res.ok) continue;
          const json = await res.json();
          this.cachePayload(json || {}, userId, guildId, "remote-fetch");
          const pronouns = this.extractPronouns(json);
          if (!pronouns && this.cache.has(userFallbackKey)) {
            return this.cache.get(userFallbackKey) || "";
          }
          return pronouns || "";
        } catch (_) {}
      }
      if (sawAuthError) {
        this.cache.set(key, "");
        this.queueFlush();
        return "";
      }
      this.cache.set(key, "");
      this.queueFlush();
      return "";
    })();

    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      this.pending.delete(key);
    }
  }

  findOrCreateBadge(span) {
    const existing = span.nextElementSibling;
    if (existing && existing.getAttribute?.(this.badgeAttr) === "1") return existing;
    const userId = this.resolveUserId(span);
    const siblingExisting = span.parentElement?.querySelector?.(
      `.${this.badgeClass}[${this.badgeAttr}='1'][data-bf-user-id='${String(userId || "")}']`
    );
    if (siblingExisting) return siblingExisting;
    const doc = this.api.app.getDocument?.();
    if (!doc) return null;

    const badge = doc.createElement("span");
    badge.className = this.badgeClass;
    badge.setAttribute(this.badgeAttr, "1");
    badge.setAttribute("data-bf-user-id", String(userId || ""));
    const className = String(span.className || "").toLowerCase();
    const isMessageUsername = className.includes("message") && className.includes("username");

    let sep = null;
    if (isMessageUsername) {
      sep = doc.createElement("span");
      sep.className = "betterfluxer-pronouns-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = " — ";
      const timeSep =
        span.parentElement?.querySelector?.("time span[class*='authorDashSeparator']") ||
        span.parentElement?.querySelector?.("time span[aria-hidden='true'][class*='DashSeparator']");
      if (timeSep && timeSep.className) {
        sep.className = String(timeSep.className);
      }
    }

    const text = doc.createElement("span");
    text.className = "betterfluxer-pronouns-text";
    if (sep) badge.appendChild(sep);
    badge.appendChild(text);

    const timeEl = span.parentElement?.querySelector?.("time");
    const win = this.api.app.getWindow?.();
    if (timeEl && win?.getComputedStyle) {
      const style = win.getComputedStyle(timeEl);
      if (style?.fontSize) badge.style.fontSize = style.fontSize;
      if (style?.lineHeight) badge.style.lineHeight = style.lineHeight;
      if (style?.fontWeight) text.style.fontWeight = style.fontWeight;
      if (style?.color) text.style.color = style.color;
    }

    span.insertAdjacentElement("afterend", badge);
    if (existing) return existing;
    return badge;
  }

  async attachPronouns(span) {
    const userId = this.resolveUserId(span);
    const guildId = this.resolveGuildId(span);
    if (!userId) return;

    const pronouns = await this.fetchPronouns(userId, guildId);
    if (!span.isConnected) return;
    if (!pronouns) {
      this.scheduleRetry(span);
      return;
    }

    const badge = this.findOrCreateBadge(span);
    if (!badge) return;
    const text = badge.querySelector(".betterfluxer-pronouns-text") || badge;
    text.textContent = pronouns;
    badge.title = `Pronouns: ${pronouns}`;
    const pendingRetry = this.retryTimers.get(span);
    if (pendingRetry) {
      clearTimeout(pendingRetry);
      this.retryTimers.delete(span);
    }
  }

  loadConfig() {
    try {
      const retry = Number(this.api.storage.get("retryDelayMs", this.retryDelayMs));
      const maxPronouns = Number(this.api.storage.get("maxCacheEntries", this.maxCacheEntries));
      const maxProfiles = Number(this.api.storage.get("maxProfileEntries", this.maxProfileEntries));
      if (Number.isFinite(retry) && retry >= 1000) this.retryDelayMs = Math.round(retry);
      if (Number.isFinite(maxPronouns) && maxPronouns >= 100) this.maxCacheEntries = Math.round(maxPronouns);
      if (Number.isFinite(maxProfiles) && maxProfiles >= 100) this.maxProfileEntries = Math.round(maxProfiles);
    } catch (_e) {}
  }

  getSettingsSchema() {
    return {
      title: "Pronouns In Chat",
      description: "Caching and retry settings for pronoun badges.",
      controls: [
        {
          key: "retryDelayMs",
          type: "range",
          label: "Retry delay (ms)",
          min: 1000,
          max: 120000,
          step: 1000,
          value: this.retryDelayMs
        },
        {
          key: "maxCacheEntries",
          type: "range",
          label: "Pronoun cache size",
          min: 100,
          max: 10000,
          step: 100,
          value: this.maxCacheEntries
        },
        {
          key: "maxProfileEntries",
          type: "range",
          label: "Profile cache size",
          min: 100,
          max: 5000,
          step: 100,
          value: this.maxProfileEntries
        }
      ]
    };
  }

  setSettingValue(key, value) {
    const k = String(key || "");
    if (k === "retryDelayMs") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1000) this.retryDelayMs = Math.round(n);
    }
    if (k === "maxCacheEntries") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 100) this.maxCacheEntries = Math.round(n);
    }
    if (k === "maxProfileEntries") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 100) this.maxProfileEntries = Math.round(n);
    }
    try {
      this.api.storage.set("retryDelayMs", this.retryDelayMs);
      this.api.storage.set("maxCacheEntries", this.maxCacheEntries);
      this.api.storage.set("maxProfileEntries", this.maxProfileEntries);
    } catch (_e) {}
    return {
      retryDelayMs: this.retryDelayMs,
      maxCacheEntries: this.maxCacheEntries,
      maxProfileEntries: this.maxProfileEntries
    };
  }
};
