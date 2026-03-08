class BaseDOMClass {
  constructor(appContext = {}) {
    this.appContext = appContext;
  }

  getWindow() {
    return this.appContext.getWindow ? this.appContext.getWindow() : globalThis.window;
  }

  getDocument() {
    return this.appContext.getDocument ? this.appContext.getDocument() : globalThis.document;
  }

  query(selector, root) {
    const target = root || this.getDocument();
    if (!target || typeof target.querySelector !== "function") return null;
    return target.querySelector(selector);
  }

  queryAll(selector, root) {
    const target = root || this.getDocument();
    if (!target || typeof target.querySelectorAll !== "function") return [];
    return Array.from(target.querySelectorAll(selector));
  }

  text(node) {
    return String(node?.textContent || "").trim();
  }
}

class SettingsSidebarClass extends BaseDOMClass {
  getContainer() {
    const selectors = [
      "nav[class*='sidebarNavWrapper'] [class*='sidebarNavList']",
      "[class*='SettingsModalLayout'][class*='sidebarNavList']",
      "nav [id^='settings-tab-']"
    ];
    for (const selector of selectors) {
      const node = this.query(selector);
      if (node) return node;
    }
    return null;
  }

  getItems() {
    const root = this.getContainer();
    if (!root) return [];
    const nodes = this.queryAll("button,a,[role='button']", root);
    return nodes
      .map((node) => {
        const rawId = String(node.id || "");
        const tabId = rawId.startsWith("settings-tab-") ? rawId.slice("settings-tab-".length) : rawId;
        const label = this.text(node);
        return { id: tabId, label, element: node };
      })
      .filter((item) => item.label || item.id);
  }

  resolveTabId(input) {
    const raw = String(input || "").trim().toLowerCase();
    if (!raw) return "";
    const aliases = {
      profile: "my_profile",
      account: "my_profile",
      security: "account_security",
      appearance: "appearance",
      lookandfeel: "appearance",
      look_feel: "appearance",
      look: "appearance",
      accessibility: "accessibility",
      messages: "chat_settings",
      media: "chat_settings",
      chat: "chat_settings",
      voice: "voice_video",
      audio: "voice_video",
      keybinds: "keybinds",
      notifications: "notifications",
      language: "language",
      advanced: "advanced",
      applications: "applications"
    };
    if (aliases[raw]) return aliases[raw];
    const direct = this.getItems().find((it) => String(it.id || "").toLowerCase() === raw);
    if (direct?.id) return direct.id;
    const byLabel = this.getItems().find((it) => String(it.label || "").trim().toLowerCase() === raw);
    return byLabel?.id || raw;
  }

  clickById(tabId) {
    const id = String(tabId || "").trim();
    if (!id) return false;
    const node = this.query(`#settings-tab-${id}`) || this.query(`#${id}`);
    if (!node || typeof node.click !== "function") return false;
    node.click();
    return true;
  }

  clickByLabel(label) {
    const needle = String(label || "").trim().toLowerCase();
    if (!needle) return false;
    const item = this.getItems().find((it) => String(it.label || "").trim().toLowerCase() === needle);
    if (!item?.element || typeof item.element.click !== "function") return false;
    item.element.click();
    return true;
  }

  openTab(idOrLabel) {
    const tabId = this.resolveTabId(idOrLabel);
    return this.clickById(tabId) || this.clickByLabel(idOrLabel);
  }

  getApplicationItems() {
    const known = new Set([
      "appearance",
      "accessibility",
      "chat_settings",
      "voice_video",
      "keybinds",
      "notifications",
      "language",
      "advanced"
    ]);
    return this.getItems().filter((it) => known.has(String(it.id || "").toLowerCase()));
  }
}

class UserProfileClass extends BaseDOMClass {
  constructor(appContext = {}) {
    super(appContext);
    this.currentUserData = null;
    this.listeners = new Set();
    this.fetchWrapped = false;
    this.originalFetch = null;
    this.fetchWrapper = null;
  }

  getSidebarName() {
    const node =
      this.query("#settings-tab-my_profile [class*='sidebarItemLabel']") ||
      this.query("#settings-tab-my_profile span");
    return this.text(node);
  }

