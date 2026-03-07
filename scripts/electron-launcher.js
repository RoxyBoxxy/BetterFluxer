#!/usr/bin/env node
const path = require("path");
const { spawn } = require("child_process");

function hasArg(args, name) {
  return args.some((arg) => String(arg) === name || String(arg).startsWith(`${name}=`));
}

function main() {
  const entry = process.argv[2];
  const passthroughArgs = process.argv.slice(3);

  if (!entry) {
    // eslint-disable-next-line no-console
    console.error("[BetterFluxer] Missing Electron entry file.");
    process.exit(1);
  }

  const electronBin = require("electron");
  const entryPath = path.resolve(entry);
  const env = { ...process.env };
  const electronArgs = [];

  if (process.platform === "linux") {
    if (!env.ELECTRON_OZONE_PLATFORM_HINT) env.ELECTRON_OZONE_PLATFORM_HINT = "x11";
    if (!env.OZONE_PLATFORM) env.OZONE_PLATFORM = "x11";
    if (!env.GDK_BACKEND) env.GDK_BACKEND = "x11";

    if (!hasArg(passthroughArgs, "--gtk-version")) {
      electronArgs.push("--gtk-version=3");
    }

    // Avoid hard crashes on Linux setups where Chromium GPU process cannot initialize.
    if (!hasArg(passthroughArgs, "--disable-gpu")) {
      electronArgs.push("--disable-gpu");
    }
    if (!hasArg(passthroughArgs, "--disable-gpu-sandbox")) {
      electronArgs.push("--disable-gpu-sandbox");
    }
    if (!hasArg(passthroughArgs, "--disable-software-rasterizer")) {
      electronArgs.push("--use-gl=swiftshader");
    }
  }

  electronArgs.push(entryPath, ...passthroughArgs);

  const child = spawn(electronBin, electronArgs, {
    stdio: "inherit",
    env,
    windowsHide: false
  });

  child.on("close", (code, signal) => {
    if (code === null) {
      // eslint-disable-next-line no-console
      console.error(`[BetterFluxer] Electron exited with signal ${signal}`);
      process.exit(1);
    }
    process.exit(code);
  });
}

main();
