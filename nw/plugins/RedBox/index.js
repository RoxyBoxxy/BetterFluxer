module.exports = class RedBoxPlugin {
  constructor(api) {
    this.api = api;
    this.styleId = "betterfluxer-redbox-style";
    this.overlayId = "betterfluxer-redbox-overlay";
    this.infoId = "betterfluxer-redbox-info";
    this.copyBtnId = "betterfluxer-redbox-copy-btn";
    this.onMouseMove = this.handleMouseMove.bind(this);
    this.onClick = this.handleClick.bind(this);
    this.onCopyButtonClick = this.handleCopyButtonClick.bind(this);
    this.onLeave = this.handleLeave.bind(this);
    this.onKeyDown = this.handleKeyDown.bind(this);
    this.lastElement = null;
    this.hideTimer = null;
    this.inspectActive = false;
    this.keybind = "Ctrl+Shift+X";
    this.autoHideMs = 5000;
  }

  start() {
    const doc = this.api.app.getDocument?.();
    if (!doc) return;
    this.loadConfig();
    if (doc.getElementById(this.styleId)) return;

    const style = doc.createElement("style");
    style.id = this.styleId;
    style.textContent = [
      "html[data-bf-redbox-active='1'] body *:not(script):not(style):not(link):not(meta):not(title){",
      "  outline:1px solid rgba(255,0,0,0.9) !important;",
      "  outline-offset:-1px !important;",
      "}",
      "#betterfluxer-redbox-overlay{",
      "  position:fixed;",
      "  border:2px solid #ff2b2b;",
      "  background:rgba(255,0,0,0.08);",
      "  pointer-events:none;",
      "  z-index:2147483646;",
      "  display:none;",
      "}",
      "#betterfluxer-redbox-info{",
      "  position:fixed;",
      "  max-width:40vw;",
      "  background:#141920;",
      "  color:#fff;",
      "  border:1px solid #ff2b2b;",
      "  border-radius:8px;",
      "  padding:8px 10px;",
      "  font:12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;",
      "  pointer-events:none;",
      "  z-index:2147483647;",
      "  display:none;",
      "}",
      "#betterfluxer-redbox-copy-btn{",
      "  position:fixed;",
      "  background:#ff2b2b;",
      "  color:#fff;",
      "  border:1px solid #8b0000;",
      "  border-radius:6px;",
      "  padding:4px 8px;",
      "  font:12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;",
      "  cursor:pointer;",
      "  z-index:2147483647;",
      "  display:none;",
      "  pointer-events:auto;",
      "}"
    ].join("\n");

    doc.head.appendChild(style);
    this.ensureInspectorNodes(doc);
    doc.addEventListener("mousemove", this.onMouseMove, true);
    doc.addEventListener("mouseleave", this.onLeave, true);
    doc.addEventListener("click", this.onClick, true);
    this.api.app.getWindow?.()?.addEventListener("keydown", this.onKeyDown, true);
    this.setInspectActive(false);
    this.api.logger.info("RedBox enabled.");
  }

  stop() {
    const doc = this.api.app.getDocument?.();
    if (doc) {
      doc.removeEventListener("mousemove", this.onMouseMove, true);
      doc.removeEventListener("mouseleave", this.onLeave, true);
      doc.removeEventListener("click", this.onClick, true);
      doc.documentElement?.removeAttribute("data-bf-redbox-active");
    }
    this.api.app.getWindow?.()?.removeEventListener("keydown", this.onKeyDown, true);
    const style = doc?.getElementById(this.styleId);
    if (style) style.remove();
    const overlay = doc?.getElementById(this.overlayId);
    if (overlay) overlay.remove();
    const info = doc?.getElementById(this.infoId);
    if (info) info.remove();
    const copyBtn = doc?.getElementById(this.copyBtnId);
    if (copyBtn) {
      copyBtn.removeEventListener("click", this.onCopyButtonClick, true);
      copyBtn.remove();
    }
    this.clearHideTimer();
    this.lastElement = null;
    this.api.logger.info("RedBox disabled.");
  }

  ensureInspectorNodes(doc) {
    if (!doc.getElementById(this.overlayId)) {
      const overlay = doc.createElement("div");
      overlay.id = this.overlayId;
      doc.body.appendChild(overlay);
    }
    if (!doc.getElementById(this.infoId)) {
      const info = doc.createElement("div");
      info.id = this.infoId;
      doc.body.appendChild(info);
    }
    if (!doc.getElementById(this.copyBtnId)) {
      const copyBtn = doc.createElement("button");
      copyBtn.id = this.copyBtnId;
      copyBtn.type = "button";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", this.onCopyButtonClick, true);
      doc.body.appendChild(copyBtn);
    }
  }

  handleMouseMove(event) {
    if (!this.inspectActive) return;
    const doc = this.api.app.getDocument?.();
    if (!doc) return;
    const target = event.target;
    if (!target || target.id === this.overlayId || target.id === this.infoId) return;
    this.lastElement = target;
    this.renderInspector(doc, target);
  }

  handleLeave() {
    this.clearHideTimer();
    this.hideInspector();
  }

  hideInspector() {
    const doc = this.api.app.getDocument?.();
    if (!doc) return;
    const overlay = doc.getElementById(this.overlayId);
    const info = doc.getElementById(this.infoId);
    const copyBtn = doc.getElementById(this.copyBtnId);
    if (overlay) overlay.style.display = "none";
    if (info) info.style.display = "none";
    if (copyBtn) copyBtn.style.display = "none";
  }

  clearHideTimer() {
    if (!this.hideTimer) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  scheduleAutoHide() {
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      this.hideInspector();
    }, this.autoHideMs);
  }

  handleCopyButtonClick(event) {
    const doc = this.api.app.getDocument?.();
    const target = this.lastElement;
    if (!doc || !target) return;

    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    const payload = {
      selector: this.getSelector(target),
      tag: String(target.tagName || "").toLowerCase(),
      id: target.id || null,
      className: target.className || null,
      text: String(target.textContent || "").trim().slice(0, 300),
      data: this.getDataset(target),
      attributes: this.getAttributes(target),
      html: target.outerHTML || ""
    };
    const text = JSON.stringify(payload, null, 2);
    this.copyText(text);

    const info = doc.getElementById(this.infoId);
    if (info) {
      info.style.display = "block";
      info.textContent = "Copied element info to clipboard";
      setTimeout(() => {
        if (info) info.textContent = "Use Copy button";
      }, 1200);
    }
    this.scheduleAutoHide();
  }

  handleClick(event) {
    if (!this.inspectActive) return;
    this.handleCopyButtonClick(event);
  }

  setInspectActive(enabled) {
    this.inspectActive = Boolean(enabled);
    const doc = this.api.app.getDocument?.();
    if (!doc) return;
    if (this.inspectActive) {
      doc.documentElement?.setAttribute("data-bf-redbox-active", "1");
      const info = doc.getElementById(this.infoId);
      if (info) {
        info.style.display = "block";
        info.textContent = `RedBox ON (${this.keybind} to toggle)`;
      }
    } else {
      doc.documentElement?.removeAttribute("data-bf-redbox-active");
      this.hideInspector();
    }
  }

  handleKeyDown(event) {
    if (!event || event.repeat) return;
    if (!this.matchesKeybind(event, this.keybind)) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
    this.setInspectActive(!this.inspectActive);
  }

  renderInspector(doc, target) {
    const rect = target.getBoundingClientRect();
    const overlay = doc.getElementById(this.overlayId);
    const info = doc.getElementById(this.infoId);
    const copyBtn = doc.getElementById(this.copyBtnId);
    const viewportWidth = doc.documentElement?.clientWidth || window.innerWidth || 1280;
    const viewportHeight = doc.documentElement?.clientHeight || window.innerHeight || 720;
    if (overlay) {
      overlay.style.display = "block";
      overlay.style.left = `${Math.round(rect.left)}px`;
      overlay.style.top = `${Math.round(rect.top)}px`;
      overlay.style.width = `${Math.max(0, Math.round(rect.width))}px`;
      overlay.style.height = `${Math.max(0, Math.round(rect.height))}px`;
    }

    let infoLeft = Math.round(rect.right + 10);
    if (infoLeft > viewportWidth - 340) {
      infoLeft = Math.max(8, Math.round(rect.left - 330));
    }
    let infoTop = Math.max(8, Math.round(rect.top));
    if (infoTop > viewportHeight - 140) {
      infoTop = Math.max(8, viewportHeight - 140);
    }

    if (info) {
      info.style.display = "block";
      info.style.left = `${infoLeft}px`;
      info.style.top = `${infoTop}px`;
      const selector = this.getSelector(target);
      const previewText = String(target.textContent || "").trim().slice(0, 120);
      info.textContent = `${selector}${previewText ? `\n${previewText}` : ""}\nUse Copy button`;
    }
    if (copyBtn) {
      copyBtn.style.display = "block";
      copyBtn.style.left = `${infoLeft}px`;
      copyBtn.style.top = `${Math.max(8, infoTop + 66)}px`;
    }

    this.scheduleAutoHide();
  }

  getSelector(node) {
    if (!node || !node.tagName) return "";
    if (node.id) return `#${node.id}`;
    const tag = String(node.tagName || "").toLowerCase();
    const classes = String(node.className || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((value) => `.${value}`)
      .join("");
    return `${tag}${classes}`;
  }

  getDataset(node) {
    const out = {};
    if (!node || !node.dataset) return out;
    for (const key of Object.keys(node.dataset)) {
      out[key] = node.dataset[key];
    }
    return out;
  }

  getAttributes(node) {
    const out = {};
    if (!node || !node.attributes) return out;
    for (const attr of Array.from(node.attributes)) {
      const name = String(attr.name || "");
      if (!name) continue;
      if (name === "style") continue;
      if (name.startsWith("on")) continue;
      out[name] = String(attr.value || "");
    }
    return out;
  }

  copyText(text) {
    try {
      const nav = this.api.app.getWindow?.()?.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
        nav.clipboard.writeText(String(text || ""));
        return;
      }
    } catch (_) {}
    try {
      const doc = this.api.app.getDocument?.();
      if (!doc) return;
      const ta = doc.createElement("textarea");
      ta.value = String(text || "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      doc.body.appendChild(ta);
      ta.focus();
      ta.select();
      doc.execCommand("copy");
      ta.remove();
    } catch (_) {}
  }

  loadConfig() {
    try {
      const bind = String(this.api.storage.get("keybind", this.keybind) || this.keybind).trim();
      const hide = Number(this.api.storage.get("autoHideMs", this.autoHideMs));
      if (bind) this.keybind = bind;
      if (Number.isFinite(hide) && hide >= 500) this.autoHideMs = Math.round(hide);
    } catch (_e) {}
  }

  getSettingsSchema() {
    return {
      title: "RedBox",
      description: "Inspector overlay settings.",
      controls: [
        { key: "keybind", type: "text", label: "Toggle keybind (e.g. Ctrl+Shift+X)", value: this.keybind },
        { key: "autoHideMs", type: "range", label: "Auto-hide delay (ms)", min: 500, max: 20000, step: 100, value: this.autoHideMs }
      ]
    };
  }

  setSettingValue(key, value) {
    const k = String(key || "");
    if (k === "keybind") {
      const bind = String(value || "").trim();
      if (bind) this.keybind = bind;
    }
    if (k === "autoHideMs") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 500) this.autoHideMs = Math.round(n);
    }
    try {
      this.api.storage.set("keybind", this.keybind);
      this.api.storage.set("autoHideMs", this.autoHideMs);
    } catch (_e) {}
    return { keybind: this.keybind, autoHideMs: this.autoHideMs };
  }

  matchesKeybind(event, keybind) {
    const parts = String(keybind || "")
      .toLowerCase()
      .split("+")
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return false;
    const needsCtrl = parts.includes("ctrl") || parts.includes("control");
    const needsShift = parts.includes("shift");
    const needsAlt = parts.includes("alt");
    const needsMeta = parts.includes("meta") || parts.includes("cmd") || parts.includes("command");
    const main = parts.find((p) => !["ctrl", "control", "shift", "alt", "meta", "cmd", "command"].includes(p));
    if (!main) return false;
    const key = String(event.key || "").toLowerCase();
    return (
      event.ctrlKey === needsCtrl &&
      event.shiftKey === needsShift &&
      event.altKey === needsAlt &&
      event.metaKey === needsMeta &&
      key === main
    );
  }
};