  openProfileSettings() {
    const button = this.query("#settings-tab-my_profile");
    if (!button || typeof button.click !== "function") return false;
    button.click();
    return true;
  }

  getCurrentUser() {
    const data = this.getCurrentUserData();
    if (!data || typeof data !== "object") return null;
    return data.user || data;
  }

  getCurrentUserData() {
    return this.currentUserData;
  }

  getCurrentUserId() {
    const user = this.getCurrentUser();
    const fromPayload = String(user?.id || this.currentUserData?.id || "").trim();
    if (fromPayload) return fromPayload;
    const win = this.getWindow();
    return String(win?.localStorage?.getItem?.("user_id") || win?.localStorage?.getItem?.("fluxer_user_id") || "").trim();
  }

  captureCurrentUser() {
    if (this.currentUserData) return this.currentUserData;
    const win = this.getWindow();
    const userId =
      String(win?.localStorage?.getItem?.("user_id") || "").trim() ||
      String(win?.localStorage?.getItem?.("fluxer_user_id") || "").trim();
    if (!userId) return null;
    const fallback = { id: userId };
    this._emitUpdate("local-storage", fallback);
    return fallback;
  }

  fromDebugJson(jsonOrObject) {
    let payload = jsonOrObject;
    if (typeof jsonOrObject === "string") {
      payload = JSON.parse(jsonOrObject);
    }
    if (!payload || typeof payload !== "object") return null;
    this._emitUpdate("debug-json", payload);
    return payload;
  }

  onUpdate(callback) {
    if (typeof callback !== "function") return () => {};
    this.listeners.add(callback);
    if (this.currentUserData) {
      try {
        callback({ source: "current", data: this.currentUserData });
      } catch (_) {}
    }
    return () => this.listeners.delete(callback);
  }

  attachNetworkCapture() {
    if (this.fetchWrapped) return true;
    const win = this.getWindow();
    const originalFetch = win?.fetch;
    if (typeof originalFetch !== "function") return false;
    const self = this;
    this.originalFetch = originalFetch;
    this.fetchWrapper = async function userProfileCaptureFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const urlLike = args && args[0];
        const parsedUrl = self._asUrl(urlLike);
        if (
          parsedUrl &&
          /\/users\/[^/]+\/profile$/i.test(parsedUrl.pathname || "") &&
          response &&
          typeof response.clone === "function" &&
          response.ok
        ) {
          response
            .clone()
            .json()
            .then((json) => {
              if (json && typeof json === "object") {
                self._emitUpdate("network-profile", json);
              }
            })
            .catch(() => {});
        }
      } catch (_) {}
      return response;
    };
    win.fetch = this.fetchWrapper;
    this.fetchWrapped = true;
    return true;
  }

  _asUrl(urlLike) {
    try {
      const raw = String((urlLike && urlLike.url) || urlLike || "");
      if (!raw) return null;
      const win = this.getWindow();
      return new URL(raw, win?.location?.origin || "https://web.fluxer.app");
    } catch (_) {
      return null;
    }
  }

  _emitUpdate(source, data) {
    this.currentUserData = data;
    const snapshot = { source, data };
    for (const callback of this.listeners) {
      try {
        callback(snapshot);
      } catch (_) {}
    }
  }
}

class MessagesClass extends BaseDOMClass {
  getComposer() {
    return (
      this.query("textarea[data-channel-textarea='true']") ||
      this.query("textarea[class*='textarea']") ||
      this.query("textarea")
    );
  }

  getVisibleMessages() {
    const nodes = this.queryAll("[id^='message-content-'], [class*='Message'][class*='content']");
    return nodes.map((node) => ({
      id: String(node.id || ""),
      text: this.text(node),
      element: node
    }));
  }

  getVisibleMessageIds() {
    return this.getVisibleMessages()
      .map((m) => String(m.id || ""))
      .filter(Boolean);
  }

  getLastVisibleMessage() {
    const list = this.getVisibleMessages();
    return list.length ? list[list.length - 1] : null;
  }

