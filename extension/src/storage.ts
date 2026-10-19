export async function getStored<T>(key: string, fallback: T): Promise<T> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return (await chrome.storage.local.get(key))[key] as T ?? fallback;
  }
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') as T ?? fallback; } catch { return fallback; }
}

export async function setStored<T>(key: string, value: T): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [key]: value });
  } else {
    localStorage.setItem(key, JSON.stringify(value));
  }
}

export async function removeStored(key: string): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) await chrome.storage.local.remove(key);
  else localStorage.removeItem(key);
}
