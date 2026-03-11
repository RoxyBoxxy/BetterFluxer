#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function copyRecursive(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function applyPatchAssets(sourceRoot, checkoutRoot) {
  const assetRoot = path.join(sourceRoot, "scripts", "assets", "fluxer_desktop");
  if (!fs.existsSync(assetRoot)) {
    throw new Error(`Patch asset root not found: ${assetRoot}`);
  }

  const targets = [
    {
      src: path.join(assetRoot, "src", "main", "Window.tsx"),
      dest: path.join(checkoutRoot, "fluxer_desktop", "src", "main", "Window.tsx")
    },
    {
      src: path.join(assetRoot, "src", "main", "IpcHandlers.tsx"),
      dest: path.join(checkoutRoot, "fluxer_desktop", "src", "main", "IpcHandlers.tsx")
    },
    {
      src: path.join(assetRoot, "scripts", "build.mjs"),
      dest: path.join(checkoutRoot, "fluxer_desktop", "scripts", "build.mjs")
    }
  ];

  for (const target of targets) {
    if (!fs.existsSync(target.src)) {
      throw new Error(`Patch asset missing: ${target.src}`);
    }
    ensureDir(path.dirname(target.dest));
    fs.copyFileSync(target.src, target.dest);
  }
}

function main() {
  const sourceRoot = path.resolve(__dirname, "..");
  const cacheRoot = path.join(sourceRoot, "cache", "linux-desktop-bundle");
  const tmpRoot = path.join(sourceRoot, "cache", ".tmp-fluxer-source");
  const fluxerRepoUrl = process.env.FLUXER_SOURCE_REPO || "https://github.com/fluxerapp/fluxer.git";
  const fluxerRepoRef = String(process.env.FLUXER_SOURCE_REF || "").trim();

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  ensureDir(path.dirname(tmpRoot));

  const cloneArgs = ["clone", "--depth", "1"];
  if (fluxerRepoRef) {
    cloneArgs.push("--branch", fluxerRepoRef);
  }
  cloneArgs.push(fluxerRepoUrl, tmpRoot);
  run("git", cloneArgs, { cwd: sourceRoot });
  applyPatchAssets(sourceRoot, tmpRoot);

  const desktopRoot = path.join(tmpRoot, "fluxer_desktop");
  run("npm", ["ci"], { cwd: desktopRoot });
  run("node", ["scripts/build.mjs"], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      NODE_ENV: "production"
    }
  });

  ensureDir(path.join(cacheRoot, "dist", "main"));
  fs.copyFileSync(path.join(desktopRoot, "dist", "main", "index.js"), path.join(cacheRoot, "dist", "main", "index.js"));
  copyRecursive(path.join(desktopRoot, "node_modules", "@electron", "asar"), path.join(cacheRoot, "node_modules", "@electron", "asar"));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(
    `[BetterFluxer] Linux desktop bundle prepared from ${fluxerRepoUrl}${fluxerRepoRef ? `#${fluxerRepoRef}` : ""}`
  );
}

main();
