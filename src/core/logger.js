const LEVELS = ["debug", "info", "warn", "error"];

function formatScope(scope) {
  return scope ? `[BetterFluxer:${scope}]` : "[BetterFluxer]";
}

function write(level, scope, ...args) {
  const method = LEVELS.includes(level) ? level : "info";
  const prefix = formatScope(scope);
  // eslint-disable-next-line no-console
  console[method](prefix, ...args);
}

function createLogger(scope) {
  return {
    debug: (...args) => write("debug", scope, ...args),
    info: (...args) => write("info", scope, ...args),
    warn: (...args) => write("warn", scope, ...args),
    error: (...args) => write("error", scope, ...args)
  };
}

module.exports = {
  createLogger
};
