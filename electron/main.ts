/// <reference types="vite-plugin-electron/electron-env" />
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  systemPreferences,
  Tray,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceleratorForCode, isGloballySafe } from "../src/hotkeys.ts";

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
// Set by `before-quit`; the `close` handler hides to the tray until then.
let isQuitting = false;

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

let pendingUpdate: { version: string; url: string } | null = null;

/**
 * The banner is persisted exactly once, but only through a path where the
 * renderer really got it: an ACK on the push, or handing it over on the
 * renderer's mount-pull. Persisting right after `send` (the old behaviour)
 * meant a renderer that was still mounting lost the banner forever, because
 * the store already said "announced".
 */
function persistUpdateSeen() {
  if (pendingUpdate) rememberUpdateChecked(pendingUpdate.version);
}

function deliverUpdate() {
  if (!pendingUpdate || !win) return;
  win.webContents.send("nabra:update-available", pendingUpdate);
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
      pendingUpdate = { version: latest, url: data.html_url ?? "" };
      deliverUpdate();
    }
  } catch {
    // offline or unreachable; the periodic re-check retries
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

  // A tray app must survive the close button: routing can be live inside a
  // call, and killing the window would cut the user's voice mid-sentence.
  // Closing hides to the tray; only the tray's "خروج" really quits.
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  win.on("closed", () => {
    // The renderer's cleanup never runs when the page is destroyed, so
    // anything it registered with the OS has to be torn down here.
    try {
      globalShortcut.unregisterAll();
    } catch {
      // nothing registered
    }
    win = null;
  });
}

process.on("uncaughtException", (error) => {
  logError("uncaughtException", error);
});
process.on("unhandledRejection", (reason) => {
  logError("unhandledRejection", reason);
});

// ---------------------------------------------------------------------------
// Global hotkeys + system tray
// ---------------------------------------------------------------------------

function showWindow() {
  if (!win) {
    void createWindow().catch((error) => logError("createWindow", error));
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Registers the renderer's bindings as system-wide hotkeys; an empty object
 * unregisters everything. The renderer only registers while the window is
 * unfocused, so typing inside the app never fires a hotkey and a key press
 * never reaches both handlers.
 */
function setGlobalHotkeys(bindings: Record<string, string>): string[] {
  try {
    globalShortcut.unregisterAll();
  } catch {
    // nothing registered yet
  }
  const registered: string[] = [];
  for (const [action, code] of Object.entries(bindings)) {
    if (typeof code !== "string") continue;
    // `globalShortcut` signals the press only -- there is no global keyup --
    // so a hold-style action like PTT would engage and never release. It
    // stays an in-window shortcut by design.
    if (action === "ptt") continue;
    // Only F-keys register globally. A bare letter or Space registered with
    // the OS is swallowed in every other app too, so with nabra in the
    // background the user's spacebar and letters would silently drive the
    // voice changer instead of typing. Everything else stays in-window.
    if (!isGloballySafe(code)) continue;
    const accelerator = acceleratorForCode(code);
    if (!accelerator) continue;
    try {
      const ok = globalShortcut.register(accelerator, () => {
        win?.webContents.send("nabra:global-hotkey", { action });
      });
      // A hotkey already taken by the OS or another app is not fatal --
      // the in-window shortcut keeps working for that key.
      if (ok) registered.push(action);
    } catch (error) {
      logError("global-hotkey", error);
    }
  }
  return registered;
}

let tray: Tray | null = null;
const trayState = { running: false, muted: false };

function sendTrayAction(action: string) {
  win?.webContents.send("nabra:tray-action", action);
}

function rebuildTrayMenu() {
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: "إظهار نبرة", click: () => showWindow() },
    { type: "separator" },
    {
      label: trayState.running ? "إيقاف التوجيه" : "ابدأ التوجيه",
      click: () => sendTrayAction("toggle"),
    },
    {
      label: trayState.muted ? "إلغاء الكتم" : "كتم الصوت",
      click: () => sendTrayAction("mute"),
    },
    { type: "separator" },
    {
      label: "بدء التشغيل مع تسجيل الدخول",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        rebuildTrayMenu();
      },
    },
    { type: "separator" },
    { label: "خروج", click: () => app.quit() },
  ]));
}

