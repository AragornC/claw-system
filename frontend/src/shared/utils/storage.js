export function safeLocalJsonRead(key, fallbackValue) {
  try {
    const raw = localStorage.getItem(String(key || ''));
    if (!raw) return fallbackValue;
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

export function safeLocalJsonWrite(key, value) {
  try {
    localStorage.setItem(String(key || ''), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function safeLocalRemove(key) {
  try {
    localStorage.removeItem(String(key || ''));
    return true;
  } catch {
    return false;
  }
}