  sendMessage(text) {
    const composer = this.getComposer();
    if (!composer) return false;
    composer.focus();
    const value = String(text == null ? "" : text);
    composer.value = value;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  }
}

class GuildListClass extends BaseDOMClass {
  getGuildItems() {
    const nodes = this.queryAll("a[href^='/channels/'][aria-label]");
    const seen = new Set();
    const items = [];
    for (const node of nodes) {
      const href = String(node.getAttribute("href") || "");
      const match = href.match(/^\/channels\/([^/]+)/);
      const guildId = match && match[1] ? match[1] : "";
      if (!guildId || guildId === "@me") continue;
      if (seen.has(guildId)) continue;
      seen.add(guildId);
      items.push({
        id: guildId,
        label: String(node.getAttribute("aria-label") || "").trim(),
        href,
        element: node
      });
    }
    return items;
  }

  clickGuildByName(name) {
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) return false;
    const item = this.getGuildItems().find((it) => String(it.label || "").toLowerCase().includes(needle));
    if (!item?.element || typeof item.element.click !== "function") return false;
    item.element.click();
    return true;
  }

  clickGuildById(guildId) {
    const id = String(guildId || "").trim();
    if (!id) return false;
    const item = this.getGuildItems().find((it) => String(it.id) === id);
    if (!item?.element || typeof item.element.click !== "function") return false;
    item.element.click();
    return true;
  }
}

class ChannelsClass extends BaseDOMClass {
  getChannelItems() {
    const nodes = this.queryAll("a[href*='/channels/']");
    const items = [];
    for (const node of nodes) {
      const href = String(node.getAttribute("href") || "");
      const m = href.match(/^\/channels\/([^/]+)\/([^/]+)/);
      if (!m) continue;
      const guildId = m[1];
      const channelId = m[2];
      if (!guildId || !channelId || channelId === "@me") continue;
      items.push({
        id: channelId,
        guildId,
        label: this.text(node),
        href,
        element: node
      });
    }
    return items;
  }

  clickChannelByName(name) {
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) return false;
    const item = this.getChannelItems().find((it) => String(it.label || "").toLowerCase().includes(needle));
    if (!item?.element || typeof item.element.click !== "function") return false;
    item.element.click();
    return true;
  }

  getCurrentRoute() {
    const location = this.appContext.getLocation ? this.appContext.getLocation() : this.getWindow()?.location;
    const path = String(location?.pathname || "");
    const guildMatch = path.match(/^\/channels\/([^/]+)\/([^/]+)/);
    if (guildMatch) {
      return {
        view: guildMatch[1] === "@me" ? "dm" : "guild",
        guildId: guildMatch[1] === "@me" ? "" : guildMatch[1],
        channelId: guildMatch[2] || "",
        path
      };
    }
    return { view: "unknown", guildId: "", channelId: "", path };
  }

  getCurrentGuildId() {
    return this.getCurrentRoute().guildId;
  }

  getCurrentChannelId() {
    return this.getCurrentRoute().channelId;
  }

  clickChannelById(channelId, guildId) {
    const cid = String(channelId || "").trim();
    if (!cid) return false;
    const gid = String(guildId || "").trim();
    let item = null;
    if (gid) {
      item = this.getChannelItems().find((it) => String(it.id) === cid && String(it.guildId) === gid);
    } else {
      item = this.getChannelItems().find((it) => String(it.id) === cid);
    }
    if (!item?.element || typeof item.element.click !== "function") return false;
    item.element.click();
    return true;
  }
}

class MembersClass extends BaseDOMClass {
  getMemberItems() {
    const nodes = this.queryAll(
      "span[class*='MemberListItem'][class*='name'], [data-user-id] span[class*='name'], [data-user-id]"
    );
    return nodes
      .map((node) => {
        const carrier = node.closest?.("[data-user-id]") || node;
        const userId = String(carrier?.getAttribute?.("data-user-id") || "");
        return {
          id: userId,
          label: this.text(node),
          element: node
        };
      })
      .filter((item) => item.label || item.id);
  }

