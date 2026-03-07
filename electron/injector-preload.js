const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("InjectorApi", {
  getDefaults: () => ipcRenderer.invoke("injector:defaults"),
  getStatus: (options) => ipcRenderer.invoke("injector:status", options || {}),
  closeFluxer: () => ipcRenderer.invoke("injector:close-fluxer"),
  inject: (options) => ipcRenderer.invoke("injector:inject", options || {}),
  uninject: (options) => ipcRenderer.invoke("injector:uninject", options || {}),
  installAppImage: (options) => ipcRenderer.invoke("injector:install-appimage", options || {}),
  installLatestLinuxAppImage: () => ipcRenderer.invoke("injector:install-latest-linux-appimage")
});
