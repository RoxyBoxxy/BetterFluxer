module.exports = class LagFixPlugin {
  constructor(api) {
    this.api = api;
    this.styleId = "betterfluxer-lagfix-style";
  }

  start() {
    const doc = this.api.app.getDocument?.();
    if (!doc) return;
    if (doc.getElementById(this.styleId)) return;

    const style = doc.createElement("style");
    style.id = this.styleId;
    style.textContent = [
      "html.reduced-motion *,",
      "html.reduced-motion *::before,",
      "html.reduced-motion *::after {",
      "  animation: none !important;",
      "  transition: none !important;",
      "  scroll-behavior: auto !important;",
      "}"
    ].join("\n");

    doc.head.appendChild(style);
    this.api.logger.info("LagFix enabled.");
  }

  stop() {
    const doc = this.api.app.getDocument?.();
    if (!doc) return;
    const style = doc.getElementById(this.styleId);
    if (style) style.remove();
    this.api.logger.info("LagFix disabled.");
  }
};