  clickMemberByName(name) {
    const needle = String(name || "").trim().toLowerCase();
    if (!needle) return false;
    const item = this.getMemberItems().find((it) => String(it.label || "").toLowerCase().includes(needle));
    if (!item?.element || typeof item.element.click !== "function") return false;
    item.element.click();
    return true;
  }

  getVisibleMemberIds() {
    const out = [];
    const seen = new Set();
    for (const item of this.getMemberItems()) {
      const id = String(item.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  getMemberById(userId) {
    const id = String(userId || "").trim();
    if (!id) return null;
    return this.getMemberItems().find((it) => String(it.id) === id) || null;
  }

  clickMemberById(userId) {
    const item = this.getMemberById(userId);
    if (!item?.element || typeof item.element.click !== "function") return false;
    item.element.click();
    return true;
  }
}

class NavigationClass extends BaseDOMClass {
  getCurrentPath() {
    const location = this.appContext.getLocation ? this.appContext.getLocation() : this.getWindow()?.location;
    return String(location?.pathname || "");
  }

  navigateTo(pathName) {
    const win = this.getWindow();
    if (!win?.history || typeof win.history.pushState !== "function") return false;
    const target = String(pathName || "").trim();
    if (!target.startsWith("/")) return false;
    win.history.pushState({}, "", target);
    win.dispatchEvent(new PopStateEvent("popstate"));
    return true;
  }

  parseRoute(pathName) {
    const path = String(pathName || this.getCurrentPath() || "");
    const channels = path.match(/^\/channels\/([^/]+)\/([^/]+)/);
    if (channels) {
      if (channels[1] === "@me") {
        return { type: "dm", guildId: "", channelId: channels[2], path };
      }
      return { type: "channel", guildId: channels[1], channelId: channels[2], path };
    }
    if (/^\/settings/.test(path)) {
      return { type: "settings", guildId: "", channelId: "", path };
    }
    return { type: "unknown", guildId: "", channelId: "", path };
  }

  navigateToChannel(guildId, channelId) {
    const gid = String(guildId || "").trim();
    const cid = String(channelId || "").trim();
    if (!gid || !cid) return false;
    return this.navigateTo(`/channels/${gid}/${cid}`);
  }

  navigateToDm(channelId) {
    const cid = String(channelId || "").trim();
    if (!cid) return false;
    return this.navigateTo(`/channels/@me/${cid}`);
  }
}

class ModalsClass extends BaseDOMClass {
  getOpenModals() {
    const nodes = this.queryAll("[class*='Modal'][class*='surface'], [role='dialog']");
    return nodes.map((node, index) => ({ index, element: node, text: this.text(node).slice(0, 120) }));
  }

  closeTopModal() {
    const modals = this.getOpenModals();
    if (!modals.length) return false;
    const doc = this.getDocument();
    const close =
      doc?.querySelector("button[aria-label='Close']") ||
      doc?.querySelector("button[class*='closeButton']") ||
      doc?.querySelector("[role='dialog'] button");
    if (!close || typeof close.click !== "function") return false;
    close.click();
    return true;
  }
}

function createUIApi(appContext = {}) {
  const classes = {
    BaseDOMClass,
    SettingsSidebarClass,
    UserProfileClass,
    MessagesClass,
    GuildListClass,
    ChannelsClass,
    MembersClass,
    NavigationClass,
    ModalsClass
  };

  const ui = {
    settingsSidebar: new SettingsSidebarClass(appContext),
    userProfile: new UserProfileClass(appContext),
    messages: new MessagesClass(appContext),
    guildList: new GuildListClass(appContext),
    channels: new ChannelsClass(appContext),
    members: new MembersClass(appContext),
    navigation: new NavigationClass(appContext),
    modals: new ModalsClass(appContext)
  };

  ui.userList = ui.members;
  ui.userProfile.attachNetworkCapture();

  return { ui, classes };
}

module.exports = {
  BaseDOMClass,
  SettingsSidebarClass,
  UserProfileClass,
  MessagesClass,
  GuildListClass,
  ChannelsClass,
  MembersClass,
  NavigationClass,
  ModalsClass,
  createUIApi
};
