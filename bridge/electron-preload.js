const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("BridgeApi", {
  getStatus: () => ipcRenderer.invoke("bridge:status"),
  start: (options) => ipcRenderer.invoke("bridge:start", options || {}),
  stop: () => ipcRenderer.invoke("bridge:stop"),
  searchGames: (query) => ipcRenderer.invoke("bridge:search-games", { query: String(query || "") }),
  getCustomApps: () => ipcRenderer.invoke("bridge:get-custom-apps"),
  addCustomApp: (payload) => ipcRenderer.invoke("bridge:add-custom-app", payload || {}),
  removeCustomApp: (exe) => ipcRenderer.invoke("bridge:remove-custom-app", { exe: String(exe || "") })
});