function createTray() {
  try {
    const iconPath = resolveIcon();
    if (!iconPath) return;
    // The app icon ships at 1024×1024; the menu bar draws it at 16pt (22pt on
    // retina), so downscale here or the tray shows a huge, blurry bitmap.
    const icon = nativeImage.createFromPath(iconPath).resize(
      process.platform === "darwin"
        ? { width: 18, height: 18 }
        : { width: 16, height: 16 },
    );
    tray = new Tray(icon);
    tray.setToolTip("نبرة — موجّه الصوت");
    tray.on("click", () => showWindow());
    rebuildTrayMenu();
  } catch (error) {
    // A tray is a convenience; failing to create one must not stop startup.
    logError("tray", error);
  }
}

function registerIpc() {
  ipcMain.handle(
    "nabra:save-file",
    async (
      _event,
      payload: { defaultName?: unknown; data?: unknown },
    ): Promise<string | null> => {
      // A malformed invoke must reject cleanly, not throw deep inside the
      // dialog path on a missing property.
      const defaultName =
        typeof payload?.defaultName === "string" && payload.defaultName
          ? payload.defaultName.slice(0, 200)
          : "نبرة.json";
      const data = typeof payload?.data === "string" ? payload.data : "";
      const win = BrowserWindow.getAllWindows()[0];
      const options: Electron.SaveDialogOptions = {
        title: "حفظ في نبرة",
        defaultPath: defaultName,
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      await fs.promises.writeFile(result.filePath, data, "utf-8");
      return result.filePath;
    },
  );

  ipcMain.handle(
    "nabra:save-binary",
    async (
      _event,
      payload: { defaultName?: unknown; base64?: unknown },
    ): Promise<string | null> => {
      const defaultName =
        typeof payload?.defaultName === "string" && payload.defaultName
          ? payload.defaultName.slice(0, 200)
          : "نبرة.webm";
      const base64 = typeof payload?.base64 === "string" ? payload.base64 : "";
      const win = BrowserWindow.getAllWindows()[0];
      const options: Electron.SaveDialogOptions = {
        title: "حفظ في نبرة",
        defaultPath: defaultName,
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
        Buffer.from(base64, "base64"),
      );
      return result.filePath;
    },
  );

  // The renderer pulls any pending update banner on mount, so a notification
  // that arrived while its listener was not yet attached is not lost; handing
  // it over is the promise that the banner will be shown, so it counts as seen.
  ipcMain.handle(
    "nabra:get-pending-update",
    (): { version: string; url: string } | null => {
      if (pendingUpdate) persistUpdateSeen();
      return pendingUpdate;
    },
  );

  // Push path ACK: the renderer confirmed display of a banner it received
  // live (e.g. from the periodic re-check), so it never shows twice.
  ipcMain.on("nabra:update-seen", () => {
    persistUpdateSeen();
  });

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

  ipcMain.handle(
    "nabra:set-global-hotkeys",
    (_event, bindings: Record<string, string>): string[] =>
      setGlobalHotkeys(bindings && typeof bindings === "object" ? bindings : {}),
  );

  ipcMain.handle(
    "nabra:set-tray-state",
    (_event, state: { running?: boolean; muted?: boolean }): boolean => {
      trayState.running = Boolean(state?.running);
      trayState.muted = Boolean(state?.muted);
      rebuildTrayMenu();
      return true;
    },
  );
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
    createTray();

    // The one-shot check at startup can be missed by a window that was still
    // mounting; re-checking periodically gives the banner another chance and
    // announces genuinely new releases during a long session.
    setInterval(() => {
      void checkForUpdates();
    }, 6 * 60 * 60 * 1000);

    app.on("before-quit", () => {
      // Lets the window's `close` handler destroy instead of hiding.
      isQuitting = true;
    });

    app.on("activate", () => {
      // The window usually still exists, hidden to the tray.
      showWindow();
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
