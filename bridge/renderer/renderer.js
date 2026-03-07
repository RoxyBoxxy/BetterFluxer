const portInput = document.getElementById("portInput");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const refreshBtn = document.getElementById("refreshBtn");
const statusEl = document.getElementById("status");
const queryInput = document.getElementById("queryInput");
const searchBtn = document.getElementById("searchBtn");
const metaEl = document.getElementById("meta");
const resultsEl = document.getElementById("results");
const customNameInput = document.getElementById("customNameInput");
const customExeInput = document.getElementById("customExeInput");
const customPathInput = document.getElementById("customPathInput");
const customAddBtn = document.getElementById("customAddBtn");
const customMetaEl = document.getElementById("customMeta");
const customListEl = document.getElementById("customList");

function setStatus(value) {
  statusEl.textContent = JSON.stringify(value, null, 2);
}

function renderResults(items) {
  const list = Array.isArray(items) ? items : [];
  resultsEl.innerHTML = "";
  metaEl.textContent = `${list.length} result(s)`;
  for (const item of list) {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `<div class="name">${item.name || "Unknown"}</div><div class="path">${item.path || ""}</div>`;
    resultsEl.appendChild(row);
  }
}

function renderCustomApps(items) {
  const list = Array.isArray(items) ? items : [];
  customListEl.innerHTML = "";
  customMetaEl.textContent = `${list.length} custom app(s)`;
  for (const item of list) {
    const row = document.createElement("div");
    row.className = "item";
    const removeId = String(item.exe || "");
    row.innerHTML =
      `<div class="name">${item.name || "Unknown"}</div>` +
      `<div class="path">${item.exe || ""}${item.path ? " | " + item.path : ""}</div>` +
      `<button class="warn" data-remove-exe="${removeId}">Remove</button>`;
    customListEl.appendChild(row);
  }
  customListEl.querySelectorAll("[data-remove-exe]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const exe = btn.getAttribute("data-remove-exe") || "";
      const updated = await window.BridgeApi.removeCustomApp(exe);
      renderCustomApps(updated);
    });
  });
}

async function refreshStatus() {
  const status = await window.BridgeApi.getStatus();
  setStatus(status);
}

startBtn.addEventListener("click", async () => {
  const port = Number.parseInt(String(portInput.value || "21864"), 10) || 21864;
  const result = await window.BridgeApi.start({ port });
  setStatus(result);
  await refreshStatus();
});

stopBtn.addEventListener("click", async () => {
  const result = await window.BridgeApi.stop();
  setStatus(result);
  await refreshStatus();
});

refreshBtn.addEventListener("click", async () => {
  await refreshStatus();
});

searchBtn.addEventListener("click", async () => {
  const results = await window.BridgeApi.searchGames(queryInput.value.trim());
  renderResults(results);
});

queryInput.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    const results = await window.BridgeApi.searchGames(queryInput.value.trim());
    renderResults(results);
  }
});

customAddBtn.addEventListener("click", async () => {
  const payload = {
    name: customNameInput.value.trim(),
    exe: customExeInput.value.trim(),
    path: customPathInput.value.trim()
  };
  if (!payload.name || !payload.exe) {
    customMetaEl.textContent = "Name and exe are required.";
    return;
  }
  try {
    const updated = await window.BridgeApi.addCustomApp(payload);
    customNameInput.value = "";
    customExeInput.value = "";
    customPathInput.value = "";
    renderCustomApps(updated);
  } catch (error) {
    customMetaEl.textContent = `Add failed: ${error.message}`;
  }
});

refreshStatus();
window.BridgeApi.getCustomApps().then(renderCustomApps).catch(() => {});
