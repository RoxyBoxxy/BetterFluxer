const path = require("path");
const { createBetterFluxer } = require("./betterfluxer");

if (require.main === module) {
  const runtime = createBetterFluxer({
    rootPath: process.cwd(),
    appContext: {
      version: "fluxer-dev"
    }
  });

  runtime.start();

  const plugins = runtime.listPlugins();
  // eslint-disable-next-line no-console
  console.log("Loaded plugins:", plugins.map((p) => p.id));

  process.on("SIGINT", () => {
    runtime.stop();
    process.exit(0);
  });
}

module.exports = {
  ...require("./betterfluxer"),
  PluginManager: require("./core/plugin-manager").PluginManager,
  Patcher: require("./core/patcher").Patcher
};
