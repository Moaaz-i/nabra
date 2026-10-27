/**
 * Shared mapping from `KeyboardEvent.code` values (what the shortcut settings
 * store) to Electron accelerator strings (what `globalShortcut` registers).
 *
 * Imported by the renderer (to mark keys that cannot be global) and by the
 * main process (to register), so the two sides can never disagree about which
 * keys work outside the window.
 */

/**
 * A bare modifier (ShiftLeft, ControlLeft, ...) has no Electron accelerator:
 * `globalShortcut` only accepts modifiers as part of a combination, so such
 * keys stay in-window. Letters, digits, F-keys and numpad digits can be
 * accelerators.
 */
export function acceleratorForCode(code: string): string | null {
  if (!code) return null;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const fKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fKey) return `F${fKey[1]}`;
  if (code === "Space") return "Space";
  if (/^Numpad[0-9]$/.test(code)) return `NumPad${code.slice(6)}`;
  return null;
}

/** True when this key can be an Electron accelerator at all. */
export function isGlobalKey(code: string): boolean {
  return acceleratorForCode(code) !== null;
}

/**
 * Only F-keys may be registered with the OS. A bare letter, digit or Space
 * registered via `globalShortcut` is swallowed system-wide: with the app in
 * the background (its normal state) typing a space or an "m" in Discord, a
 * browser or an editor would do nothing and silently toggle routing instead.
 * F-keys are the one family a normal typing session never touches.
 */
export function isGloballySafe(code: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(code);
}
