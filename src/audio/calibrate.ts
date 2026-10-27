/**
 * One-click microphone calibration.
 *
 * `captureMic` records a short guided sample (silence, then speech) through
 * the same raw capture path the router uses. `analyzeMic`/`calibrateMic`
 * turn those samples into a report, human-readable findings, and a settings
 * patch that fixes what was measured -- so the user does not have to dial
 * gates, filters and compressors by hand.
 *
 * The analysis half is deliberately pure (`Float32Array` in, numbers out) and
 * runs unchanged in the Node test suite; only `captureMic` touches the DOM.
 */
import { openMic } from "./devices";
import {
  clampSetting,
  defaultSettings,
  type VoiceSettings,
} from "./settings";
import { rms, rmsToDb } from "./yin";

// --- Capture ---------------------------------------------------------------

/** How long the mic is listened to for room tone vs. for speech. */
export const CALIBRATION_SILENCE_MS = 1200;
export const CALIBRATION_SPEECH_MS = 3500;

export type CapturePhase = "silence" | "speech";

/**
 * The capture worklet lives here as a string for the same reason the pitch
 * worklet does: it must be registered from a blob URL, with no build-time
 * asset to fetch inside `loadFile`.
 */
const CAPTURE_WORKLET_SOURCE = `
class NabraCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input && input.length > 0 && input[0]) {
      this.port.postMessage(input[0].slice())
    }
    return true
  }
}
registerProcessor("nabra-capture", NabraCaptureProcessor)
`;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Records the raw mic for `silenceMs + speechMs`, reporting the phase so the
 * UI can tell the user when to stay quiet and when to talk. Stops every track
 * and closes the context on both the success and the failure path.
 */
export async function captureMic(
  deviceId: string,
  onPhase?: (phase: CapturePhase) => void,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const stream = await openMic(deviceId || undefined);
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
    const sampleRate = ctx.sampleRate;
    const blobUrl = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET_SOURCE], { type: "application/javascript" }),
    );
    await ctx.audioWorklet
      .addModule(blobUrl)
      .finally(() => URL.revokeObjectURL(blobUrl));
    const node = new AudioWorkletNode(ctx, "nabra-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: "explicit",
      outputChannelCount: [1],
    });
    const chunks: Float32Array[] = [];
    let total = 0;
    node.port.onmessage = (event: MessageEvent) => {
      const chunk = event.data as Float32Array;
      chunks.push(chunk);
      total += chunk.length;
    };
    const source = ctx.createMediaStreamSource(stream);
    source.connect(node);
    // A worklet that is not reachable from the destination is never pulled by
    // the render graph on some engines; the muted sink keeps it running
    // without monitoring the raw mic into the user's speakers.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);

    onPhase?.("silence");
    await sleep(CALIBRATION_SILENCE_MS);
    onPhase?.("speech");
    const target = Math.round(
      (sampleRate * (CALIBRATION_SILENCE_MS + CALIBRATION_SPEECH_MS)) / 1000,
    );
    const deadline = performance.now() + CALIBRATION_SPEECH_MS + 2500;
    while (total < target && performance.now() < deadline) await sleep(40);
    node.port.onmessage = null;

    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return { samples, sampleRate };
  } finally {
    for (const track of stream.getTracks()) track.stop();
    await ctx?.close().catch(() => undefined);
  }
}

// --- Analysis --------------------------------------------------------------

/** Analysis window: 2048 samples at 48 kHz is ~23 Hz per FFT bin -- enough
 *  to see a 50/60 Hz hum line against its neighbourhood. */
export const FRAME = 2048;
const HOP = 1024;

/** The speech level calibration steers the input towards. */
const TARGET_SPEECH_DB = -20;

export type MicReport = {
  noiseFloorDb: number;
  speechDb: number;
  peakDb: number;
  /** p90 − p10 of the active speech frames: how wide the dynamics are. */
  dynamicsDb: number;
  /** Prominence of the 50/60 Hz hum line (and harmonics) over its floor. */
  humDb: number;
  /** <80 Hz vs. 120–800 Hz in speech: room rumble and handling noise. */
  rumbleDb: number;
  /** 6–14 kHz vs. 300–3 kHz of the noise floor: broadband hiss. */
  hissDb: number;
  /** 5.5–9 kHz vs. 0.5–2.5 kHz of speech: harsh "s" and "sh" sounds. */
  sibilanceDb: number;
  /** 180–450 Hz vs. 0.5–2 kHz of speech: boxy, muddy low mids. */
  mudDb: number;
  /** 2–5 kHz vs. 0.5–1.5 kHz of speech: clarity / telephone presence. */
  presenceDb: number;
  clipped: boolean;
  activeRatio: number;
  speechFrames: number;
};

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const vRe = re[b] * curRe - im[b] * curIm;
        const vIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - vRe;
        im[b] = im[a] - vIm;
        re[a] += vRe;
        im[a] += vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Hann-windowed magnitude spectrum of one frame, normalised by N. */
