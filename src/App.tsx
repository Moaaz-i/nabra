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
  localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
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
};

type Saved = {
  inputId?: string;
  outputId?: string;
  settings?: Partial<VoiceSettings>;
};

type EngineTab = "pitch" | "tone" | "effects" | "dyn";

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
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    url: string;
  } | null>(null);
  const recordingRef = useRef<MediaRecorder | null>(null);
  const pttDownRef = useRef(false);
  /** Mute state to put back when a push-to-talk key is released. */
  const muteBeforePttRef = useRef<boolean | null>(null);
  const recorderChunksRef = useRef<BlobPart[]>([]);
  const recorderStopResolveRef = useRef<(() => void) | null>(null);
  const [rebinding, setRebinding] = useState<keyof Bindings | null>(null);
  const rebindingRef = useRef(false);

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
    return window.nabra?.onUpdateAvailable(
      (info: { version: string; url: string }) => setUpdateInfo(info),
    );
  }, []);

  const targetNotes = useMemo(() => {
    const notes = [];
    for (let midi = 36; midi <= 84; midi++) {
      notes.push({ midi, name: midiToName(midi) });
    }
    return notes;
  }, []);

  const loadDevices = useCallback(async (forcePrompt = false) => {
    setError("");
    try {
      await requestAudioAccess(forcePrompt);
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
  }, [router]);

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
    if (runningRef.current) {
      busyRef.current = true;
      setBusy(true);
      runningRef.current = false;
      setRunning(false);
      setFrame(emptyFrame);
      try {
        const rec = recordingRef.current;
        if (rec && rec.state !== "inactive") {
          // `rec.stop()` only fires `onstop` asynchronously, and never at all
          // if the track ends first, so the wait is bounded.
          await new Promise<void>((resolve) => {
            recorderStopResolveRef.current = resolve;
            rec.stop();
            setTimeout(() => {
              if (!recorderStopResolveRef.current) return;
              recorderStopResolveRef.current = null;
              recordingRef.current = null;
              setRecording(false);
              resolve();
            }, RECORDER_STOP_TIMEOUT_MS);
          });
        }
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
  }, [router]);

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

  const startRecording = useCallback(() => {
    if (recordingRef.current || !runningRef.current) return;
    const stream = router.getOutputStream();
    if (!stream) return;
    let mimeType = "audio/webm;codecs=opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "audio/webm";
    try {
      const rec = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000,
      });
      recordingRef.current = rec;
      setRecording(true);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) recorderChunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const blob = new Blob(recorderChunksRef.current, { type: mimeType });
        recorderChunksRef.current = [];
        setRecording(false);
        recordingRef.current = null;
        recorderStopResolveRef.current?.();
        recorderStopResolveRef.current = null;
        if (blob.size === 0) return;
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = String(reader.result).split(",")[1] ?? "";
          const stamp = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          const local =
            `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}` +
            `-${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}`;
          void saveRecordingFile(`نبرة-${local}.webm`, base64);
        };
        reader.readAsDataURL(blob);
      };
      rec.start(500);
    } catch {
      setRecording(false);
    }
  }, [router]);

  const stopRecording = useCallback(() => {
    const rec = recordingRef.current;
    if (!rec) return;
    // `stop()` throws if the recorder is already inactive (a track can end on
    // its own), and a second click must not queue another stop.
    if (rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        recordingRef.current = null;
        setRecording(false);
      }
    }
  }, []);

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
      const existing = loadCustomPresets();
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
  }, [setError]);

  const toggleAlwaysOnTop = useCallback(
    (flag: boolean) => {
      setPrefs((current) => ({ ...current, alwaysOnTop: flag }));
      void window.nabra?.setAlwaysOnTop(flag);
    },
    [setPrefs],
  );

  /** Puts the mute state that was in force before PTT was held back. */
  const releasePtt = useCallback(() => {
    if (!pttDownRef.current) return;
    pttDownRef.current = false;
    const restore = muteBeforePttRef.current;
    muteBeforePttRef.current = null;
    // `null` means PTT was never engaged here, so leave mute alone.
    if (restore == null) return;
    patch({ muted: restore });
  }, [patch]);

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
        if (fresh && !pttDownRef.current) {
          pttDownRef.current = true;
          muteBeforePttRef.current = settingsRef.current.muted;
          patch({ muted: false });
        }
        return;
      }
      if (event.code === b.toggle) {
        event.preventDefault();
        if (fresh) void toggleRoute();
        return;
      }
      if (event.code === b.mute) {
        event.preventDefault();
        if (fresh) {
          patch((current: VoiceSettings) => ({ muted: !current.muted }));
        }
        return;
      }
      if (event.code === b.bypass) {
        event.preventDefault();
        if (fresh) {
          patch((current: VoiceSettings) => ({ bypass: !current.bypass }));
        }
      }
    },
    [prefs.bindings, toggleRoute, patch],
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
  // control; everything the preset does not mention goes back to default.
  const applyPreset = useCallback(
    (presetSettings: Partial<VoiceSettings>) => {
      setSettings((current) =>
        sanitizeSettings({
          ...defaultSettings(),
          outputGain: current.outputGain,
          muted: current.muted,
          monitor: current.monitor,
          bypass: current.bypass,
          inputGain: current.inputGain,
          micDrive: current.micDrive,
          gateEnabled: current.gateEnabled,
          gateThreshold: current.gateThreshold,
          detector: current.detector,
          latencyMode: current.latencyMode,
          targetMidi: current.targetMidi,
          scale: current.scale,
          rootPc: current.rootPc,
          ...presetSettings,
        }),
      );
    },
    [],
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
                    setCustomPresets(removeCustomPreset(preset.id))
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
              طبقة
            </button>
            <button
              type="button"
              className={tab === "tone" ? "on" : ""}
              onClick={() => setTab("tone")}
            >
              طابع
            </button>
            <button
              type="button"
              className={tab === "effects" ? "on" : ""}
              onClick={() => setTab("effects")}
            >
              تأثيرات
            </button>
            <button
              type="button"
              className={tab === "dyn" ? "on" : ""}
              onClick={() => setTab("dyn")}
            >
              ديناميك
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
                زمن استجابة التبديل
                <select
                  value={settings.latencyMode}
                  onChange={(e) =>
                    patch({
                      latencyMode: e.target
                        .value as VoiceSettings["latencyMode"],
                    })
                  }
                >
                  <option value="standard">
                    قياسي — جودة أعلى (محرِّك طوري)
                  </option>
                  <option value="low">منخفض — استجابة أسرع</option>
                </select>
              </label>
              {running && router.latencyModePending && (
                <div className="hint">
                  <strong>زمن الاستجابة لن يتغيّر أثناء التشغيل</strong>
                  <span>
                    نافذة المحرِّك الطوري تُبنى عند بدء التوجيه فقط. أوقف التوجيه
                    وابدأه ليُطبَّق وضع{" "}
                    {settings.latencyMode === "low" ? " «منخفض»." : " «قياسي»."}
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

          {tab === "tone" && (
            <>
              <Slider
                label="تمرير عالٍ"
                min={20}
                max={300}
                step={1}
                value={settings.highpassHz}
                format={(v) => `${v.toFixed(0)} Hz`}
                onChange={(highpassHz) => patch({ highpassHz })}
              />
              <Slider
                label="تمرير منخفض"
                min={2500}
                max={18000}
                step={50}
                value={settings.lowpassHz}
                format={(v) => `${v.toFixed(0)} Hz`}
                onChange={(lowpassHz) => patch({ lowpassHz })}
              />
              <Slider
                label="دفء"
                min={-6}
                max={8}
                step={0.1}
                value={settings.warmth}
                format={(v) => `${signed(v)} dB`}
                onChange={(warmth) => patch({ warmth })}
              />
              <Slider
                label="حضور"
                min={-4}
                max={8}
                step={0.1}
                value={settings.presence}
                format={(v) => `${signed(v)} dB`}
                onChange={(presence) => patch({ presence })}
              />
              <Slider
                label="تهدئة الصفير"
                min={0}
                max={1}
                step={0.01}
                value={settings.deess}
                format={(v) => `${Math.round(v * 100)}٪`}
                onChange={(deess) => patch({ deess })}
              />
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
            </>
          )}

          {tab === "dyn" && (
            <>
              <Slider
                label="ضغط"
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
                  max={-30}
                  step={1}
                  value={settings.gateThreshold}
                  format={(v) => `${v.toFixed(0)} dB`}
                  onChange={(gateThreshold) => patch({ gateThreshold })}
                />
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
                </b>
              </button>
            ))}
            <p className="keys-hint">
              اضغط المفتاح الذي تريده للمسبق المحدد. مفتاح «ضغط لتتحدث» يُسمع
              أثناء الضغط ويُكتم عند الرفع.
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
          disabled={busy || (!running && (!inputId || !outputId))}
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
