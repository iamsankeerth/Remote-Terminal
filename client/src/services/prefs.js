/** Client preferences. Stored in local storage and never include authentication material. */
const KEY = 'remote-terminal.prefs.v1';

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    return { ...defaults(), ...parsed };
  } catch {
    return defaults();
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage may be unavailable; preferences are optional */
  }
}

export function defaults() {
  return { fontSize: 14, scrollback: 2000, toolbarVisible: true };
}

export default { loadPrefs, savePrefs, defaults };