function frameSpectrum(frame: Float32Array): Float64Array {
  const n = frame.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hann =
      0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = frame[i] * hann;
  }
  fftInPlace(re, im);
  const half = n >> 1;
  const mag = new Float64Array(half);
  for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]) / n;
  return mag;
}

/** Mean power of the bins between f1 and f2, in dB. */
function bandDb(mag: Float64Array, sampleRate: number, f1: number, f2: number): number {
  const n = mag.length * 2;
  const k1 = Math.max(1, Math.round((f1 * n) / sampleRate));
  const k2 = Math.min(mag.length - 1, Math.round((f2 * n) / sampleRate));
  let sum = 0;
  let count = 0;
  for (let k = k1; k <= k2; k++) {
    sum += mag[k] * mag[k];
    count++;
  }
  if (count === 0) return -200;
  return 10 * Math.log10(sum / count + 1e-20);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return -200;
  const idx = clampSetting(Math.round((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

/**
 * Prominence of the mains hum lines over the noise around them.
 *
 * A 2048-sample frame has ~23 Hz bins at 48 kHz -- far too coarse to tell a
 * 50/60 Hz line from its neighbours, so the quiet run is measured on a
 * dedicated long window (16384 samples ≈ 3 Hz per bin). The line is the peak
 * within ±1 bin of each partial; the floor is the *strongest* bin 5–8 bins
 * away (past the Hann main lobe), which keeps ordinary broadband noise from
 * ever masquerading as a hum line.
 */
function humProminence(quiet: Float32Array | null, sampleRate: number): number {
  if (!quiet || quiet.length < 4096) return 0;
  const n = 1 << Math.floor(Math.log2(quiet.length));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = quiet[i] * hann;
  }
  fftInPlace(re, im);
  const half = n >> 1;
  const mag = new Float64Array(half);
  for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]) / n;
  const bin = (hz: number) =>
    clampSetting(Math.round((hz * n) / sampleRate), 1, half - 1);
  let prominence = 0;
  for (const base of [50, 60]) {
    for (const multiple of [1, 2, 3]) {
      const k0 = bin(base * multiple);
      let peak = 0;
      for (let k = Math.max(1, k0 - 1); k <= Math.min(half - 1, k0 + 1); k++) {
        peak = Math.max(peak, mag[k]);
      }
      let floorMag = 0;
      for (let d = 5; d <= 8; d++) {
        if (k0 - d >= 1) floorMag = Math.max(floorMag, mag[k0 - d]);
        if (k0 + d < half) floorMag = Math.max(floorMag, mag[k0 + d]);
      }
      if (floorMag > 0) {
        prominence = Math.max(
          prominence,
          20 * Math.log10(peak / floorMag + 1e-9),
        );
      }
    }
  }
  return prominence;
}

/** The longest contiguous run of quiet frames, as raw samples. */
function quietRun(
  samples: Float32Array,
  quietIdx: number[],
  hop: number,
  frame: number,
): Float32Array | null {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let prev = -2;
  for (const i of quietIdx) {
    if (i !== prev + 1) runStart = i;
    if (i - runStart + 1 > bestLen) {
      bestLen = i - runStart + 1;
      bestStart = runStart;
    }
    prev = i;
  }
  if (bestStart < 0) return null;
  const from = bestStart * hop;
  const to = Math.min(
    samples.length,
    (bestStart + bestLen - 1) * hop + frame,
  );
  return samples.subarray(from, to);
}

/** Runs of samples pinned at (or past) full scale: the mic is clipping. */
function detectClipping(samples: Float32Array): boolean {
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= 0.985) {
      if (++run >= 4) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/**
 * Measures the capture. The first ~1.2 s is treated as room tone and the
 * loud frames as speech; every number is relative (dB) except the levels.
 */
export function analyzeMic(
  samples: Float32Array,
  sampleRate: number,
): MicReport {
  const frames: Float32Array[] = [];
  const frameDb: number[] = [];
  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    frames.push(samples.subarray(start, start + FRAME));
    frameDb.push(rmsToDb(rms(samples.subarray(start, start + FRAME))));
  }
  const sorted = [...frameDb].sort((a, b) => a - b);
  const noiseFloorDb = percentile(sorted, 10);

  const activeIdx: number[] = [];
  for (let i = 0; i < frameDb.length; i++) {
    if (frameDb[i] > noiseFloorDb + 12 && frameDb[i] > -60) activeIdx.push(i);
  }
  const quietIdx: number[] = [];
  for (let i = 0; i < frameDb.length; i++) {
    if (frameDb[i] <= noiseFloorDb + 6) quietIdx.push(i);
  }

  const activeDb = activeIdx.map((i) => frameDb[i]).sort((a, b) => a - b);
  const speechDb = percentile(activeDb, 50);
  const peakDb = activeDb.length ? activeDb[activeDb.length - 1] : -200;
  const dynamicsDb = activeDb.length >= 4
    ? percentile(activeDb, 90) - percentile(activeDb, 10)
    : 0;

  const quietRaw = quietRun(samples, quietIdx, HOP, FRAME);
  const speechMag = averageSpectraFrom(frames, activeIdx);
  const noiseMag = averageSpectraFrom(frames, quietIdx);

  return {
    noiseFloorDb,
    speechDb,
    peakDb,
    dynamicsDb,
    humDb: humProminence(quietRaw, sampleRate),
    rumbleDb: speechMag
      ? bandDb(speechMag, sampleRate, 30, 80) -
        bandDb(speechMag, sampleRate, 120, 800)
      : -200,
    hissDb: noiseMag
      ? bandDb(noiseMag, sampleRate, 6000, 14000) -
        bandDb(noiseMag, sampleRate, 300, 3000)
      : -200,
    sibilanceDb: speechMag
      ? bandDb(speechMag, sampleRate, 5500, 9000) -
        bandDb(speechMag, sampleRate, 500, 2500)
      : -200,
    mudDb: speechMag
      ? bandDb(speechMag, sampleRate, 180, 450) -
        bandDb(speechMag, sampleRate, 500, 2000)
      : -200,
    presenceDb: speechMag
      ? bandDb(speechMag, sampleRate, 2000, 5000) -
        bandDb(speechMag, sampleRate, 500, 1500)
      : -200,
    clipped: detectClipping(samples),
    activeRatio: frames.length ? activeIdx.length / frames.length : 0,
    speechFrames: activeIdx.length,
  };
}

function averageSpectraFrom(
  frames: Float32Array[],
  indices: number[],
): Float64Array | null {
  if (indices.length === 0) return null;
  let avg: Float64Array | null = null;
  for (const i of indices) {
    const mag = frameSpectrum(frames[i]);
    if (!avg) avg = new Float64Array(mag.length);
    for (let k = 0; k < mag.length; k++) avg[k] += mag[k];
  }
  if (avg) {
    for (let k = 0; k < avg.length; k++) avg[k] /= indices.length;
  }
  return avg;
}

// --- Recommendations -------------------------------------------------------

export type MicFinding = {
  severity: "ok" | "warn" | "bad";
  message: string;
};

export type Calibration = {
  report: MicReport;
  findings: MicFinding[];
  /** Only the knobs the calibration actually changed. */
  settings: Partial<VoiceSettings>;
};

/**
 * Turns measurements into a settings patch. `current` is the live input gain
 * so re-running the calibration adjusts relative to where the user already
 * is, instead of assuming the defaults.
 */
export function calibrateMic(
  samples: Float32Array,
  sampleRate: number,
  current: VoiceSettings = defaultSettings(),
): Calibration {
  const report = analyzeMic(samples, sampleRate);
  const findings: MicFinding[] = [];
  const settings: Partial<VoiceSettings> = {};

  // Nothing usable was spoken: refuse to "fix" a mic on silence alone.
  if (report.speechFrames < 5 || report.speechDb < -55) {
    findings.push({
      severity: "bad",
      message:
        "لم أسمع صوتاً واضحاً أثناء المعايرة. اضغط «معايرة» مرة أخرى وتكلّم بشكل طبيعي قرب المايك.",
    });
    return { report, findings, settings };
  }

  let highpassHz = current.highpassHz;

  if (report.clipped) {
    findings.push({
      severity: "bad",
      message:
        "الصوت يصل إلى حدّ القطع (تشوّه). خفّضت مضخّم الدخل حتى يعود بمسافة أمان.",
    });
  }

  if (report.humDb > 8) {
    highpassHz = Math.max(highpassHz, 90);
    findings.push({
      severity: "warn",
      message:
        "طنين كهرباء (50/60 هرتز) في الغرفة. رفعت المرشّح السفلي إلى 90 هرتز لتخفيفه.",
    });
  }
  if (report.rumbleDb > -6) {
    highpassHz = Math.max(highpassHz, 110);
    findings.push({
      severity: "warn",
      message:
        "رنّة منخفضة (تكيّف/مروحة/طاولة). رفعت المرشّح السفلي إلى 110 هرتز لتنقية الصوت.",
    });
  }
  if (highpassHz !== current.highpassHz) {
    settings.highpassHz = clampSetting(highpassHz, 20, 300);
  }

  if (report.noiseFloorDb > -50) {
    const gate = clampSetting(
      Math.round(report.noiseFloorDb + 12),
      -80,
      -20,
    );
    settings.gateEnabled = true;
    settings.gateThreshold = gate;
    findings.push({
      severity: report.noiseFloorDb > -42 ? "bad" : "warn",
      message:
        `الضوضاء المحيطة مرتفعة (${Math.round(report.noiseFloorDb)} ديسيبل). ` +
        `فعّلت البوابة عند ${gate} ديسيبل لتنظيف الكلام بين الجمل.`,
    });
  }

  if (report.hissDb > -2) {
    settings.lowpassHz = clampSetting(
      Math.min(current.lowpassHz, 14000),
      1200,
      20000,
    );
    findings.push({
      severity: "warn",
      message: "هيس عالي الترددات (فحيح مستمر). خفّضت حدّ الترددات العالية إلى 14 كيلوهرتز.",
    });
  }

  if (report.sibilanceDb > -8) {
    settings.deess = 0.55;
    findings.push({
      severity: "bad",
      message: "صوت السين والشين حادّ جداً (sibilance). ضبطت مخفّف الوضوح على وضع قوي.",
    });
  } else if (report.sibilanceDb > -16) {
    settings.deess = Math.max(current.deess, 0.3);
    findings.push({
      severity: "warn",
      message: "الحالات الحادّة قليلة التهدئة. فعّلت مخفّف الوضوح بشكل متوسط.",
    });
  }

  if (report.presenceDb < -18) {
    settings.presence = clampSetting(current.presence + 4, -12, 12);
    findings.push({
      severity: "warn",
      message: "الصوت بعيد أو مكتوم (ضعف في ترددات الوضوح 2–5 كيلوهرتز). رفعت الحضور.",
    });
  } else if (report.presenceDb > -2) {
    settings.presence = clampSetting(current.presence - 2, -12, 12);
    findings.push({
      severity: "warn",
      message: "الصوت خشن/حادّ في الترددات المتوسطة-العالية. خفّضت الحضور قليلاً.",
    });
  }

  if (report.mudDb > 8) {
    settings.warmth = clampSetting(current.warmth - 3, -12, 12);
    findings.push({
      severity: "warn",
      message: "صوت وَخِيم (طنين في 180–450 هرتز). خفّضت الدفء قليلاً لتنقيته.",
    });
  }

  // Dynamics: how much the level wanders while the user talks normally.
  if (report.dynamicsDb > 25) {
    settings.compress = 0.45;
    settings.agc = true;
    findings.push({
      severity: "bad",
      message:
        "المستوى يتذبذب بقوة أثناء الكلام (ديناميكية واسعة). فعّلت الضغط التلقائي والمضخّم التكيّفي ليصير الصوت متسقاً.",
    });
  } else if (report.dynamicsDb > 18) {
    settings.compress = 0.3;
    findings.push({
      severity: "warn",
      message: "تذبذب متوسط في المستوى. زدت الضغط قليلاً لتثبيت الصوت.",
    });
  } else if (report.dynamicsDb > 12) {
    settings.compress = Math.max(current.compress, 0.18);
    findings.push({
      severity: "ok",
      message: "الديناميكية ضمن الحدود السليمة؛ ضبطت الضغط على قيمة خفيفة.",
    });
  }

  // Level: steer the median speech level towards −20 dBFS unless that would
  // push an already clipping signal further into the ceiling.
  let gain = current.inputGain * 10 ** ((TARGET_SPEECH_DB - report.speechDb) / 20);
  gain = clampSetting(gain, 0.25, report.clipped ? 0.7 : 8);
  if (Math.abs(gain - current.inputGain) > 0.05) {
    settings.inputGain = Number(gain.toFixed(2));
    const dir = gain > current.inputGain ? "رفعت" : "خفّضت";
    findings.push({
      severity: "ok",
      message:
        `المستوى ${report.speechDb < TARGET_SPEECH_DB - 4 ? "ضعيف" : report.speechDb > TARGET_SPEECH_DB + 4 ? "مرتفع" : "مناسب"} ` +
        `(${Math.round(report.speechDb)} ديسيبل مقابل هدف −20). ${dir} مضخّم الدخل إلى ×${gain.toFixed(2)}.`,
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "ok",
      message: "المايك في حالة ممتازة — لم أحتج تغيير أي إعداد.",
    });
  }

  return { report, findings, settings };
}
