// Guarded localStorage (W1). With site data blocked (Safari "Block All
// Cookies", some private modes) even READING `window.localStorage` throws —
// and an uncaught throw at the top level of the boot ends the game before it
// starts. Every remembered preference goes through these two: blocked
// storage reads as unset and swallows writes, so play works and only the
// remembering is lost.

/** The stored value, or null when absent or storage is blocked. */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Persist a value; a no-op when storage is blocked or full. */
export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the value still applies for this visit.
  }
}
