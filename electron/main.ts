/// <reference types="vite-plugin-electron/electron-env" />
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  systemPreferences,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// A top-level `return` is a syntax error in an ES module, so the whole startup
// path is guarded by `isPrimaryInstance` instead. Without the guard a second
// launch called `app.quit()` and then carried on to `whenReady`, which opened
// a second window in the dying process and fought over the audio device.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

let win: BrowserWindow | null = null;

function logError(context: string, error: unknown) {
  try {
    const dir = app.getPath("userData");
    // userData is created lazily and may not exist on a first run.
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // already there, or not writable
    }
    const line =
      `[${new Date().toISOString()}] ${context}: ` +
      (error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`
        : String(error)) +
      "\n";
    fs.appendFileSync(path.join(dir, "nabra-error.log"), line);
  } catch {
    // logging must never crash the app
  }
}

const UPDATE_OWNER = process.env.NABRA_GH_OWNER ?? "moaaz-i";
const UPDATE_REPO = "nabra";
const UPDATE_CHECKED_KEY = "nabra-update-checked";

function updateState(): Record<string, string> {
  try {
    const raw = fs.readFileSync(
      path.join(app.getPath("userData"), "store.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(raw);
    // A hand-edited or truncated store used to cast straight to a record, and
    // writing a property onto a number or an array throws in strict mode --
    // which silently disabled update checks for good.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function rememberUpdateChecked(version: string) {
  try {
    const store = updateState();
    store[UPDATE_CHECKED_KEY] = version;
    fs.writeFileSync(
      path.join(app.getPath("userData"), "store.json"),
      JSON.stringify(store),
      "utf-8",
    );
  } catch {
    // non-fatal
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function checkForUpdates() {
  if (isDev || !win) return;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`,
      { headers: { "User-Agent": "nabra" } },
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
    };
    const latest = data.tag_name ?? "";
    const next = latest.replace(/^v/i, "");
    const current = app.getVersion();
    if (next && next !== current && compareVersions(next, current) > 0) {
      if (updateState()[UPDATE_CHECKED_KEY] === next) return;
      rememberUpdateChecked(next);
      win.webContents.send("nabra:update-available", {
        version: latest,
        url: data.html_url ?? "",
      });
    }
  } catch {
    // offline or unreachable; retry next launch
  }
}

function resolveIcon(): string | undefined {
  const iconPath = path.join(__dirname, "../build/icon.png");
  if (isDev || fs.existsSync(iconPath)) return iconPath;
  return undefined;
}

/**
 * Permission policy for the whole app. These used to be set up inside
 * `createWindow`, so they were re-registered every time the window was rebuilt
 * (macOS re-activate, second instance).
 */
function configureSession(target: Electron.Session) {
  // The renderer only ever needs the microphone; anything else is refused
  // rather than silently granted.
  target.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  target.setPermissionCheckHandler((_wc, permission) => permission === "media");
}

async function createWindow() {
  if (process.platform === "darwin" && isDev) {
    try {
      await systemPreferences.askForMediaAccess("microphone");
    } catch {
      // fall through; the renderer also requests mic permission
    }
  }

  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 780,
    backgroundColor: "#08090d",
    title: "نبرة — موجّه الصوت",
    icon: process.platform === "darwin" ? undefined : resolveIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandboxed preloads must be CommonJS; this one is bundled to
      // `preload.mjs`, so the sandbox has to stay off. Context isolation and
      // the navigation policy are what keep the renderer contained.
      sandbox: false,
      // Electron throttles timers, rAF and the audio pipeline in a background
      // window. For a voice changer that is the normal state -- the window sits
      // behind Discord while it is being used -- and throttling it froze the
      // gate, the AGC and adaptive tracking. The renderer runs a 16 ms control
      // loop and nothing else expensive, so the cost is negligible.
      backgroundThrottling: false,
    },
  });

  if (process.platform !== "darwin") {
    win.setMenuBarVisibility(false);
  }

  // The renderer holds the mic, so any attempt to navigate the window away
  // from the bundled app (or open a second window) must be refused.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    const current = win?.webContents.getURL();
    if (current && url !== current) {
      event.preventDefault();
      logError("will-navigate", new Error(`blocked: ${url}`));
    }
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (isDev && input.key === "F12") {
      win?.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    logError("render-process-gone", details.reason);
  });

  win.on("unresponsive", () => {
    logError("unresponsive", new Error("Window became unresponsive"));
  });

  win.once("ready-to-show", () => {
    win?.show();
    void checkForUpdates();
  });

  try {
    if (isDev) {
      await win.loadURL(process.env.VITE_DEV_SERVER_URL!);
    } else {
      await win.loadFile(path.join(__dirname, "../dist/index.html"));
    }
  } catch (err) {
    logError("load", err);
    throw err;
  }

  win.on("closed", () => {
    win = null;
  });
}

process.on("uncaughtException", (error) => {
  logError("uncaughtException", error);
});
process.on("unhandledRejection", (reason) => {
  logError("unhandledRejection", reason);
});

function registerIpc() {
  ipcMain.handle(
    "nabra:save-file",
    async (
      _event,
      payload: { defaultName: string; data: string },
    ): Promise<string | null> => {
      const win = BrowserWindow.getAllWindows()[0];
      const options: Electron.SaveDialogOptions = {
        title: "حفظ في نبرة",
        defaultPath: payload.defaultName,
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      await fs.promises.writeFile(result.filePath, payload.data, "utf-8");
      return result.filePath;
    },
  );

  ipcMain.handle(
    "nabra:save-binary",
    async (
      _event,
      payload: { defaultName: string; base64: string },
    ): Promise<string | null> => {
      const win = BrowserWindow.getAllWindows()[0];
      const options: Electron.SaveDialogOptions = {
        title: "حفظ في نبرة",
        defaultPath: payload.defaultName,
        filters: [
          { name: "تسجيل صوتي", extensions: ["webm"] },
          { name: "كل الملفات", extensions: ["*"] },
        ],
      };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      await fs.promises.writeFile(
        result.filePath,
        Buffer.from(payload.base64, "base64"),
      );
      return result.filePath;
    },
  );

  ipcMain.handle("nabra:open-file", async (): Promise<string | null> => {
    const win = BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = {
      title: "استيراد مسبق من نبرة",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return await fs.promises.readFile(result.filePaths[0]!, "utf-8");
  });

  ipcMain.handle("nabra:set-always-on-top", (_event, flag: boolean) => {
    for (const w of BrowserWindow.getAllWindows()) w.setAlwaysOnTop(flag);
    return flag;
  });

  ipcMain.handle("nabra:open-external", (_event, url: string) => {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
      return true;
    }
    return false;
  });
}

if (isPrimaryInstance) {
  app.whenReady().then(() => {
    app.setAppUserModelId("com.nabra.voice");
    registerIpc();
    configureSession(session.defaultSession);

    if (process.platform === "darwin" && isDev) {
      try {
        app.dock?.setIcon(
          resolveIcon() ?? path.join(__dirname, "../build/icon.png"),
        );
      } catch (error) {
        logError("dockIcon", error);
      }
    }

    void createWindow().catch((error) => logError("createWindow", error));

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch((error) => logError("createWindow", error));
      }
    });

    app.on("second-instance", () => {
      const existing = BrowserWindow.getAllWindows()[0];
      if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.focus();
      } else {
        void createWindow().catch((error) => logError("createWindow", error));
      }
    });

    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") {
        app.quit();
      }
    });
  });
}
