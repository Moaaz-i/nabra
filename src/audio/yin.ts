const MIN_HZ = 45;
const MAX_HZ = 1500;

/**
 * Pitch detection is the hottest code in the app: it runs on the animation
 * frame. The difference/MCM inner loops are O(n^2), so we detect on a 2x
 * box-filtered copy of the window. Decimation keeps the *time* span of the
 * window identical (and therefore the reachable lowest frequency), while
 * quartering the arithmetic. Parabolic interpolation absorbs the coarser tau
 * grid, so measured accuracy is unchanged.
 */
const DECIMATION = 2;

/** Below ~-80 dBFS there is no pitch to find; skip the search entirely. */
const SILENCE_FLOOR = 1e-4;

/** A MCM peak must reach this fraction of the strongest peak to be accepted. */
const MCM_PEAK_RATIO = 0.9;
/** ...and this absolute value, so silence never produces a confident answer. */
const MCM_MIN_CORRELATION = 0.6;

export type PitchMethod = "auto" | "yin" | "mcm";

// Reused across calls so a 30-60 Hz cadence does not churn the GC.
let scratchWindow: Float32Array<ArrayBuffer> = new Float32Array(0);
let scratchNsdf: Float32Array<ArrayBuffer> = new Float32Array(0);
let scratchPower: Float64Array<ArrayBuffer> = new Float64Array(0);

function tooQuiet(buffer: Float32Array): boolean {
  let peak = 0;
  for (let i = 0; i < buffer.length; i += 4) {
    const a = Math.abs(buffer[i]!);
    if (a > peak) peak = a;
  }
  return peak < SILENCE_FLOOR;
}

function decimate(
  buffer: Float32Array,
  sampleRate: number,
): { data: Float32Array<ArrayBuffer>; sampleRate: number } | null {
  const out = Math.floor(buffer.length / DECIMATION);
  if (out < 128) return null;
  if (scratchWindow.length < out) scratchWindow = new Float32Array(out);
  const data = scratchWindow;
  for (let i = 0; i < out; i++) {
    const j = i * DECIMATION;
    data[i] = (buffer[j]! + buffer[j + 1]!) * 0.5;
  }
  return { data, sampleRate: sampleRate / DECIMATION };
}

/** Shared tail: reject estimates outside the vocal range or non-finite. */
function finalize(hz: number): number | null {
  if (!Number.isFinite(hz) || hz < MIN_HZ || hz > MAX_HZ) return null;
  return hz;
}

// Running cumulative sum for the normalised difference function. Held outside
// the signature to keep the O(n) inner loop free of allocation.
let yinRunning = 0;

/**
 * Squared-difference at `tau`, added to the running total, returned as the
 * cumulative-mean-normalised value. Returns +Infinity when the window holds no
 * energy, so a silent window never registers a dip.
 */
function yinCumulative(
  buffer: Float32Array,
  half: number,
  tau: number,
): number {
  let sum = 0;
  for (let i = 0; i < half; i++) {
    const delta = buffer[i]! - buffer[i + tau]!;
    sum += delta * delta;
  }
  yinRunning += sum;
  if (yinRunning <= 0) return Number.POSITIVE_INFINITY;
  return (sum * tau) / yinRunning;
}

