module.exports = class UserVolumeBoosterPlugin {
  constructor(api) {
    this.api = api;
    this.audioContext = null;
    this.mediaBindings = new WeakMap();
    this.boundMediaElements = new Set();
    this.boundMediaCount = 0;
    this.observer = null;
    this.originalVolumeDescriptor = null;
    this.volumePatchFlag = "__betterFluxerVolumePatched";
    this.pagePatchScriptId = "betterfluxer-volume-patch-script";
    this.pagePatchCleanupKey = "__betterFluxerCleanupVolumePatch";
    this.pagePatchAppliedKey = "__betterFluxerVolumePatchedMainApplied";
    this.pagePatchInterval = null;
    this.pagePatchVerifyTimer = null;
    this.pagePatchWarned = false;
    this.debugOverlayId = "betterfluxer-volume-debug-overlay";
    this.debugInterval = null;
    this.maxPercent = 1200;
    this.maxGain = 32;
    this.defaultPercent = 100;
    this.globalPercent = 100;
    this.boostByTarget = {};
    this.onPointerUp = this.handlePointerUp.bind(this);
    this.onUserGesture = this.handleUserGesture.bind(this);
    this.originalMediaPlay = null;
    this.originalSrcObjectDescriptor = null;
    this.originalSrcDescriptor = null;
    this.originalSetSinkId = null;
    this.originalAudioConstructor = null;
    this.mediaHookFlag = "__betterFluxerMediaHooked";
    this.boostUiAttr = "data-bf-boost-ui";
  }

  start() {
    this.globalPercent = Number(this.api.storage.get("boostPercentGlobal", this.defaultPercent)) || this.defaultPercent;
    this.globalPercent = Math.min(this.maxPercent, Math.max(100, this.globalPercent));
    this.boostByTarget = this.api.storage.get("boostByTarget", {}) || {};

    this.ensureAudioContext();
    this.patchNativeVolumeSetter();
    this.patchMediaElementHooks();
    this.patchPageVolumeSetter();
    this.ensurePagePatchLoop();
    this.scanMediaElements();
    this.patchVolumeSliders();
    this.patchBoostUi();
    this.installObserver();
    const doc = this.api.app.getDocument?.();
    doc?.addEventListener("pointerup", this.onPointerUp, true);
    doc?.addEventListener("pointerdown", this.onUserGesture, true);
    doc?.addEventListener("keydown", this.onUserGesture, true);
    this.ensureDebugOverlay();
    this.startDebugLoop();
    this.handleUserGesture();
    this.updateDebugOverlay();

    this.api.logger.info("UserVolumeBooster enabled.");
  }

  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    const doc = this.api.app.getDocument?.();
    doc?.removeEventListener("pointerup", this.onPointerUp, true);
    doc?.removeEventListener("pointerdown", this.onUserGesture, true);
    doc?.removeEventListener("keydown", this.onUserGesture, true);
    if (doc) {
      const sliders = doc.querySelectorAll("input[type='range'][data-bf-volume-booster='1']");
      for (const slider of sliders) {
        slider.removeAttribute("data-bf-volume-booster");
        if (slider.dataset.bfOriginalMax) {
          slider.max = slider.dataset.bfOriginalMax;
          delete slider.dataset.bfOriginalMax;
        }
        if (slider.dataset.bfOriginalStep) {
          slider.step = slider.dataset.bfOriginalStep;
          delete slider.dataset.bfOriginalStep;
        }
      }
      const customTracks = doc.querySelectorAll("[data-bf-volume-custom='1']");
      for (const track of customTracks) {
        track.removeAttribute("data-bf-volume-custom");
      }
      const boostUi = doc.querySelectorAll(`[${this.boostUiAttr}='1']`);
      for (const row of boostUi) {
        row.remove();
      }
    }

    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (_) {}
      this.audioContext = null;
    }

    this.restoreNativeVolumeSetter();
    this.restoreMediaElementHooks();
    this.restorePageVolumeSetter();
    if (this.pagePatchInterval) {
      clearInterval(this.pagePatchInterval);
      this.pagePatchInterval = null;
    }
    if (this.pagePatchVerifyTimer) {
      clearTimeout(this.pagePatchVerifyTimer);
      this.pagePatchVerifyTimer = null;
    }
    if (this.debugInterval) {
      clearInterval(this.debugInterval);
      this.debugInterval = null;
    }
    this.removeDebugOverlay();
    this.pagePatchWarned = false;
    this.boundMediaCount = 0;
    this.boundMediaElements.clear();
    this.mediaBindings = new WeakMap();
    this.api.logger.info("UserVolumeBooster disabled.");
  }

  ensureAudioContext() {
    if (this.audioContext) return this.audioContext;
    const win = this.api.app.getWindow?.();
    const Ctx = win?.AudioContext || win?.webkitAudioContext;
    if (!Ctx) return null;
    try {
      this.audioContext = new Ctx();
    } catch (_) {
      this.audioContext = null;
    }
    return this.audioContext;
  }

  handleUserGesture() {
    const ctx = this.ensureAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      ctx.resume().catch(() => {});
    }
    this.updateDebugOverlay();
  }

  patchNativeVolumeSetter() {
    const win = this.api.app.getWindow?.();
    const proto = win?.HTMLMediaElement?.prototype;
    if (!proto || proto[this.volumePatchFlag]) return;

    const descriptor = Object.getOwnPropertyDescriptor(proto, "volume");
    if (!descriptor || typeof descriptor.get !== "function" || typeof descriptor.set !== "function") return;

    this.originalVolumeDescriptor = descriptor;
    Object.defineProperty(proto, "volume", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        return descriptor.get.call(this);
      },
      set(value) {
        let next = Number(value);
        if (!Number.isFinite(next)) {
          next = Number(descriptor.get.call(this));
        }
        if (next < 0) next = 0;
        if (next > 1) next = 1;
        descriptor.set.call(this, next);
      }
    });
    proto[this.volumePatchFlag] = true;
  }

  patchMediaElementHooks() {
    const win = this.api.app.getWindow?.();
    const proto = win?.HTMLMediaElement?.prototype;
    if (!proto || proto[this.mediaHookFlag]) return;

    const plugin = this;
    if (typeof proto.play === "function") {
      this.originalMediaPlay = proto.play;
      proto.play = function patchedPlay(...args) {
        try {
          plugin.bindMediaElement(this);
        } catch (_) {}
        return plugin.originalMediaPlay.apply(this, args);
      };
    }

    const srcObjectDesc = Object.getOwnPropertyDescriptor(proto, "srcObject");
    if (srcObjectDesc && typeof srcObjectDesc.get === "function" && typeof srcObjectDesc.set === "function") {
      this.originalSrcObjectDescriptor = srcObjectDesc;
      Object.defineProperty(proto, "srcObject", {
        configurable: true,
        enumerable: srcObjectDesc.enumerable,
        get() {
          return srcObjectDesc.get.call(this);
        },
        set(value) {
          srcObjectDesc.set.call(this, value);
          try {
            plugin.bindMediaElement(this);
          } catch (_) {}
        }
      });
    }

    const srcDesc = Object.getOwnPropertyDescriptor(proto, "src");
    if (srcDesc && typeof srcDesc.get === "function" && typeof srcDesc.set === "function") {
      this.originalSrcDescriptor = srcDesc;
      Object.defineProperty(proto, "src", {
        configurable: true,
        enumerable: srcDesc.enumerable,
        get() {
          return srcDesc.get.call(this);
        },
        set(value) {
          srcDesc.set.call(this, value);
          try {
            plugin.bindMediaElement(this);
          } catch (_) {}
        }
      });
    }

    if (typeof proto.setSinkId === "function") {
      this.originalSetSinkId = proto.setSinkId;
      proto.setSinkId = function patchedSetSinkId(...args) {
        try {
          plugin.bindMediaElement(this);
        } catch (_) {}
        return plugin.originalSetSinkId.apply(this, args);
      };
    }

    if (typeof win.Audio === "function") {
      this.originalAudioConstructor = win.Audio;
      const PatchedAudio = function BetterFluxerPatchedAudio(...args) {
        const el = new plugin.originalAudioConstructor(...args);
        try {
          plugin.bindMediaElement(el);
        } catch (_) {}
        return el;
      };
      Object.setPrototypeOf(PatchedAudio, this.originalAudioConstructor);
      PatchedAudio.prototype = this.originalAudioConstructor.prototype;
      win.Audio = PatchedAudio;
    }

    proto[this.mediaHookFlag] = true;
  }

  restoreMediaElementHooks() {
    const win = this.api.app.getWindow?.();
    const proto = win?.HTMLMediaElement?.prototype;
    if (!proto) return;
    try {
      if (this.originalMediaPlay) {
        proto.play = this.originalMediaPlay;
      }
      if (this.originalSrcObjectDescriptor) {
        Object.defineProperty(proto, "srcObject", this.originalSrcObjectDescriptor);
      }
      if (this.originalSrcDescriptor) {
        Object.defineProperty(proto, "src", this.originalSrcDescriptor);
      }
      if (this.originalSetSinkId) {
        proto.setSinkId = this.originalSetSinkId;
      }
      delete proto[this.mediaHookFlag];
    } catch (_) {}
    if (win && this.originalAudioConstructor) {
      try {
        win.Audio = this.originalAudioConstructor;
      } catch (_) {}
    }
    this.originalMediaPlay = null;
    this.originalSrcObjectDescriptor = null;
    this.originalSrcDescriptor = null;
    this.originalSetSinkId = null;
    this.originalAudioConstructor = null;
  }

  ensurePagePatchLoop() {
    if (this.pagePatchInterval) return;
    this.pagePatchInterval = setInterval(() => {
      this.patchPageVolumeSetter();
    }, 1500);
  }

  patchPageVolumeSetter() {
    const doc = this.api.app.getDocument?.();
    const root = doc?.head || doc?.body || doc?.documentElement;
    if (!doc || !root) return;
    const existing = doc.getElementById(this.pagePatchScriptId);
    if (existing?.getAttribute("data-bf-applied") === "1") return;
    if (existing) existing.remove();

    const script = doc.createElement("script");
    script.id = this.pagePatchScriptId;
    script.type = "text/javascript";
    const nonceCarrier = doc.querySelector("script[nonce], style[nonce], link[nonce], [nonce]");
    const nonce = String(
      nonceCarrier?.nonce ||
      nonceCarrier?.getAttribute?.("nonce") ||
      ""
    );
    if (nonce) {
      script.setAttribute("nonce", nonce);
      script.nonce = nonce;
    }
    script.textContent = [
      "(function(){",
      "  try {",
      "    var w = window;",
      "    var scriptEl = document.getElementById(" + JSON.stringify(this.pagePatchScriptId) + ");",
      "    var cleanupKey = " + JSON.stringify(this.pagePatchCleanupKey) + ";",
      "    var appliedKey = " + JSON.stringify(this.pagePatchAppliedKey) + ";",
      "    var flagKey = '__betterFluxerVolumePatchedMain';",
      "    var setterFlag = '__betterFluxerVolumeSetterClamp';",
      "    var proto = w.HTMLMediaElement && w.HTMLMediaElement.prototype;",
      "    if (!proto) return;",
      "    var descriptor = Object.getOwnPropertyDescriptor(proto, 'volume');",
      "    if (!descriptor || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') return;",
      "    if (descriptor.set && descriptor.set[setterFlag]) {",
      "      proto[flagKey] = true;",
      "      w[appliedKey] = true;",
      "      if (scriptEl) scriptEl.setAttribute('data-bf-applied', '1');",
      "      return;",
      "    }",
      "    var originalSet = descriptor.set;",
      "    var originalGet = descriptor.get;",
      "    function wrappedSet(value){",
      "      var next = Number(value);",
      "      if (!Number.isFinite(next)) next = Number(originalGet.call(this));",
      "      if (next < 0) next = 0;",
      "      if (next > 1) next = 1;",
      "      originalSet.call(this, next);",
      "    }",
      "    wrappedSet[setterFlag] = true;",
      "    Object.defineProperty(proto, 'volume', {",
      "      configurable: true,",
      "      enumerable: descriptor.enumerable,",
      "      get: function(){ return originalGet.call(this); },",
      "      set: wrappedSet,",
      "    });",
      "    proto[flagKey] = true;",
      "    w[appliedKey] = true;",
      "    if (scriptEl) scriptEl.setAttribute('data-bf-applied', '1');",
      "    w[cleanupKey] = function(){",
      "      try {",
      "        Object.defineProperty(proto, 'volume', descriptor);",
      "        delete proto[flagKey];",
      "        delete w[appliedKey];",
      "      } catch (_) {}",
      "    };",
      "  } catch (_) {}",
      "})();"
    ].join("\n");
    root.appendChild(script);
    if (this.pagePatchVerifyTimer) {
      clearTimeout(this.pagePatchVerifyTimer);
    }
    this.pagePatchVerifyTimer = setTimeout(() => {
      const marker = doc.getElementById(this.pagePatchScriptId);
      const applied = marker?.getAttribute("data-bf-applied") === "1";
      if (!applied && !this.pagePatchWarned) {
        this.api.logger.warn("Page volume patch did not apply (CSP/main-world block).");
        this.pagePatchWarned = true;
      }
    }, 250);
  }

  restoreNativeVolumeSetter() {
    const win = this.api.app.getWindow?.();
    const proto = win?.HTMLMediaElement?.prototype;
    if (!proto || !this.originalVolumeDescriptor) return;
    try {
      Object.defineProperty(proto, "volume", this.originalVolumeDescriptor);
      delete proto[this.volumePatchFlag];
    } catch (_) {}
    this.originalVolumeDescriptor = null;
  }

  restorePageVolumeSetter() {
    const win = this.api.app.getWindow?.();
    try {
      const cleanup = win?.[this.pagePatchCleanupKey];
      if (typeof cleanup === "function") cleanup();
      if (win && this.pagePatchCleanupKey in win) {
        delete win[this.pagePatchCleanupKey];
      }
    } catch (_) {}
    const doc = this.api.app.getDocument?.();
    const script = doc?.getElementById(this.pagePatchScriptId);
    if (script) script.remove();
  }

  normalizePercent(value, fallback = 100) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(this.maxPercent, Math.max(100, num));
  }

  getGainValue(targetKey) {
    const key = String(targetKey || "");
    const percent = key && this.boostByTarget[key] != null
      ? this.normalizePercent(this.boostByTarget[key], this.globalPercent)
      : this.globalPercent;
    const ratio = percent / 100;
    if (ratio <= 1) return ratio;
    return Math.min(this.maxGain, ratio * ratio);
  }

  bindMediaElement(el) {
    if (!el || this.mediaBindings.has(el)) return;
    const ctx = this.ensureAudioContext();
    if (!ctx) return;

    try {
      const targetKey = this.resolveTargetKey(el);
      const source = ctx.createMediaElementSource(el);
      const gain = ctx.createGain();
      gain.gain.value = this.getGainValue(targetKey);
      source.connect(gain);
      gain.connect(ctx.destination);
      this.mediaBindings.set(el, { source, gain, targetKey });
      this.boundMediaElements.add(el);
      this.boundMediaCount += 1;
      this.updateDebugOverlay();
    } catch (_) {
      // Ignore elements that cannot be rebound (already bound by another context, etc).
    }
  }

  updateAllGains() {
    for (const el of this.boundMediaElements) {
      const binding = this.mediaBindings.get(el);
      if (!binding || !binding.gain) {
        this.boundMediaElements.delete(el);
        continue;
      }
      binding.gain.gain.value = this.getGainValue(binding.targetKey);
    }
    this.updateDebugOverlay();
  }

  scanMediaElements(root) {
    const doc = this.api.app.getDocument?.();
    const scope = root || doc;
    if (!scope || !scope.querySelectorAll) return;
    const media = scope.querySelectorAll("audio, video");
    for (const el of media) {
      this.bindMediaElement(el);
    }
  }

  looksLikeVolumeSlider(input) {
    if (!input || input.tagName !== "INPUT" || input.type !== "range") return false;
    const aria = String(input.getAttribute("aria-label") || "").toLowerCase();
    const title = String(input.getAttribute("title") || "").toLowerCase();
    const name = String(input.getAttribute("name") || "").toLowerCase();
    const id = String(input.id || "").toLowerCase();
    const cls = String(input.className || "").toLowerCase();
    const haystack = `${aria} ${title} ${name} ${id} ${cls}`;
    return haystack.includes("volume") || haystack.includes("vol");
  }

  isCustomTrackSlider(node) {
    if (!node || node.nodeType !== 1) return false;
    const cls = String(node.className || "");
    if (/slider\.module__track___/i.test(cls)) return true;
    const grabber = node.querySelector?.("button[aria-label='Slider handle']");
    return Boolean(grabber);
  }

  findCustomTrackSlider(node) {
    let cur = node;
    let depth = 0;
    while (cur && depth < 8) {
      if (this.isCustomTrackSlider(cur)) return cur;
      cur = cur.parentElement;
      depth += 1;
    }
    return null;
  }

  readCustomTrackPercent(track) {
    const grabber = track?.querySelector?.("button[aria-label='Slider handle']");
    if (!grabber) return null;
    const left = String(grabber.style?.left || "");
    const match = left.match(/(-?\d+(?:\.\d+)?)%/);
    if (!match) return null;
    const leftPercent = Number(match[1]);
    if (!Number.isFinite(leftPercent)) return null;
    // Fluxer slider maps 0..2 volume onto 0..100% track position.
    return leftPercent * 2;
  }

  handlePointerUp(event) {
    const track = this.findCustomTrackSlider(event?.target);
    if (!track) return;
    const rawPercent = this.readCustomTrackPercent(track);
    if (!Number.isFinite(rawPercent)) return;

    const normalized = this.normalizePercent(rawPercent, 100);
    const key = String(this.resolveTargetKey(track) || "global");
    if (key === "global") {
      this.globalPercent = normalized;
      this.api.storage.set("boostPercentGlobal", this.globalPercent);
      this.updateAllGains();
      return;
    }

    this.boostByTarget[key] = normalized;
    this.api.storage.set("boostByTarget", this.boostByTarget);
    this.updateAllGains();
  }

  sanitizeKey(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 120);
  }

  getNodeLabel(node) {
    if (!node) return "";
    const aria =
      node.getAttribute?.("aria-label") ||
      node.getAttribute?.("title") ||
      node.getAttribute?.("data-name") ||
      "";
    const text = String(node.textContent || "").trim();
    return String(aria || text || "").trim();
  }

  resolveTargetKey(node) {
    if (!node) return "global";
    let cur = node;
    let depth = 0;
    while (cur && depth < 8) {
      if (cur.getAttribute) {
        const userId =
          cur.getAttribute("data-user-id") ||
          cur.getAttribute("data-speaker-id") ||
          cur.getAttribute("data-participant-id");
        if (userId) return `user:${this.sanitizeKey(userId)}`;

        const itemId = cur.getAttribute("data-list-item-id");
        if (itemId) {
          const m = String(itemId).match(/user[_:-]?([a-z0-9]+)/i);
          if (m && m[1]) return `user:${this.sanitizeKey(m[1])}`;
          return `item:${this.sanitizeKey(itemId)}`;
        }

        const aria = this.getNodeLabel(cur);
        if (aria && /volume|user|member|voice/i.test(aria)) {
          return `label:${this.sanitizeKey(aria)}`;
        }
      }
      cur = cur.parentElement;
      depth += 1;
    }

    return "global";
  }

  patchVolumeSliders(root) {
    const doc = this.api.app.getDocument?.();
    const scope = root || doc;
    if (!scope || !scope.querySelectorAll) return;
    const sliders = scope.querySelectorAll("input[type='range']");
    for (const slider of sliders) {
      if (!this.looksLikeVolumeSlider(slider)) continue;
      if (slider.getAttribute("data-bf-volume-booster") === "1") continue;

      slider.setAttribute("data-bf-volume-booster", "1");
      slider.dataset.bfOriginalMax = slider.max || "100";
      slider.dataset.bfOriginalStep = slider.step || "1";

      slider.max = String(this.maxPercent);
      slider.step = "1";

      const targetKey = this.resolveTargetKey(slider);
      slider.dataset.bfBoostTarget = targetKey;
      const stored = this.boostByTarget[targetKey];
      if (stored != null) {
        slider.value = String(this.normalizePercent(stored, 100));
      }

      slider.addEventListener("input", () => {
        const value = Number(slider.value || 100);
        if (Number.isFinite(value)) {
          const normalized = this.normalizePercent(value, 100);
          const key = String(slider.dataset.bfBoostTarget || "global");
          if (key === "global") {
            this.globalPercent = normalized;
            this.api.storage.set("boostPercentGlobal", this.globalPercent);
          } else {
            this.boostByTarget[key] = normalized;
            this.api.storage.set("boostByTarget", this.boostByTarget);
          }
          this.updateAllGains();
        }
      });
    }

    const customTracks = scope.querySelectorAll("div[class*='Slider.module__track___']");
    for (const track of customTracks) {
      if (!this.isCustomTrackSlider(track)) continue;
      if (track.getAttribute("data-bf-volume-custom") === "1") continue;
      track.setAttribute("data-bf-volume-custom", "1");
    }
  }

  patchBoostUi(root) {
    const doc = this.api.app.getDocument?.();
    const scope = root || doc;
    if (!scope || !scope.querySelectorAll) return;
    const labels = scope.querySelectorAll("span");
    for (const label of labels) {
      const text = String(label.textContent || "").trim().toLowerCase();
      if (text !== "user volume") continue;
      this.ensureBoostUiForLabel(label);
    }
  }

  ensureBoostUiForLabel(label) {
    const doc = this.api.app.getDocument?.();
    if (!doc || !label) return;
    const baseRow = label.closest("div[class*='MenuItem.module__item___']") || label.parentElement;
    if (!baseRow || !baseRow.parentElement) return;
    const parent = baseRow.parentElement;
    const existingNext = baseRow.nextElementSibling;
    if (existingNext && existingNext.getAttribute?.(this.boostUiAttr) === "1") return;

    const targetKey = String(this.resolveTargetKey(label) || "global");
    const currentPercent = targetKey === "global"
      ? this.globalPercent
      : this.normalizePercent(this.boostByTarget[targetKey], this.globalPercent);

    const row = doc.createElement("div");
    row.setAttribute(this.boostUiAttr, "1");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr auto";
    row.style.gap = "8px";
    row.style.alignItems = "center";
    row.style.margin = "8px 0 0";
    row.style.padding = "6px 8px";
    row.style.border = "1px solid rgba(255,255,255,0.12)";
    row.style.borderRadius = "8px";
    row.style.background = "rgba(0,0,0,0.16)";

    const labelEl = doc.createElement("div");
    labelEl.textContent = targetKey === "global" ? "Boost (Global)" : "Boost";
    labelEl.style.fontSize = "12px";
    labelEl.style.opacity = "0.9";
    row.appendChild(labelEl);

    const valueEl = doc.createElement("div");
    valueEl.style.fontSize = "12px";
    valueEl.style.opacity = "0.9";
    row.appendChild(valueEl);

    const slider = doc.createElement("input");
    slider.type = "range";
    slider.min = "100";
    slider.max = String(this.maxPercent);
    slider.step = "10";
    slider.value = String(currentPercent);
    slider.style.gridColumn = "1 / span 2";
    slider.addEventListener("input", () => {
      const value = this.normalizePercent(slider.value, 100);
      slider.value = String(value);
      valueEl.textContent = `${Math.round(value)}%`;
      if (targetKey === "global") {
        this.globalPercent = value;
        this.api.storage.set("boostPercentGlobal", this.globalPercent);
      } else {
        this.boostByTarget[targetKey] = value;
        this.api.storage.set("boostByTarget", this.boostByTarget);
      }
      this.updateAllGains();
    });
    valueEl.textContent = `${Math.round(currentPercent)}%`;
    row.appendChild(slider);

    parent.insertBefore(row, baseRow.nextSibling);
  }

  installObserver() {
    const doc = this.api.app.getDocument?.();
    if (!doc) return;

    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes || []) {
          if (!node || node.nodeType !== 1) continue;
          this.scanMediaElements(node);
          this.patchVolumeSliders(node);
          this.patchBoostUi(node);
        }
      }
    });
    this.observer.observe(doc.documentElement || doc.body, { childList: true, subtree: true });
  }

  ensureDebugOverlay() {
    const doc = this.api.app.getDocument?.();
    if (!doc || !doc.body) return;
    if (doc.getElementById(this.debugOverlayId)) return;
    const box = doc.createElement("div");
    box.id = this.debugOverlayId;
    box.style.position = "fixed";
    box.style.right = "10px";
    box.style.bottom = "10px";
    box.style.zIndex = "2147483647";
    box.style.pointerEvents = "none";
    box.style.background = "rgba(12,14,18,0.9)";
    box.style.border = "1px solid rgba(255,255,255,0.16)";
    box.style.borderRadius = "8px";
    box.style.padding = "8px 10px";
    box.style.color = "#d9e3f0";
    box.style.font = "12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace";
    box.style.whiteSpace = "pre";
    doc.body.appendChild(box);
  }

  removeDebugOverlay() {
    const doc = this.api.app.getDocument?.();
    const box = doc?.getElementById(this.debugOverlayId);
    if (box) box.remove();
  }

  startDebugLoop() {
    if (this.debugInterval) return;
    this.debugInterval = setInterval(() => {
      this.updateDebugOverlay();
    }, 1000);
  }

  getBoundCount() {
    return this.boundMediaCount;
  }

  updateDebugOverlay() {
    const doc = this.api.app.getDocument?.();
    const box = doc?.getElementById(this.debugOverlayId);
    if (!box) return;
    const ctxState = this.audioContext?.state || "none";
    const bound = this.getBoundCount();
    const targets = Object.keys(this.boostByTarget || {}).length;
    const applied = doc?.getElementById(this.pagePatchScriptId)?.getAttribute("data-bf-applied") === "1";
    box.textContent = [
      "BetterFluxer Volume Debug",
      `ctx: ${ctxState}`,
      `bound media: ${bound}`,
      `global boost: ${this.globalPercent}%`,
      `global gain: ${this.getGainValue("global").toFixed(2)}x`,
      `target boosts: ${targets}`,
      `page clamp: ${applied ? "on" : "off"}`
    ].join("\n");
  }
};
