(function(globalObj) {
  function readJson(keyLike, fallbackLike) {
    const key = String(keyLike || "").trim();
    if (!key) return fallbackLike;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallbackLike;
      const parsed = JSON.parse(raw);
      return parsed == null ? fallbackLike : parsed;
    } catch {
      return fallbackLike;
    }
  }

  function writeJson(keyLike, valueLike) {
    const key = String(keyLike || "").trim();
    if (!key) return false;
    try {
      localStorage.setItem(key, JSON.stringify(valueLike));
      return true;
    } catch {
      return false;
    }
  }

  function removeKey(keyLike) {
    const key = String(keyLike || "").trim();
    if (!key) return false;
    try {
      localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  globalObj.reportLocalJsonState = {
    readJson: readJson,
    writeJson: writeJson,
    removeKey: removeKey,
  };
})(typeof window !== "undefined" ? window : this);
