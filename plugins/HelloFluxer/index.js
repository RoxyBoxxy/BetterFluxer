module.exports = class HelloFluxerPlugin {
  constructor(api) {
    this.api = api;
  }

  start() {
    const launches = this.api.storage.get("launches", 0) + 1;
    this.api.storage.set("launches", launches);
    this.api.logger.info(`Hello from plugin. Launch #${launches}`);
  }

  stop() {
    this.api.logger.info("Goodbye from plugin.");
    this.api.patcher.unpatchAll();
  }
};
