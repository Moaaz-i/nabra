import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  isVirtualDevice,
  listDevices,
  requestAudioAccess,
  virtualDriverUrl,
  virtualHint,
} from "./audio/devices";
import {
  defaultSettings,
  sanitizeSettings,
  VoiceRouter,
  type AnalysisFrame,
  type VoiceSettings,
} from "./audio/engine";
import { midiToHz, midiToName, NOTE_NAMES } from "./audio/notes";
import {
  calibrateMic,
  captureMic,
  type Calibration,
  type CapturePhase,
} from "./audio/calibrate";
import { isGloballySafe } from "./hotkeys";
import {
  loadCustomPresets,
  removeCustomPreset,
  saveCustomPresets,
  STUDIO_PRESETS,
  type CustomPreset,
} from "./audio/presets";

const STORAGE_KEY = "nabra-studio-v3";
const PREF_KEY = "nabra-prefs-v1";
/** Upper bound on how long stopping the engine waits for a MediaRecorder. */
const RECORDER_STOP_TIMEOUT_MS = 1500;

/**
 * One object per recording: the recorder, its own chunk list, and the
 * resolver `stopActiveRecorder` waits on. Sharing chunk/stop state across
 * recordings let a late `onstop` from a torn-down recorder wipe or merge
 * the next take's data.
 */
type ActiveRecording = {
  rec: MediaRecorder;
  chunks: Blob[];
  resolve: () => void;
};

type Bindings = {
  toggle: string;
  mute: string;
  bypass: string;
  ptt: string;
};

type Prefs = {
  bindings: Bindings;
  alwaysOnTop: boolean;
  compact: boolean;
};

const DEFAULT_BINDINGS: Bindings = {
  toggle: "Space",
  mute: "KeyM",
  bypass: "KeyB",
  ptt: "ShiftLeft",
};

const DEFAULT_PREFS: Prefs = {
  bindings: DEFAULT_BINDINGS,
  alwaysOnTop: false,
  compact: false,
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      bindings: { ...DEFAULT_BINDINGS, ...(parsed.bindings ?? {}) },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function persistPrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be full or disabled. This runs inside a React state
    // updater and the app has no error boundary, so a throw here would
    // blank the whole UI -- the in-memory prefs are good enough.
  }
}

const emptyFrame: AnalysisFrame = {
  rms: 0,
  rmsDb: -96,
  outDb: -96,
  peakDb: -96,
  detectedHz: null,
  detectedNote: "—",
  referenceHz: midiToHz(60),
  referenceNote: "C4",
  ratio: 1,
  cents: 0,
  appliedSemitones: 0,
  agcGain: 1,
  latencyMs: 0,
  pitchLatencyMs: 0,
  sampleRate: 48000,
  clipping: false,
  bypass: false,
  sinkFallback: false,
  speechProb: 0,
  speaking: false,
  vadActive: false,
  feedbackDetected: false,
  denoiserActive: false,
  studioEnhancerActive: false,
};

type Saved = {
  inputId?: string;
  outputId?: string;
  settings?: Partial<VoiceSettings>;
};

type EngineTab = "pitch" | "mic" | "tone" | "effects" | "dyn" | "isolation";

function loadSaved(): Saved {
  try {
    const raw =
      localStorage.getItem(STORAGE_KEY) ??
      localStorage.getItem("nabra-studio-v1");
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // localStorage is untrusted: a hand-edited or truncated value must not be
    // able to hand `undefined` to the device <select> or a bad knob to the
    // audio graph, so every field is checked before it is used.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    const saved: Saved = {};
    if (typeof obj.inputId === "string") saved.inputId = obj.inputId;
    if (typeof obj.outputId === "string") saved.outputId = obj.outputId;
    if (obj.settings && typeof obj.settings === "object") {
      saved.settings = sanitizeSettings(obj.settings);
    }
    return saved;
  } catch {
    return {};
  }
}

function writeSaved(value: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Quota exhausted or storage disabled: the app still works, it just will
    // not remember the session.
  }
}

