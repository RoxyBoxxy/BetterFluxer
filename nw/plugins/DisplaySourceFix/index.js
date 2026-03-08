module.exports = class DisplaySourceFixPlugin {
  constructor(api) {
    this.api = api;
    this.originalSelect = null;
    this.originalGetDisplayMedia = null;
    this.originalGetUserMedia = null;
    this.onDisplayMediaRequestedUnsub = null;
    this.lastGoodSourceId = null;
    this.pendingRequest = null;
    this.pendingPickerResolve = null;
    this.overlayId = "betterfluxer-display-picker-overlay";
    this.styleId = "betterfluxer-display-picker-style";
    this.cache = {
      types: ["screen", "window"],
      sources: [],
      at: 0
    };
    this.includeScreens = true;
    this.includeWindows = true;
  }

  getElectronApi() {
    return this.api.app.getWindow?.()?.electron;
  }

  async refreshSources() {
    const electronApi = this.getElectronApi();
    if (!electronApi || typeof electronApi.getDesktopSources !== "function") {
      return [];
    }
    try {
      this.cache.types = this.getSourceTypes();
      const sources = await electronApi.getDesktopSources(this.cache.types);
      if (Array.isArray(sources)) {
        this.cache.sources = sources;
        this.cache.at = Date.now();
      }
    } catch (error) {
      this.api.logger.warn("Failed to refresh desktop sources:", error?.message || error);
    }
    return this.cache.sources;
  }

  findFallbackSourceId(requestedId) {
    const id = String(requestedId || "");
    const sources = this.cache.sources || [];
    if (sources.length === 0) {
      if (this.lastGoodSourceId) return this.lastGoodSourceId;
      if (id.startsWith("window:")) return "screen:0:0";
      return null;
    }

    const exact = sources.find((item) => String(item?.id || "") === id);
    if (exact) return exact.id;

    const prefix = id.includes(":") ? id.split(":")[0] : "";
    if (prefix) {
      const samePrefix = sources.find((item) => String(item?.id || "").startsWith(`${prefix}:`));
      if (samePrefix) return samePrefix.id;
    }

    const preferredScreen = sources.find((item) => String(item?.id || "").startsWith("screen:"));
    if (preferredScreen) return String(preferredScreen.id || "");

    return String(sources[0]?.id || this.lastGoodSourceId || "");
  }

  ensurePickerStyle(doc) {
    if (doc.getElementById(this.styleId)) return;
    const style = doc.createElement("style");
    style.id = this.styleId;
    style.textContent = [
      ".bf-dsp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:2147483647;display:flex;align-items:center;justify-content:center;}",
      ".bf-dsp-modal{width:min(860px,96vw);max-height:88vh;overflow:auto;background:#15181d;border:1px solid #2b3139;border-radius:12px;color:#f4f6f8;padding:14px;box-shadow:0 28px 70px rgba(0,0,0,.5);font-family:Segoe UI,Tahoma,sans-serif;}",
      ".bf-dsp-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}",
      ".bf-dsp-head h3{margin:0;font-size:16px;}",
      ".bf-dsp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;}",
      ".bf-dsp-card{background:#1b2027;border:1px solid #2b3139;border-radius:10px;padding:10px;display:grid;gap:8px;}",
      ".bf-dsp-name{font-size:13px;color:#d7dee7;word-break:break-word;}",
      ".bf-dsp-id{font-size:11px;color:#9cacbe;word-break:break-word;}",
      ".bf-dsp-btn{border:1px solid #3c4754;background:#26313d;color:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;}",
      ".bf-dsp-btn:hover{background:#304050;}",
      ".bf-dsp-foot{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:10px;}",
      ".bf-dsp-muted{font-size:12px;color:#9cacbe;}"
    ].join("");
    doc.head.appendChild(style);
  }

  closePicker() {
    const doc = this.api.app.getDocument?.();
    if (!doc) return;
    const overlay = doc.getElementById(this.overlayId);
    if (overlay) overlay.remove();
    if (typeof this.pendingPickerResolve === "function") {
      const resolve = this.pendingPickerResolve;
      this.pendingPickerResolve = null;
      resolve(null);
    }
    this.pendingRequest = null;
  }

  selectForRequest(requestId, sourceId, withAudio) {
    const chosen = String(sourceId || "");
    if (!chosen) return;

    if (requestId && this.originalSelect) {
      this.originalSelect(requestId, chosen, withAudio);
    }

    if (typeof this.pendingPickerResolve === "function") {
      const resolve = this.pendingPickerResolve;
      this.pendingPickerResolve = null;
      const selected = (this.cache.sources || []).find((item) => String(item?.id || "") === chosen) || { id: chosen };
      resolve(selected);
    }

    this.lastGoodSourceId = chosen;
    const doc = this.api.app.getDocument?.();
    const overlay = doc?.getElementById(this.overlayId);
    if (overlay) overlay.remove();
    this.pendingRequest = null;
  }

  async showPicker(requestId, info) {
    const doc = this.api.app.getDocument?.();
    if (!doc) return;

    await this.refreshSources();
    const sources = this.cache.sources || [];
    if (!Array.isArray(sources) || sources.length === 0) {
      this.api.logger.warn("No desktop sources available for custom picker.");
      return;
    }

    this.closePicker();
    this.ensurePickerStyle(doc);

    const overlay = doc.createElement("div");
    overlay.id = this.overlayId;
    overlay.className = "bf-dsp-overlay";

    const modal = doc.createElement("div");
    modal.className = "bf-dsp-modal";
    overlay.appendChild(modal);

    const head = doc.createElement("div");
    head.className = "bf-dsp-head";
    head.innerHTML = "<h3>Select Window Or Screen</h3>";
    const closeBtn = doc.createElement("button");
    closeBtn.className = "bf-dsp-btn";
    closeBtn.textContent = "Cancel";
    closeBtn.addEventListener("click", () => {
      this.closePicker();
    });
    head.appendChild(closeBtn);
    modal.appendChild(head);

    const grid = doc.createElement("div");
    grid.className = "bf-dsp-grid";
    modal.appendChild(grid);

    for (const source of sources) {
      const id = String(source?.id || "");
      if (!id) continue;
      const name = String(source?.name || id);
      const card = doc.createElement("div");
      card.className = "bf-dsp-card";

      const title = doc.createElement("div");
      title.className = "bf-dsp-name";
      title.textContent = name;
      card.appendChild(title);

      const sub = doc.createElement("div");
      sub.className = "bf-dsp-id";
      sub.textContent = id;
      card.appendChild(sub);

      const selectBtn = doc.createElement("button");
      selectBtn.className = "bf-dsp-btn";
      selectBtn.textContent = "Share This";
      selectBtn.addEventListener("click", () => {
        this.selectForRequest(requestId, id, Boolean(info?.withAudio));
      });
      card.appendChild(selectBtn);

      grid.appendChild(card);
    }

    const foot = doc.createElement("div");
    foot.className = "bf-dsp-foot";
    const muted = doc.createElement("div");
    muted.className = "bf-dsp-muted";
    muted.textContent = "Custom picker by BetterFluxer";
    foot.appendChild(muted);
    const fallbackBtn = doc.createElement("button");
    fallbackBtn.className = "bf-dsp-btn";
    fallbackBtn.textContent = "Use Fallback";
    fallbackBtn.addEventListener("click", () => {
      const fallback = this.findFallbackSourceId("screen:0:0") || "screen:0:0";
      this.selectForRequest(requestId, fallback, Boolean(info?.withAudio));
    });
    foot.appendChild(fallbackBtn);
    modal.appendChild(foot);

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) this.closePicker();
    });
    doc.body.appendChild(overlay);

    this.pendingRequest = { requestId, withAudio: Boolean(info?.withAudio) };
  }

  async pickSourceFromOverlay() {
    await this.showPicker(null, { withAudio: false });
    return new Promise((resolve) => {
      this.pendingPickerResolve = resolve;
    });
  }

  async captureViaCustomPicker(constraints) {
    const win = this.api.app.getWindow?.();
    const mediaDevices = win?.navigator?.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
      throw new Error("mediaDevices.getUserMedia unavailable");
    }

    const selected = await this.pickSourceFromOverlay();
    if (!selected || !selected.id) {
      throw new Error("Display capture canceled");
    }

    const selectedId = String(selected.id);
    const wantsAudio = Boolean(constraints && constraints.audio);
    const videoTrack = {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: selectedId
      }
    };

    const userMediaConstraints = {
      video: videoTrack,
      audio: false
    };

    // System audio capture support varies across Linux setups; keep it optional.
    if (wantsAudio) {
      userMediaConstraints.audio = {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: selectedId
        }
      };
    }

    return mediaDevices.getUserMedia(userMediaConstraints);
  }

  start() {
    const win = this.api.app.getWindow?.();
    this.loadConfig();
    const electronApi = this.getElectronApi();
    const mediaDevices = win?.navigator?.mediaDevices;
    const hasSelectDisplayMediaSource = Boolean(electronApi && typeof electronApi.selectDisplayMediaSource === "function");
    const hasGetDisplayMedia = Boolean(mediaDevices && typeof mediaDevices.getDisplayMedia === "function");
    const hasGetDesktopSources = Boolean(electronApi && typeof electronApi.getDesktopSources === "function");

    if (!hasGetDisplayMedia) {
      this.api.logger.warn("navigator.mediaDevices.getDisplayMedia is unavailable; plugin inactive.");
      return;
    }

    if (!hasGetDesktopSources) {
      this.api.logger.warn("electron.getDesktopSources is unavailable; custom picker cannot list sources.");
    }

    if (hasSelectDisplayMediaSource) {
      this.originalSelect = electronApi.selectDisplayMediaSource.bind(electronApi);
    }
    if (mediaDevices && typeof mediaDevices.getDisplayMedia === "function") {
      this.originalGetDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
    }
    if (mediaDevices && typeof mediaDevices.getUserMedia === "function") {
      this.originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    }

    this.refreshSources();

    if (mediaDevices && this.originalGetDisplayMedia) {
      mediaDevices.getDisplayMedia = async (constraints = { video: true, audio: false }) => {
        try {
          return await this.captureViaCustomPicker(constraints);
        } catch (error) {
          this.api.logger.warn("Custom getDisplayMedia failed, falling back:", error?.message || error);
          return this.originalGetDisplayMedia(constraints);
        }
      };
      this.api.logger.info("Custom display source selector enabled (getDisplayMedia override).");
    }

    if (electronApi && typeof electronApi.onDisplayMediaRequested === "function" && this.originalSelect) {
      this.onDisplayMediaRequestedUnsub = electronApi.onDisplayMediaRequested(async (requestId, info) => {
        try {
          await this.showPicker(requestId, info || {});
        } catch (error) {
          this.api.logger.warn("Custom picker failed, falling back:", error?.message || error);
          const fallback = this.findFallbackSourceId("screen:0:0") || "screen:0:0";
          this.selectForRequest(requestId, fallback, Boolean(info?.withAudio));
        }
      });
      this.api.logger.info("Custom display source selector enabled.");
      return;
    }

    if (electronApi && this.originalSelect) {
      this.api.logger.warn("onDisplayMediaRequested not available; using fallback-only mode.");
      const patchedSelect = async (requestId, sourceId, withAudio) => {
        const requested = String(sourceId || "");
        if (!requested) {
          this.originalSelect(requestId, sourceId, withAudio);
          return;
        }
        await this.refreshSources();
        const chosenId = this.findFallbackSourceId(requested) || requested;
        this.originalSelect(requestId, chosenId, withAudio);
        this.lastGoodSourceId = chosenId;
      };
      electronApi.selectDisplayMediaSource = patchedSelect;
    }
  }

  stop() {
    this.closePicker();
    const win = this.api.app.getWindow?.();
    const mediaDevices = win?.navigator?.mediaDevices;
    const electronApi = this.getElectronApi();
    if (mediaDevices && this.originalGetDisplayMedia) {
      try {
        mediaDevices.getDisplayMedia = this.originalGetDisplayMedia;
      } catch (_) {}
    }
    if (electronApi && this.originalSelect) {
      try {
        electronApi.selectDisplayMediaSource = this.originalSelect;
      } catch (_) {}
      try {
        Object.defineProperty(electronApi, "selectDisplayMediaSource", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: this.originalSelect
        });
      } catch (_) {}
    }
    if (typeof this.onDisplayMediaRequestedUnsub === "function") {
      this.onDisplayMediaRequestedUnsub();
    }
    this.onDisplayMediaRequestedUnsub = null;
    this.originalSelect = null;
    this.originalGetDisplayMedia = null;
    this.originalGetUserMedia = null;
    this.api.logger.info("Display source fallback patch disabled.");
  }

  getSourceTypes() {
    const out = [];
    if (this.includeScreens) out.push("screen");
    if (this.includeWindows) out.push("window");
    return out.length ? out : ["screen", "window"];
  }

  loadConfig() {
    try {
      this.includeScreens = this.api.storage.get("includeScreens", this.includeScreens) !== false;
      this.includeWindows = this.api.storage.get("includeWindows", this.includeWindows) !== false;
      this.cache.types = this.getSourceTypes();
    } catch (_e) {}
  }

  getSettingsSchema() {
    return {
      title: "Display Source Fix",
      description: "Desktop source picker and fallback source types.",
      controls: [
        { key: "includeScreens", type: "boolean", label: "Include screens", value: this.includeScreens },
        { key: "includeWindows", type: "boolean", label: "Include windows", value: this.includeWindows }
      ]
    };
  }

  setSettingValue(key, value) {
    const k = String(key || "");
    if (k === "includeScreens") this.includeScreens = Boolean(value);
    if (k === "includeWindows") this.includeWindows = Boolean(value);
    this.cache.types = this.getSourceTypes();
    try {
      this.api.storage.set("includeScreens", this.includeScreens);
      this.api.storage.set("includeWindows", this.includeWindows);
    } catch (_e) {}
    this.refreshSources();
    return {
      includeScreens: this.includeScreens,
      includeWindows: this.includeWindows
    };
  }
};
