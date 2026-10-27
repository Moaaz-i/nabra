/**
 * The shape of the `window.nabra` bridge, defined without any Electron
 * imports so the renderer's type program never pulls in Electron's typings
 * (which need Node's globals). `electron/preload.ts` is checked against this
 * type at compile time, so the two can never drift apart silently.
 */

export type UpdateInfo = { version: string; url: string };

export type NabraBridge = {
  platform: string;
  saveFile: (defaultName: string, data: string) => Promise<string | null>;
  saveBinary: (
    defaultName: string,
    base64: string,
  ) => Promise<string | null>;
  openFile: () => Promise<string | null>;
  setAlwaysOnTop: (flag: boolean) => Promise<boolean>;
  openExternal: (url: string) => Promise<boolean>;
  setGlobalHotkeys: (bindings: Record<string, string>) => Promise<string[]>;
  onGlobalHotkey: (cb: (info: { action: string }) => void) => () => void;
  setTrayState: (state: {
    running: boolean;
    muted: boolean;
  }) => Promise<boolean>;
  onTrayAction: (cb: (action: string) => void) => () => void;
  onUpdateAvailable: (cb: (info: UpdateInfo) => void) => () => void;
  getPendingUpdate: () => Promise<UpdateInfo | null>;
  /** Confirms the update banner was received live, so it won't show twice. */
  ackUpdate: () => void;
};
