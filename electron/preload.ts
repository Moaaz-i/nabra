import { contextBridge, ipcRenderer } from 'electron'

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
  onUpdateAvailable: (
    cb: (info: { version: string; url: string }) => void,
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      info: { version: string; url: string },
    ) => cb(info)
    ipcRenderer.on('nabra:update-available', listener)
    return () => {
      ipcRenderer.removeListener('nabra:update-available', listener)
    }
  },
}

contextBridge.exposeInMainWorld('nabra', api)

export type NabraBridge = typeof api