import { contextBridge, ipcRenderer } from 'electron'
import type { NabraBridge } from '../src/nabra-bridge.ts'

const api = {
  platform: process.platform,
  saveFile: (defaultName: string, data: string): Promise<string | null> =>
    ipcRenderer.invoke('nabra:save-file', { defaultName, data }),
  saveBinary: (defaultName: string, base64: string): Promise<string | null> =>
    ipcRenderer.invoke('nabra:save-binary', { defaultName, base64 }),
  openFile: (): Promise<string | null> => ipcRenderer.invoke('nabra:open-file'),
  setAlwaysOnTop: (flag: boolean): Promise<boolean> =>
    ipcRenderer.invoke('nabra:set-always-on-top', flag),
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('nabra:open-external', url),
  setGlobalHotkeys: (bindings: Record<string, string>): Promise<string[]> =>
    ipcRenderer.invoke('nabra:set-global-hotkeys', bindings),
  onGlobalHotkey: (
    cb: (info: { action: string }) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      info: { action: string },
    ) => cb(info)
    ipcRenderer.on('nabra:global-hotkey', listener)
    return () => {
      ipcRenderer.removeListener('nabra:global-hotkey', listener)
    }
  },
  setTrayState: (state: { running: boolean; muted: boolean }): Promise<boolean> =>
    ipcRenderer.invoke('nabra:set-tray-state', state),
  onTrayAction: (cb: (action: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: string) =>
      cb(action)
    ipcRenderer.on('nabra:tray-action', listener)
    return () => {
      ipcRenderer.removeListener('nabra:tray-action', listener)
    }
  },
  onUpdateAvailable: (
    cb: (info: import('../src/nabra-bridge.ts').UpdateInfo) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      info: import('../src/nabra-bridge.ts').UpdateInfo,
    ) => cb(info)
    ipcRenderer.on('nabra:update-available', listener)
    return () => {
      ipcRenderer.removeListener('nabra:update-available', listener)
    }
  },
  getPendingUpdate: (): Promise<import('../src/nabra-bridge.ts').UpdateInfo | null> =>
    ipcRenderer.invoke('nabra:get-pending-update'),
  ackUpdate: (): void => ipcRenderer.send('nabra:update-seen'),
}

// Compile-time guard: if `api` ever drifts from the declared bridge shape,
// this assignment fails the build instead of `window.nabra` silently losing
// a method at runtime.
const _bridgeCheck: NabraBridge = api
void _bridgeCheck

contextBridge.exposeInMainWorld('nabra', api)

export type { NabraBridge }