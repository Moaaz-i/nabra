/*
 * Offline validation of the phase vocoder in src/audio/pitchWorklet.cjs.
 *
 * Two levels:
 *   1. the PhaseVocoder class directly (analysis/OLA/resampler), and
 *   2. the AudioWorklet processor, by shimming the worklet global scope, so
 *      the real streaming path is exercised the way the browser runs it.
 *
 * The fractional ratios matter most: an earlier twiddle-sign error in `fft`
 * only showed up for non-integer stretch factors, which is every musically
 * useful pitch shift, and the first version of this file only tested 0.5/1/2
 * -- exactly the ratios that hide it.
 */

const path = require("node:path");
const SR = 48000;
const QUANTUM = 128;
const WORKLET = path.join(__dirname, "..", "src", "audio", "pitchWorklet.cjs");

// The worklet registers itself at require time, so the globals must exist first.
globalThis.sampleRate = SR;
globalThis.AudioWorkletGlobalScope = function AudioWorkletGlobalScope() {};
globalThis.AudioWorkletProcessor = class AudioWorkletProcessor {
  constructor() {
    this.port = { postMessage() {}, onmessage: null, start() {}, close() {} };
  }
};
let registered = null;
globalThis.registerProcessor = (name, cls) => {
  registered = { name, cls };
};

const { PhaseVocoder, fft } = require(WORKLET);

let failed = 0;
let passed = 0;

function check(label, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
}

const TAU = Math.PI * 2;

function sine(freq, amp, dur) {
  const out = new Float32Array(Math.round(SR * dur));
  for (let i = 0; i < out.length; i++) {
    out[i] = amp * Math.sin((TAU * freq * i) / SR);
  }
  return out;
}

/* ------------------------------------------------------------------ FFT -- */

// A direct O(N^2) DFT, used as the reference for the sign convention.
function referenceDft(x, k) {
  let re = 0;
  let im = 0;
  for (let n = 0; n < x.length; n++) {
    re += x[n] * Math.cos((-TAU * k * n) / x.length);
    im += x[n] * Math.sin((-TAU * k * n) / x.length);
  }
  return { re, im };
}

function fftConvention() {
  console.log("\n=== FFT sign convention ===");
  const n = 64;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = 0.6 * Math.sin((TAU * 5 * i) / n) + 0.3 * Math.cos((TAU * 11 * i) / n) - 0.2 * i / n;
  }
  const re = Float32Array.from(x);
  const im = new Float32Array(n);
  fft(re, im, false);

  let worst = 0;
  for (let k = 0; k < n; k++) {
    const ref = referenceDft(x, k);
    worst = Math.max(worst, Math.abs(re[k] - ref.re), Math.abs(im[k] - ref.im));
  }
  // The forward transform must be sum x[n] * e^(-2*pi*i*k*n/N) exactly; the
  // vocoder's phase advance is only valid in this convention.
  check("forward matches the e^(-) reference DFT", worst < 1e-3, `max err ${worst.toExponential(2)}`);

  // Round trip.
  const back = Float32Array.from(re);
  const backIm = Float32Array.from(im);
  fft(back, backIm, true);
  let rt = 0;
  for (let i = 0; i < n; i++) rt = Math.max(rt, Math.abs(back[i] - x[i]), Math.abs(backIm[i]));
  check("inverse undoes the forward", rt < 1e-4, `max err ${rt.toExponential(2)}`);
}

/* -------------------------------------------------- PhaseVocoder, offline -- */

// Zero-crossing pitch estimate of a pulled stream.
function pitchShiftFreq(input, ratio, fftSize, hop) {
  const voc = new PhaseVocoder({ sampleRate: SR, fftSize, hop, ratio });
  for (let i = 0; i < input.length; i += 512) {
    voc.pushSamples(input.subarray(i, Math.min(i + 512, input.length)));
  }
  const collected = [];
  let v;
  while ((v = voc.pullNextResampled(ratio)) !== null) collected.push(v);
  // Skip the warm-up window (one FFT length) to avoid the edge ramp.
  const start = Math.floor(SR * 0.25);
  let crossings = 0;
  let crossingsLen = 0;
  for (let i = start + 1; i < collected.length; i++) {
    crossingsLen++;
    const a = collected[i - 1];
    const b = collected[i];
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) crossings++;
  }
  if (crossings < 4 || crossingsLen === 0) return { hz: NaN, rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = start; i < collected.length; i++) {
    sum += collected[i] * collected[i];
    peak = Math.max(peak, Math.abs(collected[i]));
  }
  return {
    hz: (crossings / (2 * crossingsLen)) * SR,
    rms: Math.sqrt(sum / (collected.length - start)),
    peak,
  };
}

