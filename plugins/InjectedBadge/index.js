module.exports = class InjectedBadgePlugin {
  constructor(api) {
    this.api = api;
    this.elementId = "betterfluxer-injected-badge";
  }

  start() {
    const doc = this.api.app.getDocument?.();
    if (!doc || doc.getElementById(this.elementId)) return;

    const badge = doc.createElement("div");
    badge.id = this.elementId;
    badge.textContent = "BetterFluxer Injected";
    badge.style.position = "fixed";
    badge.style.right = "12px";
    badge.style.bottom = "12px";
    badge.style.padding = "8px 12px";
    badge.style.background = "#111";
    badge.style.color = "#f5f5f5";
    badge.style.font = "600 12px/1.2 system-ui, sans-serif";
    badge.style.zIndex = "999999";
    badge.style.borderRadius = "10px";
    badge.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35)";
    doc.body.appendChild(badge);

    this.api.logger.info("Injected badge mounted.");
  }

  stop() {
    const doc = this.api.app.getDocument?.();
    const badge = doc?.getElementById(this.elementId);
    if (badge) badge.remove();
    this.api.logger.info("Injected badge unmounted.");
  }
};
