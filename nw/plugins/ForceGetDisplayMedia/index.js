module.exports = class ForceGetDisplayMediaPlugin {
  constructor(api) {
    this.api = api;
    this.originalGetUserMedia = null;
    this.originalGetDisplayMedia = null;
    this.originalSelectDisplayMediaSource = null;
    this.nativeGetDisplayMedia = null;
    this.nativeGetUserMedia = null;
    this.redirectCount = 0;
    this.redirectInFlight = false;
    this.pendingPickerPromise = null;
    this.pendingPickerResolve = null;
    this.overlayId = "bf-force-gdm-picker-overlay";
    this.styleId = "bf-force-gdm-picker-style";
  }

  isDesktopCaptureConstraints(constraints) {
    const c = constraints && typeof constraints === "object" ? constraints : {};
    const hasDesktopToken = (track) => {
      if (!track || typeof track !== "object") return false;
      const mandatory = track.mandatory && typeof track.mandatory === "object" ? track.mandatory : null;
      if (mandatory) {
        if (String(mandatory.chromeMediaSource || "").toLowerCase() === "desktop") return true;
        if (String(mandatory.chromeMediaSourceId || "").trim()) return true;
      }
      if (String(track.chromeMediaSource || "").toLowerCase() === "desktop") return true;
      if (String(track.chromeMediaSourceId || "").trim()) return true;
      return false;
    };

    return hasDesktopToken(c.video) || hasDesktopToken(c.audio);
  }

  toDisplayMediaConstraints(constraints) {
    const c = constraints && typeof constraints === "object" ? constraints : {};
    const wantsAudio = c.audio !== false && c.audio != null;

    const out = {
      video: true,
      audio: Boolean(wantsAudio)
    };

    if (c.video && typeof c.video === "object") {
      const cleaned = { ...c.video };
      delete cleaned.mandatory;
      delete cleaned.chromeMediaSource;
      delete cleaned.chromeMediaSourceId;
      if (Object.keys(cleaned).length > 0) {
        out.video = cleaned;
      }
    }

    if (c.audio && typeof c.audio === "object") {
      const cleaned = { ...c.audio };
      delete cleaned.mandatory;
      delete cleaned.chromeMediaSource;
      delete cleaned.chromeMediaSourceId;
      if (Object.keys(cleaned).length > 0) {
        out.audio = cleaned;
      }
    }

    return out;
  }

  getWindow() {
    return this.api.app.getWindow?.();
  }

  getDocument() {
    return this.api.app.getDocument?.();
  }

  getElectronApi() {
    const win = this.getWindow();
    return win && win.electron ? win.electron : null;
  }

  async getDesktopSources() {
    const electronApi = this.getElectronApi();
    if (!electronApi || typeof electronApi.getDesktopSources !== "function") {
      return [];
    }

    try {
      const result = await electronApi.getDesktopSources(["window", "screen"]);
      return Array.isArray(result) ? result : [];
    } catch (_) {
      return [];
    }
  }

  chooseBestSourceId(requestedId, sources) {
    const requested = String(requestedId || "").trim();
    if (!requested) {
      const screen = sources.find((item) => String(item && item.id || "").startsWith("screen:"));
      return String((screen && screen.id) || (sources[0] && sources[0].id) || "");
    }

    const exact = sources.find((item) => String(item && item.id || "") === requested);
    if (exact) return requested;

    const prefix = requested.includes(":") ? requested.split(":")[0] : "";
    if (prefix) {
      const sameType = sources.find((item) => String(item && item.id || "").startsWith(`${prefix}:`));
      if (sameType) return String(sameType.id || "");
    }

    const screen = sources.find((item) => String(item && item.id || "").startsWith("screen:"));
    return String((screen && screen.id) || (sources[0] && sources[0].id) || "");
  }

  ensurePickerStyle(doc) {
    if (!doc || doc.getElementById(this.styleId)) return;
    const style = doc.createElement("style");
    style.id = this.styleId;
    style.textContent = [
      ".bf-fgdm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.66);z-index:2147483647;display:flex;align-items:center;justify-content:center;}",
      ".bf-fgdm-modal{width:min(900px,96vw);max-height:88vh;overflow:auto;background:#12171d;border:1px solid #2b3441;border-radius:12px;padding:14px;color:#f4f7fb;font-family:Segoe UI,Tahoma,sans-serif;box-shadow:0 28px 80px rgba(0,0,0,.55);}",
      ".bf-fgdm-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;}",
      ".bf-fgdm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;}",
      ".bf-fgdm-card{background:#1a222d;border:1px solid #303d4f;border-radius:10px;padding:10px;display:grid;gap:8px;}",
      ".bf-fgdm-name{font-size:13px;font-weight:600;color:#e8eef7;word-break:break-word;}",
      ".bf-fgdm-id{font-size:11px;color:#aebcd0;word-break:break-word;}",
      ".bf-fgdm-btn{border:1px solid #3f4d61;background:#2a3748;color:#fff;border-radius:8px;padding:6px 10px;cursor:pointer;}",
      ".bf-fgdm-btn:hover{background:#34465d;}"
    ].join("");
    doc.head.appendChild(style);
  }

  closePicker(value) {
    const doc = this.getDocument();
    const overlay = doc && doc.getElementById ? doc.getElementById(this.overlayId) : null;
    if (overlay) overlay.remove();
    if (typeof this.pendingPickerResolve === "function") {
      const resolve = this.pendingPickerResolve;
      this.pendingPickerResolve = null;
      resolve(value == null ? "" : String(value));
    }
  }

  async openSourcePicker(sources) {
    const doc = this.getDocument();
    if (!doc || !doc.body) return "";
    this.ensurePickerStyle(doc);
    this.closePicker("");

    return new Promise((resolve) => {
      this.pendingPickerResolve = resolve;
      const overlay = doc.createElement("div");
      overlay.id = this.overlayId;
      overlay.className = "bf-fgdm-overlay";

      const modal = doc.createElement("div");
      modal.className = "bf-fgdm-modal";
      overlay.appendChild(modal);

      const head = doc.createElement("div");
      head.className = "bf-fgdm-head";
      const title = doc.createElement("strong");
      title.textContent = "Select Screen Or Window";
      const cancel = doc.createElement("button");
      cancel.className = "bf-fgdm-btn";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => this.closePicker(""));
      head.appendChild(title);
      head.appendChild(cancel);
      modal.appendChild(head);

      const grid = doc.createElement("div");
      grid.className = "bf-fgdm-grid";
      modal.appendChild(grid);

      for (const source of sources) {
        const id = String(source && source.id || "");
        if (!id) continue;
        const card = doc.createElement("div");
        card.className = "bf-fgdm-card";
        const name = doc.createElement("div");
        name.className = "bf-fgdm-name";
        name.textContent = String(source && source.name || id);
        const sub = doc.createElement("div");
        sub.className = "bf-fgdm-id";
        sub.textContent = id;
        const btn = doc.createElement("button");
        btn.className = "bf-fgdm-btn";
        btn.textContent = "Share";
        btn.addEventListener("click", () => this.closePicker(id));
        card.appendChild(name);
        card.appendChild(sub);
        card.appendChild(btn);
        grid.appendChild(card);
      }

      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) this.closePicker("");
      });
      doc.body.appendChild(overlay);
    });
  }

  async pickSourceId(requestedId) {
    if (this.pendingPickerPromise) {
      return this.pendingPickerPromise;
    }
    this.pendingPickerPromise = (async () => {
      const sources = await this.getDesktopSources();
      if (!sources.length) return "";
      if (sources.length === 1) return String(sources[0].id || "");
      const picked = await this.openSourcePicker(sources);
      if (picked) return picked;
      return this.chooseBestSourceId(requestedId, sources);
    })();
    try {
      return await this.pendingPickerPromise;
    } finally {
      this.pendingPickerPromise = null;
    }
  }

  buildDesktopUserMediaConstraints(sourceId, constraints) {
    const c = constraints && typeof constraints === "object" ? constraints : {};
    const wantsAudio = c.audio !== false && c.audio != null;
    const selected = String(sourceId || "");
    const out = {
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: selected
        }
      },
      audio: false
    };
    if (wantsAudio) {
      out.audio = {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: selected
        }
      };
    }
    return out;
  }

  async captureBySourceId(sourceId, constraints) {
    const selected = String(sourceId || "").trim();
    if (!selected) throw new Error("Missing source id");
    const desktopConstraints = this.buildDesktopUserMediaConstraints(selected, constraints);
    return this.nativeGetUserMedia(desktopConstraints);
  }

  start() {
    const win = this.getWindow();
    const mediaDevices = win && win.navigator ? win.navigator.mediaDevices : null;
    const electronApi = this.getElectronApi();

    if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== "function") {
      this.api.logger.warn("ForceGetDisplayMedia inactive: getDisplayMedia is unavailable.");
      return;
    }
    if (typeof mediaDevices.getUserMedia !== "function") {
      this.api.logger.warn("ForceGetDisplayMedia inactive: getUserMedia is unavailable.");
      return;
    }

    this.originalGetDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
    this.originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    const proto = Object.getPrototypeOf(mediaDevices);
    this.nativeGetDisplayMedia =
      proto && typeof proto.getDisplayMedia === "function"
        ? proto.getDisplayMedia.bind(mediaDevices)
        : this.originalGetDisplayMedia;
    this.nativeGetUserMedia =
      proto && typeof proto.getUserMedia === "function"
        ? proto.getUserMedia.bind(mediaDevices)
        : this.originalGetUserMedia;

    mediaDevices.getUserMedia = async (constraints) => {
      if (!this.isDesktopCaptureConstraints(constraints)) {
        return this.nativeGetUserMedia(constraints);
      }

      if (this.redirectInFlight) {
        return this.nativeGetUserMedia(constraints);
      }

      const redirectConstraints = this.toDisplayMediaConstraints(constraints);
      this.redirectCount += 1;
      this.api.logger.info(
        `Redirecting desktop capture request #${this.redirectCount} to getDisplayMedia.`
      );
      this.redirectInFlight = true;
      try {
        const requestedId = String(
          constraints &&
          constraints.video &&
          typeof constraints.video === "object" &&
          (
            (constraints.video.mandatory && constraints.video.mandatory.chromeMediaSourceId) ||
            constraints.video.chromeMediaSourceId
          ) || ""
        );
        const chosen = await this.pickSourceId(requestedId);
        if (chosen) {
          return await this.captureBySourceId(chosen, constraints);
        }
        return await this.nativeGetDisplayMedia(redirectConstraints);
      } finally {
        this.redirectInFlight = false;
      }
    };

    if (electronApi && typeof electronApi.selectDisplayMediaSource === "function") {
      this.originalSelectDisplayMediaSource = electronApi.selectDisplayMediaSource.bind(electronApi);
      electronApi.selectDisplayMediaSource = async (requestId, sourceId, withAudio) => {
        const requested = String(sourceId || "");
        const chosen = await this.pickSourceId(requested);
        if (requested && chosen && requested !== chosen) {
          this.api.logger.warn(
            `Replaced stale display source id "${requested}" with "${chosen}".`
          );
        }
        return this.originalSelectDisplayMediaSource(requestId, chosen || requested, withAudio);
      };
    }

    this.api.logger.info("ForceGetDisplayMedia enabled.");
  }

  stop() {
    const win = this.getWindow();
    const mediaDevices = win && win.navigator ? win.navigator.mediaDevices : null;

    if (mediaDevices && this.originalGetUserMedia) {
      try {
        mediaDevices.getUserMedia = this.originalGetUserMedia;
      } catch (_) {}
    }
    const electronApi = win && win.electron ? win.electron : null;
    if (electronApi && this.originalSelectDisplayMediaSource) {
      try {
        electronApi.selectDisplayMediaSource = this.originalSelectDisplayMediaSource;
      } catch (_) {}
    }

    this.originalGetUserMedia = null;
    this.originalGetDisplayMedia = null;
    this.originalSelectDisplayMediaSource = null;
    this.nativeGetUserMedia = null;
    this.nativeGetDisplayMedia = null;
    this.redirectInFlight = false;
    this.redirectCount = 0;
    this.pendingPickerPromise = null;
    this.closePicker("");
    const doc = this.getDocument();
    const style = doc && doc.getElementById ? doc.getElementById(this.styleId) : null;
    if (style) style.remove();
    this.api.logger.info("ForceGetDisplayMedia disabled.");
  }
};