const CONFIGS = [
  { fftSize: 2048, hop: 256, label: "low-latency" },
  { fftSize: 4096, hop: 512, label: "standard" },
];

// A semitone, a whole tone, a fifth up and down: the ratios a voice changer
// actually spends its time at. The integer ones are the control group.
const RATIOS = [
  { r: 0.5, label: "octave down" },
  { r: 0.75, label: "fifth down" },
  { r: 0.943874, label: "semitone down" },
  { r: 1, label: "unity" },
  { r: 1.059463, label: "semitone up" },
  { r: 1.122462, label: "tone up" },
  { r: 1.334840, label: "fifth up" },
  { r: 1.5, label: "fifth up (3:2)" },
  { r: 2, label: "octave up" },
  { r: 2.5, label: "major third x2" },
];

function vocoderAccuracy() {
  for (const cfg of CONFIGS) {
    console.log(`\n=== PhaseVocoder ${cfg.fftSize}/${cfg.hop} (${cfg.label}) ===`);
    for (const c of RATIOS) {
      const got = pitchShiftFreq(sine(300, 0.5, 1.6), c.r, cfg.fftSize, cfg.hop);
      const want = 300 * c.r;
      const cents = 1200 * Math.log2(got.hz / want);
      check(
        `300Hz x${c.r.toFixed(6)} (${c.label})`,
        Math.abs(cents) < 60 && got.rms > 0.25 && got.peak < 0.62,
        `got ${isFinite(got.hz) ? got.hz.toFixed(1) : "NaN"}Hz want ${want.toFixed(1)}Hz ` +
          `(${cents >= 0 ? "+" : ""}${isFinite(cents) ? cents.toFixed(1) : "?"}c) rms ${got.rms.toFixed(3)} peak ${got.peak.toFixed(3)}`,
      );
    }
  }
}

/* ------------------------------------------- the AudioWorklet, streaming -- */

function makeProcessor(fftSize, hop) {
  if (!registered) throw new Error("worklet did not register");
  return new registered.cls({ processorOptions: { fftSize, hop } });
}

function runStream(proc, sig, ratioAt) {
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i += QUANTUM) {
    const inQ = sig.subarray(i, i + QUANTUM);
    const outQ = new Float32Array(QUANTUM);
    proc.process([[inQ]], [[outQ]], { ratio: new Float32Array([ratioAt(i / SR)]) });
    out.set(outQ.subarray(0, inQ.length), i);
  }
  return out;
}

/** Zero-crossing frequency estimate over [from, to), in hertz. */
function freqBetween(out, from, to) {
  let crossings = 0;
  for (let i = Math.max(1, from); i < to; i++) {
    if ((out[i] < 0) !== (out[i - 1] < 0)) crossings++;
  }
  const len = to - from;
  return len > 1 ? (crossings / (2 * len)) * SR : 0;
}

function streamStats(out, fromS) {
  const from = Math.round(fromS * SR);
  let maxJump = 0;
  let dropouts = 0;
  let nan = 0;
  let sum = 0;
  let peak = 0;
  for (let i = from; i < out.length; i++) {
    if (Number.isNaN(out[i])) nan++;
    sum += out[i] * out[i];
    peak = Math.max(peak, Math.abs(out[i]));
    if (i > from) {
      const d = Math.abs(out[i] - out[i - 1]);
      if (d > maxJump) maxJump = d;
    }
    // A dropout is a hard zero where the signal should be oscillating.
    if (i > from && out[i] === 0 && out[i - 1] !== 0) dropouts++;
  }
  const len = out.length - from;
  return { maxJump, dropouts, nan, peak, hz: freqBetween(out, from, out.length), rms: Math.sqrt(sum / len) };
}

/**
 * Milliseconds after `fromS` until the output is within `tolCents` of `wantHz`.
 * Scanned in 50 ms windows every 20 ms; the window is what sets the resolution,
 * so a reported 20 ms means "by the second window".
 */
function settleMs(out, fromS, wantHz, tolCents = 40) {
  for (let t = fromS; t < fromS + 0.9; t += 0.02) {
    const a = Math.round(t * SR);
    const b = Math.round((t + 0.05) * SR);
    if (b > out.length) break;
    if (Math.abs(1200 * Math.log2(freqBetween(out, a, b) / wantHz)) < tolCents) {
      return (t - fromS) * 1000;
    }
  }
  return Infinity;
}

