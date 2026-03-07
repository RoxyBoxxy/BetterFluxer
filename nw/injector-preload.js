const injectorMain = require("./injector-main");

window.InjectorApi = {
  getDefaults: () => injectorMain.getDefaults(),
  getStatus: (options) => injectorMain.getStatus(options || {}),
  closeFluxer: () => injectorMain.closeFluxer(),
  inject: (options) => injectorMain.inject(options || {}),
  uninject: (options) => injectorMain.uninject(options || {}),
  installAppImage: (options) => injectorMain.installAppImage(options || {}),
  installLatestLinuxAppImage: () => injectorMain.installLatestLinuxAppImage()
};