function yinOn(
  buffer: Float32Array,
  sampleRate: number,
  threshold: number,
): number | null {
  const half = Math.floor(buffer.length / 2);
  if (half < 32) return null;
  yinRunning = 0;

  // The first dip below the absolute threshold is the period, so the scan
  // stops there rather than walking the whole window: for a 150 Hz voice that
  // is roughly a third of the lags, and it is the dominant cost.
  let prev = 0;
  let cur = 0;
  let tau = -1;
  for (let t = 1; t < half; t++) {
    const value = yinCumulative(buffer, half, t);
    prev = cur;
    cur = value;
    if (t >= 2 && value < threshold) {
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;

  // Descend to the bottom of the dip: the first sample under the threshold is
  // rarely the minimum, and the interpolation below needs the true minimum.
  let next = cur;
  while (tau + 1 < half) {
    next = yinCumulative(buffer, half, tau + 1);
    if (!(next < cur)) break;
    prev = cur;
    cur = next;
    tau++;
  }
  if (tau < 1) return null;

  const denom = 2 * cur - next - prev;
  const betterTau = denom === 0 ? tau : tau + (next - prev) / (2 * denom);
  return finalize(sampleRate / betterTau);
}

function mcmOn(buffer: Float32Array, sampleRate: number): number | null {
  const half = Math.floor(buffer.length / 2);
  if (half < 64) return null;

  const minTau = Math.max(2, Math.floor(sampleRate / MAX_HZ));
  const maxTau = Math.min(half, Math.ceil(sampleRate / MIN_HZ));
  if (maxTau <= minTau) return null;
  if (scratchNsdf.length < half) scratchNsdf = new Float32Array(half);
  const nsdf = scratchNsdf;

  // Prefix sums of squares. The NSDF denominator only needs sum(b[i]^2), which
  // is the same for every lag, plus the shifted window sum — so it comes from
  // the table instead of being recomputed inside the O(n^2) loop.
  const span = 2 * half;
  if (scratchPower.length < span) scratchPower = new Float64Array(span);
  const power = scratchPower;
  power[0] = 0;
  for (let i = 0; i < span - 1; i++) {
    const v = buffer[i] ?? 0;
    power[i + 1] = power[i]! + v * v;
  }
  const selfEnergy = power[half]!;

  for (let tau = 0; tau < half; tau++) {
    let acf = 0;
    for (let i = 0; i < half; i++) acf += buffer[i]! * buffer[i + tau]!;
    const energy = selfEnergy + (power[half + tau]! - power[tau]!);
    if (energy > 0) nsdf[tau] = (2 * acf) / energy;
  }

  // Skip the initial lobe so a peak is not taken from the main autocorrelation
  // bump: walk down the first slope, then across the first negative run.
  let tau = minTau;
  while (tau < maxTau - 1 && nsdf[tau]! > 0 && nsdf[tau + 1]! < nsdf[tau]!) {
    tau++;
  }
  while (tau < maxTau - 1 && nsdf[tau]! < 0 && nsdf[tau + 1]! > nsdf[tau]!) {
    tau++;
  }

  const isPeak = (i: number) =>
    i > 0 && nsdf[i]! > nsdf[i - 1]! && nsdf[i]! >= nsdf[i + 1]!;

  // Pick the *earliest* peak that is close to the strongest one. Taking the
  // global maximum is what makes MCM report the sub-harmonic: on a harmonic
  // voice the peaks at 2T and 3T are often marginally higher than the one at T,
  // which lands the estimate a full octave low.
  let strongest = 0;
  for (let i = tau; i < maxTau - 1; i++) {
    if (isPeak(i) && nsdf[i]! > strongest) strongest = nsdf[i]!;
  }
  if (strongest < MCM_MIN_CORRELATION) return null;
  const cutoff = strongest * MCM_PEAK_RATIO;

  let peak = -1;
  for (let i = tau; i < maxTau - 1; i++) {
    if (isPeak(i) && nsdf[i]! >= cutoff) {
      peak = i;
      break;
    }
  }
  if (peak < 0) return null;

  const x0 = Math.max(peak - 1, minTau);
  const x2 = Math.min(peak + 1, maxTau - 1);
  const s0 = nsdf[x0]!;
  const s1 = nsdf[peak]!;
  const s2 = nsdf[x2]!;
  const denom = 2 * s1 - s2 - s0;
  const betterTau = denom === 0 ? peak : peak + (s2 - s0) / (2 * denom);

  return finalize(sampleRate / betterTau);
}

export function detectPitchYin(
  buffer: Float32Array,
  sampleRate: number,
  threshold = 0.15,
): number | null {
  if (tooQuiet(buffer)) return null;
  const view = decimate(buffer, sampleRate);
  if (!view) return null;
  return yinOn(view.data, view.sampleRate, threshold);
}

export function detectPitchMcm(
  buffer: Float32Array,
  sampleRate: number,
): number | null {
  if (tooQuiet(buffer)) return null;
  const view = decimate(buffer, sampleRate);
  if (!view) return null;
  return mcmOn(view.data, view.sampleRate);
}

export function detectPitch(
  buffer: Float32Array,
  sampleRate: number,
  method: PitchMethod = "auto",
): number | null {
  if (method === "yin") return detectPitchYin(buffer, sampleRate);
  if (method === "mcm") return detectPitchMcm(buffer, sampleRate);
  return (
    detectPitchYin(buffer, sampleRate, 0.15) ?? detectPitchMcm(buffer, sampleRate)
  );
}

export function rms(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const s = buffer[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / buffer.length);
}

export function rmsToDb(value: number): number {
  if (value <= 0.0000001) return -96;
  return 20 * Math.log10(value);
}