function downloadInBrowser(filename: string, parts: BlobPart[], type: string) {
  const blob = new Blob(parts, { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function saveTextFile(filename: string, data: string) {
  if (window.nabra) {
    await window.nabra.saveFile(filename, data);
  } else {
    downloadInBrowser(filename, [data], "application/json");
  }
}

async function saveRecordingFile(filename: string, base64: string) {
  if (window.nabra) {
    await window.nabra.saveBinary(filename, base64);
  } else {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    downloadInBrowser(filename, [bytes], "audio/webm");
  }
}

async function openTextFile(): Promise<string | null> {
  if (window.nabra) return await window.nabra.openFile();
  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}

function openExternal(url: string) {
  if (window.nabra) {
    void window.nabra.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

function platformOf(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const raw =
    window.nabra?.platform ??
    nav.userAgentData?.platform ??
    navigator.platform ??
    "";
  const ua = (navigator.userAgent || "").toLowerCase();
  if (/mac|darwin|iphone|ipad/i.test(raw) || /mac/i.test(ua)) return "darwin";
  if (/win/i.test(raw) || /win/i.test(ua)) return "win32";
  if (/linux|android/i.test(raw) || /linux/i.test(ua)) return "linux";
  return "win32";
}

const globalRouter = new VoiceRouter();

export default function App() {
  const router = globalRouter;
  const [saved] = useState(loadSaved);
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState(saved.inputId ?? "");
  const [outputId, setOutputId] = useState(saved.outputId ?? "");
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<EngineTab>("pitch");
  const [frame, setFrame] = useState<AnalysisFrame>(emptyFrame);
  const [settings, setSettings] = useState<VoiceSettings>(() =>
    sanitizeSettings(saved.settings),
  );
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [customPresets, setCustomPresets] =
    useState<CustomPreset[]>(loadCustomPresets);
  const [recording, setRecording] = useState(false);
  const [calibrating, setCalibrating] = useState<CapturePhase | "analyzing" | null>(
    null,
  );
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    url: string;
  } | null>(null);
  const recordingRef = useRef<ActiveRecording | null>(null);
  const pttDownRef = useRef(false);
  /** Mute state to put back when a push-to-talk key is released. */
  const muteBeforePttRef = useRef<boolean | null>(null);
  /** Mirrors `calibrating` for synchronous guards (toggle, tray, hotkeys). */
  const calibratingRef = useRef(false);
  /** Actions that failed to register globally (already taken by the OS). */
  const [globalFailures, setGlobalFailures] = useState<
    (keyof Bindings)[] | null
  >(null);
  const [rebinding, setRebinding] = useState<keyof Bindings | null>(null);
  const rebindingRef = useRef(false);
  const [testingVoice, setTestingVoice] = useState(false);
  const [testCountdown, setTestCountdown] = useState(0);

  const setPrefs = useCallback((updater: (current: Prefs) => Prefs) => {
    setPrefsState((current) => {
      const next = updater(current);
      persistPrefs(next);
      return next;
    });
  }, []);

  const platform = platformOf();
  const hint = virtualHint(platform);
  const hasVirtualOut = outputs.some((d) => isVirtualDevice(d.label));
  const runningRef = useRef(running);
  const busyRef = useRef(busy);
  const inputIdRef = useRef(inputId);
  const outputIdRef = useRef(outputId);
  const settingsRef = useRef(settings);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    inputIdRef.current = inputId;
  }, [inputId]);
  useEffect(() => {
    outputIdRef.current = outputId;
  }, [outputId]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    router.applySettings(settings);
    router.onFrame = setFrame;
  }, [router, settings]);

  // Persisting on every tick of a slider drag means dozens of synchronous
  // `JSON.stringify` + `localStorage.setItem` writes per second, which is both
  // slow and a source of jank while dragging. Debounce it, but flush on the way
  // out so closing the window inside the debounce window cannot lose a change.
  const persistRef = useRef({ inputId, outputId, settings });
  useEffect(() => {
    persistRef.current = { inputId, outputId, settings };
    const id = window.setTimeout(() => {
      writeSaved(persistRef.current);
    }, 250);
    return () => window.clearTimeout(id);
  }, [settings, inputId, outputId]);
  useEffect(() => {
    const flush = (): void => {
      writeSaved(persistRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  useEffect(() => {
    return () => {
      void router.stop();
    };
  }, [router]);

  useEffect(() => {
    const off = window.nabra?.onUpdateAvailable((info: {
      version: string;
      url: string;
    }) => {
      setUpdateInfo(info);
      // Live push received → tell main it can count the banner as shown.
      window.nabra?.ackUpdate();
    });
    // The push can land before this listener exists; the main process keeps
    // the banner pending and hands it over to any renderer that asks.
    void window.nabra
      ?.getPendingUpdate()
      .then((info) => {
        if (info) setUpdateInfo(info);
      })
      .catch(() => undefined);
    return off;
  }, []);

  const targetNotes = useMemo(() => {
    const notes = [];
    for (let midi = 36; midi <= 84; midi++) {
      notes.push({ midi, name: midiToName(midi) });
    }
    return notes;
  }, []);

  // `rec.stop()` only fires `onstop` asynchronously, and never at all if the
  // track ends first, so the wait is bounded. Every path that tears the
  // engine down while a recording is live must go through here, otherwise
  // `recording` stays true with no way to clear it from the UI.
  const stopActiveRecorder = useCallback(async () => {
    const active = recordingRef.current;
    if (!active || active.rec.state === "inactive") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // The recorder never reported a stop; reclaim the state so the
        // button cannot stay stuck for the rest of the session.
        if (recordingRef.current === active) {
          recordingRef.current = null;
          setRecording(false);
        }
        resolve();
      }, RECORDER_STOP_TIMEOUT_MS);
      const previous = active.resolve;
      active.resolve = () => {
        clearTimeout(timer);
        previous();
        resolve();
      };
      active.rec.stop();
    });
  }, []);

  const loadDevices = useCallback(async (forcePrompt = false) => {
    setError("");
    try {
      // While routing, the mic is already open; forcing a second open fails
      // on exclusive drivers and would report a healthy route as broken.
      await requestAudioAccess(forcePrompt && !runningRef.current);
      const listed = await listDevices();
      setInputs(listed.inputs);
      setOutputs(listed.outputs);
      setReady(true);
      setInputId((current) => {
        if (current && listed.inputs.some((d) => d.deviceId === current))
          return current;
        return listed.inputs[0]?.deviceId ?? "";
      });
      setOutputId((current) => {
        if (current && listed.outputs.some((d) => d.deviceId === current))
          return current;
        const virtual = listed.outputs.find((d) => isVirtualDevice(d.label));
        return virtual?.deviceId ?? listed.outputs[0]?.deviceId ?? "";
      });
      if (runningRef.current) {
        const inOk = listed.inputs.some(
          (d) => d.deviceId === inputIdRef.current,
        );
        const outOk = listed.outputs.some(
          (d) => d.deviceId === outputIdRef.current,
        );
        if (!inOk || !outOk) {
          await stopActiveRecorder();
          await router.stop();
          runningRef.current = false;
          setRunning(false);
          setError("انقطع أحد الأجهزة. حدّث القائمة وأعد التوجيه.");
        }
      }
    } catch {
      setError(
        "تعذّر الوصول إلى المايك. اسمح للتطبيق باستخدام الميكروفون ثم أعد المحاولة.",
      );
    }
  }, [router, stopActiveRecorder]);

  useEffect(() => {
    if (!ready) return;
    const onChange = () => {
      void loadDevices();
    };
    navigator.mediaDevices?.addEventListener("devicechange", onChange);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", onChange);
  }, [ready, loadDevices]);

  const toggleRoute = useCallback(async () => {
    // `runningRef` is the source of truth, and it is updated synchronously
    // below. Relying on the `running` state here allowed a double press to run
    // two starts (or a start straight after a stop) because the ref only
    // followed the state on the next render.
    if (busyRef.current) return;
    // A capture is mid-flight; opening the mic again confuses exclusive
    // drivers and would patch settings measured against a stale graph.
    if (calibratingRef.current) {
      setError("المعايرة جارية — انتظر انتهاؤها قليلاً.");
      return;
    }
    if (runningRef.current) {
      busyRef.current = true;
      setBusy(true);
      runningRef.current = false;
      setRunning(false);
      setFrame(emptyFrame);
      try {
        await stopActiveRecorder();
        await router.stop();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "تعذّر إيقاف التوجيه",
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
      return;
    }
    if (!inputIdRef.current || !outputIdRef.current) {
      setError("اختر جهاز الإدخال وجهاز الإخراج أولاً.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      router.applySettings(settingsRef.current);
      await router.start(inputIdRef.current, outputIdRef.current);
      runningRef.current = true;
      setRunning(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "فشل تشغيل التوجيه";
      setError(message);
      runningRef.current = false;
      setRunning(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [router, stopActiveRecorder]);

  const patch = useCallback(
    (
      updater:
        | Partial<VoiceSettings>
        | ((current: VoiceSettings) => Partial<VoiceSettings>),
    ) => {
      setSettings((current) => ({
        ...current,
        ...(typeof updater === "function" ? updater(current) : updater),
      }));
    },
    [],
  );

  const runQuickTest = useCallback(() => {
    if (testingVoice || !runningRef.current) return;
    const stream = router.getOutputStream();
    if (!stream) return;
    setTestingVoice(true);
    setTestCountdown(5);
    const chunks: Blob[] = [];
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream);
    } catch {
      setTestingVoice(false);
      return;
    }
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.start();

    const interval = setInterval(() => {
      setTestCountdown((c) => {
        if (c <= 1) {
          clearInterval(interval);
          return 0;
        }
        return c - 1;
      });
    }, 1000);

    setTimeout(() => {
      rec.onstop = () => {
        setTestingVoice(false);
        const blob = new Blob(chunks, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        const withSink = audio as HTMLAudioElement & {
          setSinkId?: (deviceId: string) => Promise<void>;
        };
        if (typeof withSink.setSinkId === "function" && outputIdRef.current) {
          withSink.setSinkId(outputIdRef.current).catch(() => {});
        }
        audio.play().catch(() => {});
        audio.onended = () => URL.revokeObjectURL(url);
      };
      try {
        rec.stop();
      } catch {
        setTestingVoice(false);
      }
    }, 5000);
  }, [router, testingVoice]);

  const applyInstantClean = useCallback(() => {
    patch({
      echoCancellation: false,
      noiseSuppression: false,
      aiDenoiser: false,
      studioEnhancer: false,
      antiFeedback: true,
      speakerBleedShield: false,
      vadEnabled: true,
      gateEnabled: false,
      highpassHz: 80,
      deess: 0.1,
      compress: 0.1,
      warmth: 0.3,
      presence: 0.5,
    });
  }, [patch]);

  const startRecording = useCallback(() => {
    if (recordingRef.current || !runningRef.current) return;
    const stream = router.getOutputStream();
    if (!stream) return;
    let mimeType = "audio/webm;codecs=opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "audio/webm";
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000,
      });
    } catch {
      setError("تعذّر بدء التسجيل: صيغة غير مدعومة على هذا النظام.");
      return;
    }
    // Everything this recording produces lives on the recording itself, so a
    // late `onstop` from an older recorder can never touch the new take.
    const active: ActiveRecording = { rec, chunks: [], resolve: () => undefined };
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) active.chunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(active.chunks, { type: mimeType });
      active.chunks.length = 0;
      if (recordingRef.current === active) {
        recordingRef.current = null;
        setRecording(false);
      }
      active.resolve();
      if (blob.size === 0) return;
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = String(reader.result).split(",")[1] ?? "";
        const stamp = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const local =
          `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}` +
          `-${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}`;
        // A lost take must be visible: a full disk or a cancelled I/O error
        // used to vanish without a trace.
        void saveRecordingFile(`نبرة-${local}.webm`, base64).catch(() => {
          setError("تعذّر حفظ التسجيل — تحقق من مساحة القرص وصلاحيات المجلد.");
        });
      };
      reader.onerror = () => setError("تعذّرت قراءة التسجيل للحفظ.");
      reader.readAsDataURL(blob);
    };
    try {
      rec.start(500);
    } catch {
      setError("تعذّر بدء التسجيل.");
      return;
    }
    // Claim the recording only after `start()` succeeded; a failed start
    // must not leave a stale ref blocking every future take.
    recordingRef.current = active;
    setRecording(true);
  }, [router]);

  const stopRecording = useCallback(() => {
    if (!recordingRef.current) return;
    // Same bounded stop as every other teardown path.
    void stopActiveRecorder();
  }, [stopActiveRecorder]);

  const saveCurrentPreset = useCallback(() => {
    // Unique id and unique label: `Date.now()` collides when two saves land in
    // the same millisecond, and a repeated label makes the saved list
    // ambiguous.
    let n = customPresets.length + 1;
    const taken = new Set(customPresets.map((p) => p.name));
    let name = `مسبق مخصص ${n}`;
    while (taken.has(name)) name = `مسبق مخصص ${++n}`;
    const id = `custom-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    setCustomPresets(
      saveCustomPresets([...customPresets, { id, name, settings }]),
    );
  }, [customPresets, settings]);

  const exportPresets = useCallback(() => {
    const data = JSON.stringify(
      { version: 1, presets: customPresets },
      null,
      2,
    );
    void saveTextFile("نبرة-مسبقات.json", data);
  }, [customPresets]);

  const importPresets = useCallback(async () => {
    const raw = await openTextFile();
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const incoming: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { presets?: unknown }).presets)
          ? ((parsed as { presets: unknown[] }).presets ?? [])
          : [];
      // The in-memory list is the truth: a failed localStorage write earlier
      // must not make an import merge into a stale (or empty) stored copy.
      const existing = customPresets;
      const seen = new Set(existing.map((p) => p.id));
      const added: CustomPreset[] = [];
      incoming.forEach((entry, i) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
        const p = entry as Record<string, unknown>;
        if (!p.settings || typeof p.settings !== "object") return;
        let id =
          typeof p.id === "string" && p.id ? p.id : `imported-${Date.now()}-${i}`;
        // Re-key rather than overwrite: importing the same file twice must add
        // copies, not silently replace the user's existing presets.
        if (seen.has(id)) {
          id = `${id}-${i}`;
          while (seen.has(id)) id = `${id}x`;
        }
        seen.add(id);
        added.push({
          id,
          name:
            typeof p.name === "string" && p.name.trim()
              ? p.name.slice(0, 60)
              : "مستوردة",
          settings: sanitizeSettings(p.settings),
        });
      });
      if (added.length === 0) {
        setError("لا توجد مسبقات صالحة في الملف.");
        return;
      }
      // Single write at the end instead of one per entry: the old per-preset
      // upsert re-read, re-serialised and re-wrote the whole array each time.
      setCustomPresets(saveCustomPresets([...existing, ...added]));
    } catch {
      setError("الملف المستورد غير صالح.");
    }
  }, [customPresets, setError]);

  const toggleAlwaysOnTop = useCallback(
    (flag: boolean) => {
      setPrefs((current) => ({ ...current, alwaysOnTop: flag }));
      void window.nabra?.setAlwaysOnTop(flag);
    },
    [setPrefs],
  );

  /**
   * The one-click path: listen to the raw mic for a few seconds, measure it,
   * and apply a settings patch for every defect that was actually heard.
   * Nothing here dials knobs by hand -- the report explains each change.
   */
  const runCalibration = useCallback(async () => {
    if (!inputIdRef.current) {
      setError("اختر مايك الإدخال أولاً حتى أعرف ما الذي أعايره.");
      return;
    }
    // The capture opens the mic on its own; an exclusive driver would reject
    // the second open while the router holds it.
    if (runningRef.current) {
      setError("أوقف التوجيه مؤقتاً قبل المعايرة لأن المايك مشغول.");
      return;
    }
    setError("");
    setCalibration(null);
    setCalibrating("silence");
    calibratingRef.current = true;
    try {
      const { samples, sampleRate } = await captureMic(
        inputIdRef.current,
        (phase) => setCalibrating(phase),
      );
      setCalibrating("analyzing");
      // Yield one frame so the "analyzing" state actually paints before the
      // synchronous FFT work blocks the thread.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const result = calibrateMic(samples, sampleRate, settingsRef.current);
      setCalibration(result);
      if (Object.keys(result.settings).length > 0) patch(result.settings);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "تعذّرت معايرة المايك. تأكد من السماح بالوصول إليه.",
      );
    } finally {
      setCalibrating(null);
      calibratingRef.current = false;
    }
  }, [patch]);

  /** Puts the mute state that was in force before PTT was held back. */
  const releasePtt = useCallback(() => {
    if (!pttDownRef.current) return;
    pttDownRef.current = false;
    const restore = muteBeforePttRef.current;
    muteBeforePttRef.current = null;
    // `null` means PTT was never engaged here, so leave mute alone.
    if (restore == null) return;
    // Mute was toggled while the key was held (by the user or the tray);
    // that deliberate choice outranks restoring the older state.
    if (settingsRef.current.muted !== false) return;
    patch({ muted: restore });
  }, [patch]);

  /**
   * Runs a bound shortcut action. Shared by the in-window key listener and the
   * system-wide (tray/OS) hotkey listener so both paths behave identically.
   */
  const runHotkey = useCallback(
    (action: keyof Bindings, phase: "keydown" | "keyup") => {
      if (action === "ptt") {
        if (phase === "keyup") {
          releasePtt();
          return;
        }
        // A focused button would also "click" on this key, double-firing.
        if (!pttDownRef.current) {
          pttDownRef.current = true;
          muteBeforePttRef.current = settingsRef.current.muted;
          patch({ muted: false });
        }
        return;
      }
      // Non-PTT actions fire on the press; acting on keyup too would
      // double-toggle them.
      if (phase !== "keydown") return;
      if (action === "toggle") void toggleRoute();
      else if (action === "mute") {
        patch((current: VoiceSettings) => ({ muted: !current.muted }));
      } else if (action === "bypass") {
        patch((current: VoiceSettings) => ({ bypass: !current.bypass }));
      }
    },
    [patch, releasePtt, toggleRoute],
  );

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      // Form fields own their keys, except that a slider only uses the arrows,
      // so the toggle shortcut should still reach the app.
      if (tag === "SELECT" || tag === "TEXTAREA") return;
      if (tag === "INPUT" && (target as HTMLInputElement).type !== "range")
        return;
      if (rebindingRef.current) return;
      const b = prefs.bindings;
      // A held key repeats; without this the state flickers every ~30 ms and
      // the engine is started and stopped over and over.
      const fresh = !event.repeat;

      if (b.ptt && event.code === b.ptt) {
        // A focused button would also "click" on this key, double-firing.
        event.preventDefault();
        if (fresh) runHotkey("ptt", "keydown");
        return;
      }
      if (event.code === b.toggle) {
        event.preventDefault();
        if (fresh) runHotkey("toggle", "keydown");
        return;
      }
      if (event.code === b.mute) {
        event.preventDefault();
        if (fresh) runHotkey("mute", "keydown");
        return;
      }
      if (event.code === b.bypass) {
        event.preventDefault();
        if (fresh) runHotkey("bypass", "keydown");
      }
    },
    [prefs.bindings, runHotkey],
  );
  const onKeyUp = useCallback(
    (event: KeyboardEvent) => {
      if (prefs.bindings.ptt && event.code === prefs.bindings.ptt) {
        releasePtt();
      }
    },
    [prefs.bindings, releasePtt],
  );
  const onKeyRef = useRef(onKey);
  const onKeyUpRef = useRef(onKeyUp);
  const releasePttRef = useRef(releasePtt);
  useEffect(() => {
    onKeyRef.current = onKey;
  }, [onKey]);
  useEffect(() => {
    onKeyUpRef.current = onKeyUp;
  }, [onKeyUp]);
  useEffect(() => {
    releasePttRef.current = releasePtt;
  }, [releasePtt]);
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      onKeyRef.current(event);
    };
    const up = (event: KeyboardEvent): void => {
      onKeyUpRef.current(event);
    };
    // Losing focus or the tab being hidden never delivers the matching keyup,
    // so PTT has to be released explicitly or the mic stays open forever.
    const blur = (): void => {
      releasePttRef.current();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    window.addEventListener("visibilitychange", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("visibilitychange", blur);
    };
  }, []);

  const runHotkeyRef = useRef(runHotkey);
  useEffect(() => {
    runHotkeyRef.current = runHotkey;
  }, [runHotkey]);

  // System-wide shortcuts: registered with the OS only while the window is
  // unfocused, so a game or Discord can drive PTT/toggle -- and typing inside
  // the app never fires a hotkey. Keys without an accelerator mapping (bare
  // modifiers such as ShiftLeft) keep working in-window as before.
  useEffect(() => {
    if (!window.nabra) return;
    const sync = (): void => {
      const focused = document.hasFocus();
      void window.nabra
        .setGlobalHotkeys(focused ? {} : prefs.bindings)
        .then((done) => {
          // An empty send while focused unregisters everything; that is not
          // a failure report, so only the real attempt updates the list.
          if (focused) return;
          const attempted = (
            Object.keys(prefs.bindings) as (keyof Bindings)[]
          ).filter(
            (action) =>
              action !== "ptt" && isGloballySafe(prefs.bindings[action]),
          );
          setGlobalFailures(
            attempted.filter((action) => !done.includes(action)),
          );
        })
        .catch(() => undefined);
    };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      void window.nabra.setGlobalHotkeys({});
    };
  }, [prefs.bindings]);

  useEffect(() => {
    return window.nabra?.onGlobalHotkey((info) => {
      // `globalShortcut` only reports the press; hold-style actions (PTT) are
      // never registered globally, so a press is all that can arrive.
      runHotkeyRef.current(info.action as keyof Bindings, "keydown");
    });
  }, []);

  // Tray: mirror the live routing/mute state and honour its quick actions.
  useEffect(() => {
    void window.nabra?.setTrayState({
      running,
      muted: settings.muted,
    });
  }, [running, settings.muted]);

  useEffect(() => {
    return window.nabra?.onTrayAction((action) => {
      if (action === "toggle") void toggleRoute();
      else if (action === "mute") {
        patch((current: VoiceSettings) => ({ muted: !current.muted }));
      }
    });
  }, [toggleRoute, patch]);

  useEffect(() => {
    if (!rebinding) {
      rebindingRef.current = false;
      return;
    }
    rebindingRef.current = true;
    const capture = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const code: string = event.code;
      // Escape backs out of remapping without overwriting the stored binding.
      if (code === "Escape") {
        setRebinding(null);
        return;
      }
      setPrefs((current) => ({
        ...current,
        bindings: { ...current.bindings, [rebinding]: code },
      }));
      setRebinding(null);
    };
    window.addEventListener("keydown", capture, true);
    return () => {
      window.removeEventListener("keydown", capture, true);
      rebindingRef.current = false;
    };
  }, [rebinding, setPrefs]);

  const selectedIn = inputs.find((d) => d.deviceId === inputId);
  const selectedOut = outputs.find((d) => d.deviceId === outputId);
  // Compare against the full preset, not a hand-picked few fields: matching on
  // four knobs lit up a preset that was actually nothing like the current
  // settings. Keys the preset does not mention are not part of the match.
  const presetMatches = (preset: { settings: Partial<VoiceSettings> }) =>
    Object.entries(preset.settings).every(
      ([key, value]) => settings[key as keyof VoiceSettings] === value,
    );
  const activePresetId =
    STUDIO_PRESETS.find(presetMatches)?.id ??
    customPresets.find(presetMatches)?.id ??
    null;

  // Presets describe a complete sound, not a diff. Applying one over whatever
  // the sliders currently hold leaves stale effects behind (switching from
  // "جوقة" to "أصلي" used to keep the reverb), so apply on top of a clean
  // baseline. Session state and per-machine calibration stay under the user's
  // control even when a custom preset captured them at save time: they are
  // re-asserted after the preset is spread, so a preset can never unmute or
  // re-enable the gate mid-call.
  const applyPreset = useCallback(
    (presetSettings: Partial<VoiceSettings>) => {
      setSettings((current) =>
        sanitizeSettings({
          ...defaultSettings(),
          ...presetSettings,
          outputGain: current.outputGain,
          muted: current.muted,
          monitor: current.monitor,
          bypass: current.bypass,
          inputGain: current.inputGain,
          micDrive: current.micDrive,
          gateEnabled: current.gateEnabled,
          gateThreshold: current.gateThreshold,
          vadEnabled: current.vadEnabled,
          vadSensitivity: current.vadSensitivity,
          detector: current.detector,
          latencyMode: current.latencyMode,
          targetMidi: current.targetMidi,
          scale: current.scale,
          rootPc: current.rootPc,
        }),
      );
    },
    [],
  );

  // One definition of the two device pickers, reused by the full panel and by
  // the compact bar. Duplicating them let the two views drift apart the last
  // time a device option was added.
  const deviceSelects = (
    <>
      <label>
        الإدخال — المايك الأصلي
        <select
          value={inputId}
          onChange={(e) => setInputId(e.target.value)}
          disabled={running}
        >
          {inputs.length === 0 && <option value="">لا توجد أجهزة</option>}
          {inputs.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label || "مايك بدون اسم"}
            </option>
          ))}
        </select>
      </label>

      <label>
        الإخراج — المايك الوهمي
        <select
          value={outputId}
          onChange={(e) => setOutputId(e.target.value)}
          disabled={running}
        >
          {outputs.length === 0 && <option value="">لا توجد أجهزة</option>}
          {outputs.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {isVirtualDevice(device.label) ? "● وهمي — " : ""}
              {device.label || "مخرج بدون اسم"}
            </option>
          ))}
        </select>
      </label>
    </>
  );

  return (
    <div className={`app ${prefs.compact ? "compact" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>نبرة</h1>
            <p>سلسلة معالجة صوت احترافية</p>
          </div>
        </div>
        <div className="meta">
          {running && (
            <span className="chip">
              {frame.sampleRate / 1000} kHz · ~{Math.round(frame.latencyMs)} ms
            </span>
          )}
          {running && frame.sinkFallback && (
            <span
              className="chip danger"
              title="لم يُربط الصوت بجهاز المخرج مباشرة؛ يُستخدم إخراج النظام الافتراضي."
            >
              إخراج افتراضي
            </span>
          )}
          {settings.vadEnabled && running && (
            <span
              className={`chip ${
                frame.vadActive ? (frame.speaking ? "speech" : "") : "warn"
              }`}
              title="كشف الكلام: يحوّل النغمة عند الكلام فقط وتمرّر البقية كما هي"
            >
              {frame.vadActive ? (frame.speaking ? "كلام" : "صمت") : "VAD…"}
            </span>
          )}
          {settings.bypass && <span className="chip warn">تجاوز</span>}
          {frame.clipping && running && <span className="chip danger">قص</span>}
          <button
            className={`chip btn-chip ${prefs.alwaysOnTop ? "on" : ""}`}
            type="button"
            title="إبقاء نافذة نبرة فوق كل النوافذ"
            onClick={() => toggleAlwaysOnTop(!prefs.alwaysOnTop)}
          >
            ثابت
          </button>
          <button
            className={`chip btn-chip ${prefs.compact ? "on" : ""}`}
            type="button"
            title="الوضع المصغّر — إخفاء الألواح الجانبية"
            onClick={() =>
              setPrefs((current) => ({ ...current, compact: !current.compact }))
            }
          >
            مصغّر
          </button>
          {updateInfo && (
            <button
              className="chip warn btn-chip"
              type="button"
              title="فتح صفحة النسخة الجديدة"
              onClick={() =>
                updateInfo.url ? openExternal(updateInfo.url) : undefined
              }
            >
              نسخة جديدة {updateInfo.version}
            </button>
          )}
          <div className={`status ${running ? "on" : ""}`}>
            <i />
            {running ? "التوجيه يعمل" : "متوقف"}
          </div>
        </div>
      </header>

      {/* الوضع المصغّر يخفي لوحة الأجهزة كاملة، فيبقى هذا الشريط وحده هو طريق
          لتغيير المايك أو المخرج أو الوصول لصفحة التثبيت أثناء البث. */}
      {prefs.compact && (
        <div className="compact-bar" role="group" aria-label="الأجهزة">
          {deviceSelects}
          {/* اللوحة الكاملة مخفية هنا، فلا بدّ لشريط مصغّر من حمل زر التحميل
              نفسه وإلا بقي المستخدم بلا أجهزة في الوضع المصغّر. */}
          <button
            type="button"
            className="btn ghost small"
            onClick={() => void loadDevices(true)}
          >
            {ready ? "تحديث الأجهزة" : "السماح وتحميل الأجهزة"}
          </button>
          <div className={`compact-bar-status ${hasVirtualOut ? "ok" : ""}`}>
            <span
              className={`dot ${hasVirtualOut ? "ok" : "warn"}`}
              aria-hidden="true"
            />
            <span>{hasVirtualOut ? "تم رصد مايك وهمي" : hint.title}</span>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => openExternal(virtualDriverUrl(platform))}
            >
              صفحة التثبيت الرسمية ↗
            </button>
          </div>
        </div>
      )}

      <main className="grid">
        <section className="panel">
          <h2>الأجهزة والمسار</h2>
          <p className="lead">
            مايك أصلي → فلترة → طبقة → طابع → ضغط → محدد → مايك وهمي.
          </p>

          {!ready ? (
            <button
              className="btn primary"
              type="button"
              onClick={() => void loadDevices(true)}
            >
              السماح وتحميل الأجهزة
            </button>
          ) : (
            <button
              className="btn ghost"
              type="button"
              onClick={() => void loadDevices(true)}
            >
              تحديث قائمة الأجهزة
            </button>
          )}

          {deviceSelects}

          <div className="calibrate">
            <div className="calibrate-head">
              <strong>معايرة تلقائية</strong>
              <button
                type="button"
                className="btn primary small"
                disabled={calibrating !== null}
                onClick={() => void runCalibration()}
              >
                {calibrating === "silence"
                  ? "اسكت الآن… أستمع للمكان"
                  : calibrating === "speech"
                    ? "تكلّم بشكل طبيعي…"
                    : calibrating === "analyzing"
                      ? "أحلّل القياسات…"
                      : "حلّل مايكي واضبطه"}
              </button>
            </div>
            {!calibrating && !calibration && (
              <p className="calibrate-note">
                أستمع إلى المايك بضع ثوانٍ: صمت أولاً ليقيس ضجيج الغرفة، ثم
                كلام طبيعي. أشخّص كل عيب سمعته — طنين كهرباء، رنّة، هيس، صولجان،
                ضعف حضور، تذبذب مستوى — وأضبط الإعدادات بنفسي، مع شرح كل تغيير.
              </p>
            )}
            {calibrating && (
              <div className="calibrate-progress" aria-live="polite">
                <i className={calibrating === "silence" ? "run" : ""} />
                <span>
                  {calibrating === "silence"
                    ? "مرحلة ١ من ٢: أقيس ضجيج المكان — لا تتكلم ولا تتحرك قرب المايك."
                    : calibrating === "speech"
                      ? "مرحلة ٢ من ٢: تكلم بشكل طبيعي — جملة أو جملتان تكفيان."
                      : "أحلّل القياسات… لحظات."}
                </span>
              </div>
            )}
            {calibration && (
              <div className="calibrate-report">
                <strong>
                  {calibration.findings.some((f) => f.severity === "bad")
                    ? "وجدت مشاكل وأصلحتها:"
                    : calibration.findings.some((f) => f.severity === "warn")
                      ? "وجدت ملاحظات وأخذت بها:"
                      : "المايك سليم:"}
                </strong>
                <ul>
                  {calibration.findings.map((finding, i) => (
                    <li key={i} className={finding.severity}>
                      {finding.message}
                    </li>
                  ))}
                </ul>
                <div className="calibrate-actions">
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setCalibration(null)}
                  >
                    إخفاء
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => void runCalibration()}
                  >
                    أعد المعايرة
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className={`hint ${hasVirtualOut ? "ok" : ""}`}>
            <strong>{hasVirtualOut ? "تم رصد مايك وهمي" : hint.title}</strong>
            <span>{hint.body}</span>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => openExternal(virtualDriverUrl(platform))}
            >
              صفحة التثبيت الرسمية ↗
            </button>
          </div>

          {selectedIn && selectedOut && (
            <ul className="path">
              <li>{selectedIn.label || "مايك"}</li>
              <li className="arrow">سلسلة الاستوديو</li>
              <li>{selectedOut.label || "مخرج"}</li>
            </ul>
          )}
          {selectedIn && isVirtualDevice(selectedIn.label) && (
            <div className="hint">
              <strong>الإدخال يبدو وهماً</strong>
              <span>
                اختر مايكك الأصلي للإدخال. إن اخترت الكابل الوهمي هنا سيحدث صدى
                ثم ينقطع الصوت.
              </span>
            </div>
          )}

          {running && frame.sinkFallback && (
            <div className="hint">
              <strong>تنبيه: لم يُربط الصوت بجهاز المخرج مباشرة</strong>
              <span>
                الصوت يُرسل حالياً إلى جهاز الإخراج الافتراضي في النظام. اجعل
                الكابل الوهمي («CABLE Output» أو «BlackHole») هو جهاز الإخراج
                الافتراضي في إعدادات الصوت، ثم أوقف التوجيه وأعد تشغيله.
              </span>
            </div>
          )}

          {running && (
            <div className="diag">
              <strong>تشخيص المسار</strong>
              <ul>
                <li className={selectedIn ? "ok" : "bad"}>
                  الدخل: {selectedIn?.label || "غير محدد"}
                </li>
                <li className={hasVirtualOut ? "ok" : "bad"}>
                  خرج وهمي:
                  {hasVirtualOut ? " موجود" : " غير مكتشف"}
                </li>
                <li className={running && !frame.sinkFallback ? "ok" : "bad"}>
                  الربط: {frame.sinkFallback ? " عبر إخراج النظام" : " مباشر"}
                </li>
                <li className={!frame.clipping ? "ok" : "bad"}>
                  القص: {frame.clipping ? " مستويات عالية" : " آمن"}
                </li>
              </ul>
              <Meter
                label="مستوى الدخل"
                db={frame.rmsDb}
                hot={frame.clipping}
              />
            </div>
          )}

          <p className="keys">
            {keyLabel(prefs.bindings.toggle)} تشغيل ·{" "}
            {keyLabel(prefs.bindings.mute)} صامت ·{" "}
            {keyLabel(prefs.bindings.bypass)} تجاوز
            {prefs.bindings.ptt ? ` · ${keyLabel(prefs.bindings.ptt)} PTT` : ""}
          </p>
        </section>

        <section className="panel stage">
          <h2>المراقبة الحية</h2>
          <p className="lead">
            طيف وموجة وعدادات الدخل/الخرج. القص يظهر إذا اقترب المستوى من الحد.
          </p>

          <div className="viz">
            <Spectrum analyser={running ? router.getAnalyser() : null} />
            <Waveform analyser={running ? router.getOutputAnalyser() : null} />
          </div>

          <div className="meters">
            <Meter label="دخل" db={frame.rmsDb} hot={frame.clipping} />
            <Meter label="خرج" db={frame.outDb} hot={frame.outDb > -3} />
          </div>

          <Tuner
            cents={frame.cents}
            reference={frame.referenceNote}
            live={frame.detectedHz != null}
          />

          <div className="calcs">
            <Calc
              label="التردد المكتشف"
              value={fmtHz(frame.detectedHz)}
              unit="Hz"
            />
            <Calc label="النغمة" value={frame.detectedNote} />
            <Calc label="النغمة المرجعية" value={frame.referenceNote} />
            <Calc
              label="الإزاحة المطبّقة"
              value={signed(frame.appliedSemitones)}
              unit="st"
              accent
            />
            <Calc
              label="النسبة"
              value={frame.ratio.toFixed(3)}
              unit="×"
              accent
            />
            <Calc label="تتبع المستوى" value={`${frame.agcGain.toFixed(2)}×`} />
            <Calc label="الذروة" value={frame.peakDb.toFixed(1)} unit="dB" />
            <Calc
              label="زمن المحرِّك"
              value={frame.pitchLatencyMs.toFixed(0)}
              unit="ms"
            />
          </div>
        </section>

        <section className="panel">
          <h2>المحرك</h2>
          <div className="presets">
            {STUDIO_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.hint}
                className={activePresetId === preset.id ? "on" : ""}
                onClick={() => applyPreset(preset.settings)}
              >
                {preset.name}
              </button>
            ))}
            {customPresets.map((preset) => (
              <div key={preset.id} className="preset-row">
                <button
                  type="button"
                  title="مسبق مخصص"
                  className={activePresetId === preset.id ? "on" : ""}
                  onClick={() => applyPreset(preset.settings)}
                >
                  {preset.name}
                </button>
                <button
                  type="button"
                  className="preset-del"
                  title="حذف المسبق"
                  onClick={() =>
                    setCustomPresets(
                      removeCustomPreset(customPresets, preset.id),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="preset-actions">
            <button
              type="button"
              className="btn ghost small"
              onClick={saveCurrentPreset}
            >
              حفظ الحالي كمسبق
            </button>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => void exportPresets()}
            >
              تصدير
            </button>
            <button
              type="button"
              className="btn ghost small"
              onClick={() => void importPresets()}
            >
              استيراد
            </button>
          </div>

          <div className="tabs">
            <button
              type="button"
              className={tab === "pitch" ? "on" : ""}
              onClick={() => setTab("pitch")}
            >
              🎚️ نغمة وطبقة
            </button>
            <button
              type="button"
              className={tab === "mic" ? "on" : ""}
              onClick={() => setTab("mic")}
            >
              🎙️ استوديو المايكات
            </button>
            <button
              type="button"
              className={tab === "tone" ? "on" : ""}
              onClick={() => setTab("tone")}
            >
              💎 صفاء ودفء
            </button>
            <button
              type="button"
              className={tab === "dyn" ? "on" : ""}
              onClick={() => setTab("dyn")}
            >
              ⚖️ ديناميك وركوب
            </button>
            <button
              type="button"
              className={tab === "effects" ? "on" : ""}
              onClick={() => setTab("effects")}
            >
              🌌 مؤثرات وأبعاد
            </button>
            <button
              type="button"
              className={tab === "isolation" ? "on" : ""}
              onClick={() => setTab("isolation")}
            >
              🛡️ عزل وذكاء
            </button>
          </div>

          <div className="modes">
            <button
              type="button"
              className={settings.mode === "manual" ? "on" : ""}
              onClick={() => patch({ mode: "manual" })}
            >
              ثابت
            </button>
            <button
              type="button"
              className={settings.mode === "adaptive" ? "on" : ""}
              onClick={() => patch({ mode: "adaptive" })}
            >
              تكيّفي
            </button>
          </div>

          {tab === "pitch" && (
            <>
              <label>
                كاشف النغمة
                <select
                  value={settings.detector}
                  onChange={(e) =>
                    patch({
                      detector: e.target.value as VoiceSettings["detector"],
                    })
                  }
                >
                  <option value="auto">تلقائي — الأنسب للكلام</option>
                  <option value="yin">YIN — أسرع</option>
                  <option value="mcm">MCM — أدق للهمس والأنفاس</option>
                </select>
              </label>
              <label>
                محرِّك معالجة طبقة الصوت
                <select
                  value={settings.pitchEngine}
                  onChange={(e) =>
                    patch({
                      pitchEngine: e.target.value as VoiceSettings["pitchEngine"],
                    })
                  }
                >
                  <option value="vocoder">
                    ✨ محرِّك طوري فائق النقاء (Phase Vocoder — موصى به)
                  </option>
                  <option value="jungle">
                    ⚡ محرِّك حبيبي خفيف جداً (Jungle — للأجهزة القديمة وويندوز 7)
                  </option>
                </select>
              </label>

              {settings.pitchEngine === "vocoder" && (
                <label>
                  دقة نافذة التحليل وزمن الاستجابة (FFT)
                  <select
                    value={settings.latencyMode}
                    onChange={(e) =>
                      patch({
                        latencyMode: e.target.value as VoiceSettings["latencyMode"],
                      })
                    }
                  >
                    <option value="fast">
                      🚀 فائق السرعة والخفة (1024 FFT — استهلاك معالج معدوم للأجهزة القديمة)
                    </option>
                    <option value="low">
                      ⚡ متوازن وسلس (2048 FFT — مثالي لويندوز وماك بدون أي تعليق)
                    </option>
                    <option value="standard">
                      💎 دقة استوديو قصوى (4096 FFT — للأجهزة الحديثة والقوية)
                    </option>
                  </select>
                </label>
              )}

              {running && (router.latencyModePending || router.pitchEnginePending) && (
                <div className="hint">
                  <strong>تغيير المحرِّك أو دقة النافذة يتطلب إعادة بدء التوجيه</strong>
                  <span>
                    يتم بناء ذاكرة المعالجة اللحظية عند بدء التوجيه. أوقف التوجيه وابدأه مرة أخرى ليُطبَّق الإعداد الجديد فوراً.
                  </span>
                </div>
              )}
              {settings.mode === "adaptive" ? (
                <>
                  <label>
                    السلم
                    <select
                      value={settings.scale}
                      onChange={(e) =>
                        patch({
                          scale: e.target.value as VoiceSettings["scale"],
                        })
                      }
                    >
                      <option value="chromatic">قفل على نغمة واحدة</option>
                      <option value="major">ماجور — تصحيح لحن</option>
                      <option value="minor">مينور — تصحيح لحن</option>
                    </select>
                  </label>
                  {settings.scale === "chromatic" && (
                    <label>
                      النغمة المطلوبة
                      <select
                        value={settings.targetMidi}
                        onChange={(e) =>
                          patch({ targetMidi: Number(e.target.value) })
                        }
                      >
                        {targetNotes.map((note) => (
                          <option key={note.midi} value={note.midi}>
                            {note.name} — {midiToHz(note.midi).toFixed(1)} Hz
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {settings.scale !== "chromatic" && (
                    <label>
                      أساس السلم
                      <select
                        value={settings.rootPc}
                        onChange={(e) =>
                          patch({ rootPc: Number(e.target.value) })
                        }
                      >
                        {NOTE_NAMES.map((name, index) => (
                          <option key={name} value={index}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <Slider
                    label="نعومة التتبع"
                    min={0.1}
                    max={0.7}
                    step={0.01}
                    value={settings.smoothing}
                    format={(v) => v.toFixed(2)}
                    onChange={(smoothing) => patch({ smoothing })}
                  />
                </>
              ) : (
                <Slider
                  label="إزاحة ثابتة"
                  min={-12}
                  max={12}
                  step={0.1}
                  value={settings.manualSemitones}
                  format={(v) => `${signed(v)} نصف درجة`}
                  onChange={(manualSemitones) => patch({ manualSemitones })}
                />
              )}
              <Slider
                label="فورمانت"
                min={-8}
                max={8}
                step={0.1}
                value={settings.formant}
                format={(v) => signed(v)}
                onChange={(formant) => patch({ formant })}
              />
            </>
          )}

          {tab === "mic" && (
            <div className="mic-locker">
              <div className="mic-locker-intro">
                <h3>🎙️ استوديو نمذجة المايكات الأسطورية</h3>
                <p>
                  إعادة تشكيل الاستجابة الترددية للمايك ومحاكاة أشهر مايكات البودكاست والإذاعة والاستوديوهات العالمية بدقة تناظرية فائقة.
                </p>
              </div>

              <div className="mic-cards-grid">
                <div
                  className={`mic-card ${settings.micModel === "sm7b" ? "active" : ""}`}
                  onClick={() => patch({ micModel: "sm7b" })}
                >
                  <div className="mic-card-top">
                    <span className="mic-icon">🎙️</span>
                    <span className="mic-badge popular">الأشهر إذاعياً</span>
                  </div>
                  <h4>Shure SM7B</h4>
                  <p className="mic-desc">
                    أسطورة البودكاست والاستوديوهات. نغمة عريضة ودافئة مع كبح طنين الغرفة وحضور إذاعي ساحر.
                  </p>
                  <div className="mic-tags">
                    <span>قرب إذاعي Proximity</span>
                    <span>كبح الطنين</span>
                    <span>حضور إذاعي 4.8kHz</span>
                  </div>
                  <button
                    type="button"
                    className={`btn small ${settings.micModel === "sm7b" ? "primary" : "ghost"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      patch({ micModel: "sm7b" });
                    }}
                  >
                    {settings.micModel === "sm7b" ? "✓ مفعّل حالياً" : "تطبيق الآن"}
                  </button>
                </div>

                <div
                  className={`mic-card ${settings.micModel === "u87" ? "active" : ""}`}
                  onClick={() => patch({ micModel: "u87" })}
                >
                  <div className="mic-card-top">
                    <span className="mic-icon">💎</span>
                    <span className="mic-badge gold">فخامة كوندنسر</span>
                  </div>
                  <h4>Neumann U87</h4>
                  <p className="mic-desc">
                    المعيار الذهبي للتعليق الصوتي والغناء في كبرى استوديوهات العالم. شيمر وهوائية بلورية مفتوحة.
                  </p>
                  <div className="mic-tags">
                    <span>شيمر هوائي 10.5kHz</span>
                    <span>وضوح حوار نقي</span>
                    <span>تفاصيل بلورية</span>
                  </div>
                  <button
                    type="button"
                    className={`btn small ${settings.micModel === "u87" ? "primary" : "ghost"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      patch({ micModel: "u87" });
                    }}
                  >
                    {settings.micModel === "u87" ? "✓ مفعّل حالياً" : "تطبيق الآن"}
                  </button>
                </div>

                <div
                  className={`mic-card ${settings.micModel === "re20" ? "active" : ""}`}
                  onClick={() => patch({ micModel: "re20" })}
                >
                  <div className="mic-card-top">
                    <span className="mic-icon">📻</span>
                    <span className="mic-badge cyan">Variable-D</span>
                  </div>
                  <h4>Electro-Voice RE20</h4>
                  <p className="mic-desc">
                    الصوت الإذاعي للراديو ومحطات الأخبار العالمية. حوار قوي وثابت لا يتأثر باقترابك أو ابتعادك.
                  </p>
                  <div className="mic-tags">
                    <span>ثبات المسافة</span>
                    <span>اختراق الضجيج</span>
                    <span>إذاعة محترفة</span>
                  </div>
                  <button
                    type="button"
                    className={`btn small ${settings.micModel === "re20" ? "primary" : "ghost"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      patch({ micModel: "re20" });
                    }}
                  >
                    {settings.micModel === "re20" ? "✓ مفعّل حالياً" : "تطبيق الآن"}
                  </button>
                </div>

                <div
                  className={`mic-card ${settings.micModel === "c414" ? "active" : ""}`}
                  onClick={() => patch({ micModel: "c414" })}
                >
                  <div className="mic-card-top">
                    <span className="mic-icon">✨</span>
                    <span className="mic-badge purple">أثيري نقي</span>
                  </div>
                  <h4>AKG C414</h4>
                  <p className="mic-desc">
                    أعلى مستويات الشفافية الصوتية والانفتاح الثلاثي الأبعاد. نغمات هوائية منعشة واستجابة أفقية.
                  </p>
                  <div className="mic-tags">
                    <span>أبعاد ثلاثية</span>
                    <span>ترددات عليا مفتوحة</span>
                    <span>صوت طبيعي فائق</span>
                  </div>
                  <button
                    type="button"
                    className={`btn small ${settings.micModel === "c414" ? "primary" : "ghost"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      patch({ micModel: "c414" });
                    }}
                  >
                    {settings.micModel === "c414" ? "✓ مفعّل حالياً" : "تطبيق الآن"}
                  </button>
                </div>

                <div
                  className={`mic-card ${settings.micModel === "none" ? "active" : ""}`}
                  onClick={() => patch({ micModel: "none" })}
                >
                  <div className="mic-card-top">
                    <span className="mic-icon">🎙️</span>
                    <span className="mic-badge neutral">محايد أصلي</span>
                  </div>
                  <h4>مايك محايد (Direct Bypass)</h4>
                  <p className="mic-desc">
                    صوت المايك الطبيعي والافتراضي بدون أي إعادة تشكيل أو تعديل لخصائص التردد الأصلية.
                  </p>
                  <div className="mic-tags">
                    <span>استجابة مسطحة</span>
                    <span>بدون تلوين</span>
                  </div>
                  <button
                    type="button"
                    className={`btn small ${settings.micModel === "none" ? "primary" : "ghost"}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      patch({ micModel: "none" });
                    }}
                  >
                    {settings.micModel === "none" ? "✓ مفعّل حالياً" : "تطبيق الآن"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === "tone" && (
            <>
              <div className="studio-card-highlight">
                <div className="card-title-row">
                  <span className="icon">🔥</span>
                  <div>
                    <h4>الدفء التناظري والصفاء الإذاعي الأسطوري</h4>
                    <p>تشبّع أنبوبي 12AX7 وبريق هوائي Exciter يمنح صوتك نعومة وفخامة استوديوهات الماسترينج.</p>
                  </div>
                </div>

                <Slider
                  label="🔥 دفء التيوب التناظري (12AX7 Tube Saturation)"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.tubeWarmth}
                  format={(v) => `${Math.round(v * 100)}٪`}
                  onChange={(tubeWarmth) => patch({ tubeWarmth })}
                />
                <Slider
                  label="✨ بريق وهواء الصوت (Broadcast Air 10k-16k Exciter)"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.vocalAir}
                  format={(v) => `${Math.round(v * 100)}٪`}
                  onChange={(vocalAir) => patch({ vocalAir })}
                />
                <Slider
                  label="🛡️ عزل ارتداد وصندوق الغرفة (Studio Booth De-Mud)"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.boothIsolation}
                  format={(v) => `${Math.round(v * 100)}٪`}
                  onChange={(boothIsolation) => patch({ boothIsolation })}
                />
              </div>

              <div className="eq-group">
                <Slider
                  label="تمرير عالٍ (Low-Cut)"
                  min={20}
                  max={300}
                  step={1}
                  value={settings.highpassHz}
                  format={(v) => `${v.toFixed(0)} Hz`}
                  onChange={(highpassHz) => patch({ highpassHz })}
                />
                <Slider
                  label="تمرير منخفض (High-Cut)"
                  min={2500}
                  max={18000}
                  step={50}
                  value={settings.lowpassHz}
                  format={(v) => `${v.toFixed(0)} Hz`}
                  onChange={(lowpassHz) => patch({ lowpassHz })}
                />
                <Slider
                  label="دفء (Warmth EQ)"
                  min={-6}
                  max={8}
                  step={0.1}
                  value={settings.warmth}
                  format={(v) => `${signed(v)} dB`}
                  onChange={(warmth) => patch({ warmth })}
                />
                <Slider
                  label="حضور (Presence EQ)"
                  min={-4}
                  max={8}
                  step={0.1}
                  value={settings.presence}
                  format={(v) => `${signed(v)} dB`}
                  onChange={(presence) => patch({ presence })}
                />
                <Slider
                  label="تهدئة الصفير (De-Esser)"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.deess}
                  format={(v) => `${Math.round(v * 100)}٪`}
                  onChange={(deess) => patch({ deess })}
                />
              </div>
              <div className="char-fx-card">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.robotEnabled}
                    onChange={(e) => patch({ robotEnabled: e.target.checked })}
                  />
                  🤖 صوت الروبوت السايبورغ (Ring Modulator)
                </label>
                {settings.robotEnabled && (
                  <>
                    <Slider
                      label="قوة التأثير الآلي"
                      min={0}
                      max={1}
                      step={0.01}
                      value={settings.robotMix}
                      format={(v) => `${Math.round(v * 100)}٪`}
                      onChange={(robotMix) => patch({ robotMix })}
                    />
                    <Slider
                      label="تردد الرنين الآلي"
                      min={20}
                      max={200}
                      step={1}
                      value={settings.robotRate}
                      format={(v) => `${v.toFixed(0)} Hz`}
                      onChange={(robotRate) => patch({ robotRate })}
                    />
                  </>
                )}
              </div>
              <div className="char-fx-card">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.radioEnabled}
                    onChange={(e) => patch({ radioEnabled: e.target.checked })}
                  />
                  📻 نغمة اللاسلكي وراديو الاتصالات الحربية
                </label>
                {settings.radioEnabled && (
                  <Slider
                    label="قوة نغمة اللاسلكي"
                    min={0}
                    max={1}
                    step={0.01}
                    value={settings.radioMix}
                    format={(v) => `${Math.round(v * 100)}٪`}
                    onChange={(radioMix) => patch({ radioMix })}
                  />
                )}
              </div>
            </>
          )}

          {tab === "effects" && (
            <>
              <div className="fx-section">
                <h3>تردد</h3>
                <Slider
                  label="مزيج التردد"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.reverbMix}
                  format={(v) => `${Math.round(v * 100)}٪`}
                  onChange={(reverbMix) => patch({ reverbMix })}
                />
                {settings.reverbMix > 0 && (
                  <Slider
                    label="زمن التردد"
                    min={0.2}
                    max={4}
                    step={0.1}
                    value={settings.reverbTime}
                    format={(v) => `${v.toFixed(1)} ث`}
                    onChange={(reverbTime) => patch({ reverbTime })}
                  />
                )}
              </div>
              <div className="fx-section">
                <h3>كورس</h3>
                <Slider
                  label="مزيج الكورس"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.chorusMix}
                  format={(v) => `${Math.round(v * 100)}٪`}
                  onChange={(chorusMix) => patch({ chorusMix })}
                />
                {settings.chorusMix > 0 && (
                  <>
                    <Slider
                      label="سرعة التعديل"
                      min={0.2}
                      max={6}
                      step={0.1}
                      value={settings.chorusRate}
                      format={(v) => `${v.toFixed(1)} Hz`}
                      onChange={(chorusRate) => patch({ chorusRate })}
                    />
                    <Slider
                      label="عمق"
                      min={0}
                      max={1}
                      step={0.01}
                      value={settings.chorusDepth}
                      format={(v) => `${Math.round(v * 100)}٪`}
                      onChange={(chorusDepth) => patch({ chorusDepth })}
                    />
                  </>
                )}
              </div>
              <div className="fx-section">
                <h3>صدى</h3>
                <Slider
                  label="مزيج الصدى"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.delayMix}
                  format={(v) => `${Math.round(v * 100)}٪`}
                  onChange={(delayMix) => patch({ delayMix })}
                />
                {settings.delayMix > 0 && (
                  <>
                    <Slider
                      label="الزمن"
                      min={0.05}
                      max={1}
                      step={0.01}
                      value={settings.delayTime}
                      format={(v) => `${(v * 1000).toFixed(0)} ms`}
                      onChange={(delayTime) => patch({ delayTime })}
                    />
                    <Slider
                      label="الارتداد"
                      min={0}
                      max={0.9}
                      step={0.01}
                      value={settings.delayFeedback}
                      format={(v) => `${Math.round(v * 100)}٪`}
                      onChange={(delayFeedback) => patch({ delayFeedback })}
                    />
                  </>
                )}
              </div>
              <div className="fx-section">
                <h3>تشويه</h3>
                <Slider
                  label="مقدار التشويه"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.distortion}
                  format={(v) => `${Math.round(v * 100)}٪`}
                  onChange={(distortion) => patch({ distortion })}
                />
              </div>
              <div className="fx-section">
                <h3>مجال استريو ثلاثي الأبعاد</h3>
                <Slider
                  label="عرض الاستريو 3D"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.stereoWidth}
                  format={(v) => (v === 0 ? "أحادي (مونو)" : `${Math.round(v * 100)}٪ محيطي`)}
                  onChange={(stereoWidth) => patch({ stereoWidth })}
                />
              </div>
            </>
          )}

          {tab === "dyn" && (
            <>
              <div className="studio-card-highlight">
                <div className="card-title-row">
                  <span className="icon">🎚️</span>
                  <div>
                    <h4>راكب الصوت الذكي (Intelligent Vocal Rider)</h4>
                    <p>موازنة ديناميكية ناعمة تلقائية تعزز الكلمات الهامسة وتكبح الصرخات المفاجئة بأسلوب إذاعي.</p>
                  </div>
                </div>

                <Slider
                  label="🎚️ راكب الصوت الذكي (Vocal Rider)"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.vocalRider}
                  format={(v) => (v === 0 ? "متوقف" : `${Math.round(v * 100)}٪ توازن ذكي`)}
                  onChange={(vocalRider) => patch({ vocalRider })}
                />
              </div>

              <Slider
                label="ضاغط الاستوديو الناعم (Studio Compressor)"
                min={0}
                max={1}
                step={0.01}
                value={settings.compress}
                format={(v) => `${Math.round(v * 100)}٪`}
                onChange={(compress) => patch({ compress })}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.gateEnabled}
                  onChange={(e) => patch({ gateEnabled: e.target.checked })}
                />
                بوابة ضوضاء — تقطع الهمس أثناء السكوت
              </label>
              {settings.gateEnabled && (
                <Slider
                  label="حدّ البوابة"
                  min={-80}
                  max={-20}
                  step={1}
                  value={settings.gateThreshold}
                  format={(v) => `${v.toFixed(0)} dB`}
                  onChange={(gateThreshold) => patch({ gateThreshold })}
                />
              )}
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.vadEnabled}
                  onChange={(e) => patch({ vadEnabled: e.target.checked })}
                />
                ذكاء الكلام — لا يحوّل النغمة إلا عند الكلام
              </label>
              {settings.vadEnabled && (
                <>
                  <Slider
                    label="حساسية كشف الكلام"
                    min={0}
                    max={1}
                    step={0.01}
                    value={settings.vadSensitivity}
                    format={(v) => `${Math.round(v * 100)}٪`}
                    onChange={(vadSensitivity) => patch({ vadSensitivity })}
                  />
                  {!running ? (
                    <p className="vad-status">
                      <span className="dot" />
                      يعمل أثناء التوجيه
                    </p>
                  ) : frame.vadActive ? (
                    <p
                      className={`vad-status ${frame.speaking ? "on" : ""}`}
                      title="نسبة ثقة النموذج في أن ما يصل إليه كلام"
                    >
                      <span className="dot" />
                      {frame.speaking ? "كلام" : "صمت"} —{" "}
                      {Math.round(frame.speechProb * 100)}٪ ثقة
                    </p>
                  ) : (
                    <p className="vad-status loading">
                      <span className="dot" />
                      جارٍ تحميل نموذج الكلام…
                    </p>
                  )}
                </>
              )}
              <Slider
                label="مضخّم المايك"
                min={0.5}
                max={4}
                step={0.05}
                value={settings.micDrive}
                format={(v) => `${v.toFixed(2)}×`}
                onChange={(micDrive) => patch({ micDrive })}
              />
              <Slider
                label="حساسية المايك"
                min={0}
                max={4}
                step={0.05}
                value={settings.inputGain}
                format={(v) => `${Math.round(v * 100)}٪`}
                onChange={(inputGain) => patch({ inputGain })}
              />
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.agc}
                  onChange={(e) => patch({ agc: e.target.checked })}
                />
                تتبع مستوى تلقائي (AGC)
              </label>
            </>
          )}

          {tab === "isolation" && (
            <>
              {frame.feedbackDetected && (
                <div className="feedback-alert">
                  ⚠️ <b>درع الحماية نشط:</b> تم كبح صفير الفيدباك وحماية السماعات تلقائياً لمنع الرنين!
                </div>
              )}

              <div className="quick-actions-bar">
                <button
                  type="button"
                  className="btn clean-btn"
                  onClick={applyInstantClean}
                  title="تفعيل الإعدادات المثالية لنقاء الصوت وعزل السماعات والضوضاء فوراً"
                >
                  ⚡ تنظيف فوري وشامل للمايك
                </button>
                <button
                  type="button"
                  className={`btn test-btn ${testingVoice ? "recording" : ""}`}
                  onClick={runQuickTest}
                  disabled={!running || testingVoice}
                  title="تسجيل 5 ثوانٍ وإعادة تشغيلها فوراً لسماع صوتك دون مخاطرة بصفير السماعات"
                >
                  {testingVoice ? `🔴 جارٍ التسجيل (${testCountdown}ث)…` : "🎙️ اختبر صوتك (5 ثوانٍ)"}
                </button>
              </div>

              <div className="iso-card" style={{ borderColor: settings.aiDenoiser ? "rgba(62, 207, 192, 0.35)" : undefined, background: settings.aiDenoiser ? "rgba(62, 207, 192, 0.04)" : undefined }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings.aiDenoiser}
                      onChange={(e) => patch({ aiDenoiser: e.target.checked })}
                    />
                    <b>عازل الضوضاء بالذكاء الاصطناعي (RNNoise AI)</b>
                  </label>
                  {frame.denoiserActive && (
                    <span className="ai-badge">⚡ ذكاء اصطناعي نشط</span>
                  )}
                </div>
                <p className="iso-hint">
                  يعزل فورياً عبر شبكة عصبية عميقة (RNN) صوت المراوح، الكيبورد، صدى الغرفة، وأصوات الخلفية المزعجة مع الحفاظ على نقاء ورنين صوتك الطبيعي دون استهلاك المعالج.
                </p>
                {settings.aiDenoiser && (
                  <div style={{ marginTop: 8, paddingRight: 24 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11.5px", color: "var(--muted)", marginBottom: 4 }}>
                      <span>نسبة العزل والامتصاص العصبي</span>
                      <span>{Math.round(settings.aiDenoiserMix * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={settings.aiDenoiserMix}
                      onChange={(e) => patch({ aiDenoiserMix: parseFloat(e.target.value) })}
                    />
                  </div>
                )}
              </div>

              <div className="iso-card" style={{ borderColor: settings.studioEnhancer ? "rgba(124, 77, 255, 0.35)" : undefined, background: settings.studioEnhancer ? "rgba(124, 77, 255, 0.04)" : undefined }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings.studioEnhancer}
                      onChange={(e) => patch({ studioEnhancer: e.target.checked })}
                    />
                    <b>مُحسِّن صفاء ونبرة الاستوديو (Broadcast Tone)</b>
                  </label>
                  {settings.studioEnhancer && (
                    <span className="ai-badge" style={{ background: "rgba(124, 77, 255, 0.15)", color: "#b388ff", borderColor: "rgba(124, 77, 255, 0.35)" }}>🎙️ استوديو احترافي</span>
                  )}
                </div>
                <p className="iso-hint">
                  يضبط تلقائياً منحنى الاستوديو الإذاعي: دفء صوتي عميق (Proximity Warmth)، وضوح حاد لمخارج الحروف (Air & Presence)، وترويض صفير حرف السين (De-Esser).
                </p>
              </div>

              <div className="iso-card">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.echoCancellation}
                    onChange={(e) => patch({ echoCancellation: e.target.checked })}
                  />
                  <b>إلغاء صدى السماعة (AEC)</b>
                </label>
                <p className="iso-hint">
                  يمنع وصول صوت السماعات، الألعاب والموسيقى إلى المايك تلقائياً عبر عزل الهاردوير المتقدم.
                </p>
              </div>

              <div className="iso-card">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.noiseSuppression}
                    onChange={(e) => patch({ noiseSuppression: e.target.checked })}
                  />
                  <b>كابت الضوضاء والتشويش المحيط</b>
                </label>
                <p className="iso-hint">
                  يزيل أصوات المراوح، مكيف الهواء، والنقر على الكيبورد وصوت الغرفة الخلفي.
                </p>
              </div>

              <div className="iso-card">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.speakerBleedShield}
                    onChange={(e) => patch({ speakerBleedShield: e.target.checked })}
                  />
                  <b>درع منع تسرب السماعات الذكي</b>
                </label>
                <p className="iso-hint">
                  يكتم تلقائياً أي تسرب أو صوت صادر من السماعات أثناء فترات الصمت بين جملك.
                </p>
              </div>

              <div className="iso-card">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={settings.antiFeedback}
                    onChange={(e) => patch({ antiFeedback: e.target.checked })}
                  />
                  <b>حامي الفيدباك والصفير التلقائي</b>
                </label>
                <p className="iso-hint">
                  يكبح الرنين والصفير الحاد تلقائياً ويحمي أذنيك وسماعاتك عند تفعيل المراقبة مع السبيكر.
                </p>
              </div>

              <div className="iso-status-pill">
                <span className="dot on" />
                {settings.echoCancellation && settings.speakerBleedShield
                  ? "عزل تسرب صدى السماعات نشط ويعمل بنسبة 100٪"
                  : "العزل مفعل جزئياً — يفضل تشغيل كافة الخيارات"}
              </div>
            </>
          )}

          <label className="check">
            <input
              type="checkbox"
              checked={settings.monitor}
              onChange={(e) => patch({ monitor: e.target.checked })}
            />
            مراقبة محلية على السماعات
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.bypass}
              onChange={(e) => patch({ bypass: e.target.checked })}
            />
            تجاوز المعالجة (صوت جاف)
          </label>
          <div className="bindings">
            <h3>الاختصارات</h3>
            {(
              [
                ["toggle", "تشغيل / إيقاف"],
                ["mute", "كتم"],
                ["bypass", "تجاوز"],
                ["ptt", "ضغط لتتحدث"],
              ] as [keyof Bindings, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="binding"
                onClick={() => setRebinding(key)}
              >
                <span>{label}</span>
                <b>
                  {rebinding === key
                    ? "اضغط مفتاح…"
                    : keyLabel(prefs.bindings[key])}
                  {key === "ptt" || !isGloballySafe(prefs.bindings[key])
                    ? " · داخل التطبيق فقط"
                    : globalFailures?.includes(key)
                      ? " · محجوز بمفتاح آخر"
                      : ""}
                </b>
              </button>
            ))}
            <p className="keys-hint">
              اضغط المفتاح الذي تريده للمسبق المحدد. مفاتيح F1–F24 وحدها تعمل
              عالمياً حتى خارج نافذة نبرة (داخل الألعاب وديسكورد) — لم أتعمّد
              تسجيل الحروف أو المسافة عالمياً لأن ذلك يعطّل الكتابة في كل
              التطبيقات الأخرى. بقية المفاتيح، ومنها «ضغط لتتحدث»، تعمل داخل
              التطبيق فقط، لأن النظام لا يبلغ برفع المفتاح عالمياً.
            </p>
          </div>
          <button
            className="btn ghost"
            type="button"
            onClick={() => setSettings(defaultSettings())}
          >
            استعادة الضبط الافتراضي
          </button>
        </section>
      </main>

      <footer className="dock">
        <button
          className={`btn huge ${running ? "stop" : "primary"}`}
          type="button"
          disabled={
            busy || calibrating !== null || (!running && (!inputId || !outputId))
          }
          onClick={() => void toggleRoute()}
        >
          {busy ? "..." : running ? "إيقاف التوجيه" : "ابدأ التوجيه"}
        </button>
        <button
          className="btn"
          type="button"
          disabled={!running}
          onClick={() => void router.playTestTone()}
        >
          نغمة اختبار
        </button>
        <button
          className={`btn rec ${recording ? "on" : ""}`}
          type="button"
          disabled={!running}
          onClick={recording ? stopRecording : startRecording}
        >
          {recording ? "إيقاف التسجيل" : "تسجيل"}
        </button>
        <div className="vol">
          <button
            className={`btn mute ${settings.muted || settings.outputGain === 0 ? "on" : ""}`}
            type="button"
            onClick={() =>
              patch({
                muted: !settings.muted,
                outputGain:
                  settings.muted && settings.outputGain === 0
                    ? 1
                    : settings.outputGain,
              })
            }
          >
            {settings.muted || settings.outputGain === 0 ? "صامت" : "صوت"}
          </button>
          <label className="vol-slider">
            <span>درجة الصوت</span>
            <input
              type="range"
              min={0}
              max={400}
              step={1}
              value={settings.muted ? 0 : Math.round(settings.outputGain * 100)}
              onChange={(e) =>
                patch({
                  muted: false,
                  outputGain: Number(e.target.value) / 100,
                })
              }
            />
            <b>{settings.muted ? 0 : Math.round(settings.outputGain * 100)}٪</b>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
      </footer>
    </div>
  );
}

function fmtHz(value: number | null) {
  return value == null ? "—" : value.toFixed(1);
}

function keyLabel(code: string): string {
  const map: Record<string, string> = {
    Space: "مسافة",
    ShiftLeft: "Shift أيسر",
    ShiftRight: "Shift أيمن",
    ControlLeft: "Ctrl أيسر",
    ControlRight: "Ctrl أيمن",
    AltLeft: "Alt أيسر",
    AltRight: "Alt أيمن",
    Enter: "Enter",
    Tab: "Tab",
    Backquote: "`",
    Escape: "Esc",
    KeyA: "A",
    KeyB: "B",
    KeyC: "C",
    KeyM: "M",
    KeyN: "N",
    KeyP: "P",
    KeyR: "R",
    KeyS: "S",
    KeyT: "T",
    KeyV: "V",
    KeyX: "X",
    KeyY: "Y",
    KeyZ: "Z",
  };
  if (map[code]) return map[code]!;
  if (/^Key[A-Z]$/.test(code)) return code.replace("Key", "");
  if (/^Digit\d$/.test(code)) return code.replace("Digit", "");
  if (/^F\d{1,2}$/.test(code)) return code;
  return code;
}

function signed(value: number, digits = 2) {
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
}

const Calc = memo(function Calc({
  label,
  value,
  unit,
  accent,
}: {
  label: string;
  value: string;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div className={`calc ${accent ? "accent" : ""}`}>
      <span>{label}</span>
      <strong>
        {value}
        {unit ? <em>{unit}</em> : null}
      </strong>
    </div>
  );
});

const Slider = memo(function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="slider">
      <span>
        {label}
        <b>{format(value)}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
});

const Meter = memo(function Meter({
  label,
  db,
  hot,
}: {
  label: string;
  db: number;
  hot: boolean;
}) {
  const pct = Math.min(100, Math.max(0, ((db + 60) / 60) * 100));
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <div className="meter-track">
        <i
          style={{ width: `${pct}%` }}
          className={hot ? "hot" : db > -60 ? "live" : ""}
        />
      </div>
      <b>{db.toFixed(0)}</b>
    </div>
  );
});

const Tuner = memo(function Tuner({
  cents,
  reference,
  live,
}: {
  cents: number;
  reference: string;
  live: boolean;
}) {
  const clamped = Math.max(-50, Math.min(50, cents));
  const pct = ((clamped + 50) / 100) * 100;
  // Silence reports 0 cents, which used to light the "in tune" state with no
  // voice present at all. Only claim a reading when there is one.
  const onPitch = live && Math.abs(cents) < 5;
  return (
    <div className={`tuner ${onPitch ? "on" : ""}`}>
      <span>الضبط الحيّ{live && reference !== "—" ? ` — ${reference}` : ""}</span>
      <div className="tuner-track">
        <i className="tuner-mid" />
        <i
          className="tuner-dot"
          style={{ insetInlineStart: live ? `${pct}%` : "50%" }}
        />
      </div>
      <b>
        {live ? (
          <>
            {cents > 0 ? "+" : ""}
            {cents.toFixed(0)}¢
          </>
        ) : (
          "—"
        )}
      </b>
    </div>
  );
});

function Waveform({ analyser }: { analyser: AnalyserNode | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    // Resized to the analyser's own fftSize rather than assumed. A fixed buffer
    // plus `subarray` would truncate silently and stretch the trace if the
    // analyser's window were ever raised past it.
    let data = new Uint8Array(analyser?.fftSize ?? 2048);
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const pixelW = Math.max(1, Math.floor(w * dpr));
      const pixelH = Math.max(1, Math.floor(h * dpr));
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0c1018";
      ctx.fillRect(0, 0, w, h);
      ctx.beginPath();
      ctx.strokeStyle = analyser ? "#3ecfc0" : "#2a3140";
      ctx.lineWidth = 2;
      if (analyser) {
        const count = analyser.fftSize;
        if (data.length !== count) data = new Uint8Array(count);
        analyser.getByteTimeDomainData(data);
        const slice = w / count;
        for (let i = 0; i < count; i++) {
          const x = i * slice;
          const y = ((data[i] ?? 128) / 255) * h;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      } else {
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
      }
      ctx.stroke();
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);
  return <canvas ref={canvasRef} className="wave" />;
}

/** Log-spaced display range for the spectrum, in Hz. */
const SPEC_MIN_HZ = 40;
const SPEC_MAX_HZ = 16000;
const SPEC_BARS = 72;

function Spectrum({ analyser }: { analyser: AnalyserNode | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    // `frequencyBinCount` is fftSize/2; the buffer is sized to match so a
    // changed analyser configuration cannot leave stale bins on the right.
    let data = new Uint8Array(1024);
    const levels = new Float32Array(SPEC_BARS);
    // Bucket edges in FFT-bin units, rebuilt only if the graph is replaced.
    let edges = new Float32Array(SPEC_BARS + 1);
    let edgesKey = "";
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const pixelW = Math.max(1, Math.floor(w * dpr));
      const pixelH = Math.max(1, Math.floor(h * dpr));
      if (canvas.width !== pixelW || canvas.height !== pixelH) {
        canvas.width = pixelW;
        canvas.height = pixelH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0c1018";
      ctx.fillRect(0, 0, w, h);
      if (analyser) {
        const bins = analyser.frequencyBinCount;
        if (data.length !== bins) data = new Uint8Array(bins);
        analyser.getByteFrequencyData(data);
        const hzPerBin = analyser.context.sampleRate / 2 / bins;
        const key = `${bins}:${analyser.context.sampleRate}`;
        if (key !== edgesKey) {
          edgesKey = key;
          // The old display took the first 96 linear bins, which at 48 kHz is
          // 0-2.2 kHz: everything above that, including the whole sibilance
          // range the de-esser works on, was simply never drawn. Log spacing
          // gives the bass and the air the same number of bars.
          const top = Math.min(SPEC_MAX_HZ, analyser.context.sampleRate / 2);
          for (let i = 0; i <= SPEC_BARS; i++) {
            const hz = SPEC_MIN_HZ * (top / SPEC_MIN_HZ) ** (i / SPEC_BARS);
            edges[i] = Math.max(0, Math.min(bins - 1, hz / hzPerBin));
          }
        }
        for (let i = 0; i < SPEC_BARS; i++) {
          const lo = edges[i]!;
          const hi = edges[i + 1]!;
          let peak = 0;
          if (hi - lo < 1) {
            // Low buckets are narrower than one FFT bin, so take the nearest.
            peak = (data[Math.round(lo)] ?? 0) / 255;
          } else {
            for (let b = Math.floor(lo); b <= Math.ceil(hi) && b < bins; b++) {
              const v = (data[b] ?? 0) / 255;
              if (v > peak) peak = v;
            }
          }
          // Gentle peak-hold so transients stay readable between frames.
          levels[i] = Math.max(peak, levels[i]! * 0.82);
        }
        const gap = 1;
        const bw = Math.max(2, (w - SPEC_BARS * gap) / SPEC_BARS);
        for (let i = 0; i < SPEC_BARS; i++) {
          const v = levels[i]!;
          const bh = v * (h - 4);
          ctx.fillStyle = `rgba(62, 207, 192, ${0.25 + v * 0.75})`;
          ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);
  return <canvas ref={canvasRef} className="spec" />;
}