function workletStreaming() {
  console.log("\n=== AudioWorklet processor (streaming, 2048/256) ===");
  check("processor registered under the expected name", registered && registered.name === "nabra-pitch-shift", registered && registered.name);

  const sig = sine(300, 0.5, 2.0);

  // Bypass must be bit exact: at unity the knob is off, not a resampled copy.
  const unity = runStream(makeProcessor(2048, 256), sig, () => 1);
  let unityDiff = 0;
  for (let i = 0; i < sig.length; i++) unityDiff = Math.max(unityDiff, Math.abs(unity[i] - sig[i]));
  check("unity ratio is a bit-exact passthrough", unityDiff === 0, `max diff ${unityDiff}`);

  for (const c of RATIOS) {
    const s = streamStats(runStream(makeProcessor(2048, 256), sig, () => c.r), 1.3);
    const want = 300 * c.r;
    const cents = 1200 * Math.log2(s.hz / want);
    check(
      `settles on 300Hz x${c.r.toFixed(6)}`,
      Math.abs(cents) < 60 && s.rms > 0.25 && s.nan === 0 && s.dropouts === 0,
      `${s.hz.toFixed(1)}Hz (${cents >= 0 ? "+" : ""}${cents.toFixed(1)}c) rms ${s.rms.toFixed(3)} ` +
        `jumps ${s.maxJump.toFixed(3)} dropouts ${s.dropouts} NaN ${s.nan}`,
    );
  }

  // Knob sweeps: the ratio changes under the processor while audio flows. The
  // resampler FIFO must not starve and the output must not blow up.
  // A ratio change briefly leaves frames computed with two different stretch
  // factors in the same overlap-add; easing the factor back to unity in step
  // with the crossfade holds that to +1.2 dB, and a stale factor on release
  // used to push it to +2.4 dB. Anything near +6 dB is a defect.
  const sweepRatios = [1, 1.5, 1, 0.75, 1, 2, 1];
  const sweep = runStream(makeProcessor(2048, 256), sine(300, 0.5, 2.6), (t) => {
    if (t >= 2.25) return sweepRatios[sweepRatios.length - 1];
    return sweepRatios[Math.min(sweepRatios.length - 2, Math.floor(t / 0.35))];
  });
  const s = streamStats(sweep, 0);
  check(
    "ratio sweep stays continuous",
    s.nan === 0 && s.dropouts === 0 && s.maxJump < 0.45 && s.peak < 0.62,
    `max jump ${s.maxJump.toFixed(3)} dropouts ${s.dropouts} NaN ${s.nan} peak ${s.peak.toFixed(3)} (+${(20 * Math.log10(s.peak / 0.5)).toFixed(1)}dB)`,
  );
  // Settles back to the dry signal once the ratio is unity again.
  const tail = streamStats(sweep, 2.35);
  check("sweep returns to unity cleanly", Math.abs(tail.hz - 300) / 300 < 0.05 && tail.rms > 0.25, `${tail.hz.toFixed(1)}Hz rms ${tail.rms.toFixed(3)}`);

  // Release-and-re-engage: push a big offset, return the knob to unison, then
  // ask for a small one. The stretch factor has to come back to unity with the
  // crossfade. Parked at the old value instead, the vocoder restarts from a
  // +12-semitone stretch and takes 140 ms to reach +1, i.e. the voice is at
  // the wrong pitch long after the knob says otherwise.
  const reengage = runStream(
    makeProcessor(2048, 256),
    sine(300, 0.5, 3.0),
    (t) => (t < 1.0 ? 2 : t < 1.8 ? 1 : 1.06),
  );
  const reengageMs = settleMs(reengage, 1.8, 300 * 1.06);
  check(
    "re-engaging after a release reaches the new offset promptly",
    reengageMs < 60,
    `${reengageMs} ms (was 140 ms with a stale stretch factor)`,
  );
  const after = streamStats(reengage, 2.2);
  check(
    "re-engage tail is clean",
    after.nan === 0 && after.dropouts === 0 && after.maxJump < 0.45,
    `dropouts ${after.dropouts} NaN ${after.nan} max jump ${after.maxJump.toFixed(3)}`,
  );

  // With the knob back at unity the processor must return to the bit-exact
  // passthrough rather than keep re-deriving a resampled copy forever.
  const settled = runStream(makeProcessor(2048, 256), sig, (t) => (t < 1.0 ? 2 : 1));
  let tailDiff = 0;
  for (let i = Math.round(1.6 * SR); i < settled.length; i++) {
    tailDiff = Math.max(tailDiff, Math.abs(settled[i] - sig[i]));
  }
  check("returns to a bit-exact passthrough at unity", tailDiff === 0, `max diff ${tailDiff}`);
}

fftConvention();
vocoderAccuracy();
workletStreaming();

console.log(`\n${failed === 0 ? "ALL TESTS PASSED" : `${failed} TEST(S) FAILED`}  (${passed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
