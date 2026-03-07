class Patcher {
  constructor() {
    this._patches = new Map();
  }

  before(namespace, target, method, callback) {
    return this._patch("before", namespace, target, method, callback);
  }

  after(namespace, target, method, callback) {
    return this._patch("after", namespace, target, method, callback);
  }

  instead(namespace, target, method, callback) {
    return this._patch("instead", namespace, target, method, callback);
  }

  unpatchAll(namespace) {
    const patches = this._patches.get(namespace);
    if (!patches) return;
    for (let i = patches.length - 1; i >= 0; i -= 1) {
      const unpatch = patches[i];
      try {
        unpatch();
      } catch (_) {
        // best-effort teardown
      }
    }
    this._patches.delete(namespace);
  }

  _patch(type, namespace, target, method, callback) {
    if (!target || typeof target[method] !== "function") {
      throw new Error(`Cannot patch ${String(method)}: target method is not a function`);
    }

    const original = target[method];

    const wrapped = (...args) => {
      if (type === "before") {
        callback(args);
        return original.apply(target, args);
      }

      if (type === "instead") {
        return callback(args, original.bind(target));
      }

      const result = original.apply(target, args);
      callback(args, result);
      return result;
    };

    target[method] = wrapped;

    const unpatch = () => {
      if (target[method] === wrapped) {
        target[method] = original;
      }
    };

    if (!this._patches.has(namespace)) {
      this._patches.set(namespace, []);
    }
    this._patches.get(namespace).push(unpatch);

    return () => {
      unpatch();
      const namespacePatches = this._patches.get(namespace);
      if (!namespacePatches) return;
      const index = namespacePatches.indexOf(unpatch);
      if (index !== -1) {
        namespacePatches.splice(index, 1);
      }
      if (namespacePatches.length === 0) {
        this._patches.delete(namespace);
      }
    };
  }
}

module.exports = {
  Patcher
};
