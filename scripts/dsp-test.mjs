/**
 * Offline checks for the pure DSP/utility layer: pitch detection accuracy and
 * cost, scale snapping, settings sanitising and virtual-device detection.
 *
 * Run with: npm test
 */
import { performance } from "node:perf_hooks";
import { detectPitch, detectPitchMcm, detectPitchYin, rms } from "../src/audio/yin.ts";
import { hzToMidi, midiToHz, midiToName, snapMidi } from "../src/audio/notes.ts";
import { isVirtualDevice } from "../src/audio/devices.ts";
import {
  fillImpulse,
  impulseEdges,
  IMPULSE_DECAY_POWER,
} from "../src/audio/impulse.ts";
import { defaultSettings, sanitizeSettings } from "../src/audio/settings.ts";
import {
  DETECT_EMA,
  MAX_ADAPTIVE_SEMITONES,
  newOffsetTracker,
  referenceMidi,
  smoothDetection,
  stepOffset,
} from "../src/audio/offset.ts";

let failures = 0;
let checks = 0;

function check(name, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    console.log(`  ok    ${name}${detail ? `  (${detail})` : ""}`);
  }
}

/** Matches `analyserIn.fftSize`, the window the engine actually analyses. */
const WINDOW = 2048;
const SR = 48000;

function voice(freq, sampleRate, seconds = WINDOW / sampleRate, harmonics = 6, noise = 0.004) {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin((2 * Math.PI * freq * h * i) / sampleRate) / h;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = v * 0.25 + (seed / 0x7fffffff - 0.5) * 2 * noise;
  }
  return out;
}

// --------------------------------------------------------------------------
console.log("\npitch detection accuracy (48 kHz, 2048-sample window)");
for (const hz of [80, 120, 200, 440, 1000]) {
  const buf = voice(hz, SR);
  for (const [label, fn] of [
    ["yin", detectPitchYin],
    ["mcm", detectPitchMcm],
  ]) {
    const got = fn(buf, SR);
    const cents = got == null ? NaN : 1200 * Math.log2(got / hz);
    check(
      `${label} ${hz} Hz`,
      got != null && Math.abs(cents) < 50,
      got == null ? "no detection" : `${got.toFixed(1)} Hz (${cents.toFixed(1)}¢)`,
    );
  }
}

{
  // MCM used to take the global NSDF maximum. On a harmonic voice the peaks at
  // 2T and 3T are often marginally higher than the one at T, so it reported the
  // note an octave (or an octave and a fifth) low.
  for (const hz of [98, 147, 220, 392]) {
    const got = detectPitchMcm(voice(hz, SR), SR);
    const octaves = got == null ? NaN : Math.log2(got / hz);
    check(
      `mcm ${hz} Hz is not a sub-harmonic`,
      got != null && Math.abs(octaves) < 0.08,
      got == null ? "no detection" : `${got.toFixed(1)} Hz (${octaves.toFixed(2)} oct)`,
    );
  }
}

{
  const silence = new Float32Array(WINDOW);
  check("silence yields no pitch", detectPitch(silence, SR) === null);
  // ~-80 dBFS: below the detector's silence floor, so it must bail out early.
  const quiet = voice(220, SR, WINDOW / SR, 6, 0);
  for (let i = 0; i < quiet.length; i++) quiet[i] *= 0.00005;
  check("near-silent input yields no pitch", detectPitch(quiet, SR) === null);
}

// --------------------------------------------------------------------------
console.log("\npitch detection cost (relative, so a busy machine cannot skew it)");
{
  // Calibrate against a loop of known length in this same process, so the
  // budget is "inner iterations relative to a reference" rather than a
  // wall-clock number that a loaded CPU would invalidate.
  const REF = 262144;
  const refBuf = new Float32Array(1024);
  for (let i = 0; i < refBuf.length; i++) refBuf[i] = Math.sin(i * 0.01);
  const refSink = new Float64Array(1024);
  function reference() {
    let acc = 0;
    for (let tau = 1; tau < 512; tau++) {
      let sum = 0;
      for (let i = 0; i < 512; i++) {
        const d = refBuf[i] - refBuf[i + tau];
        sum += d * d;
      }
      acc += sum;
      refSink[tau] = acc;
    }
    return acc;
  }
  const best = (fn, iters = 60, trials = 5) => {
    for (let i = 0; i < 15; i++) fn();
    let min = Infinity;
    for (let t = 0; t < trials; t++) {
      const s = performance.now();
      for (let i = 0; i < iters; i++) fn();
      const per = (performance.now() - s) / iters;
      if (per < min) min = per;
    }
    return min;
  };

  const noisy = new Float32Array(WINDOW);
  for (let i = 0; i < WINDOW; i++) noisy[i] = (Math.random() * 2 - 1) * 0.1;
  const voiced = voice(150, SR);

  const refMs = best(reference, 25);
  const yinMs = best(() => detectPitchYin(voiced, SR));
  const autoMs = best(() => detectPitch(noisy, SR));
  const units = (Math.max(yinMs, autoMs) / refMs) * REF;

  // One full-window difference pass is REF. The worst case is "auto" on an
  // unvoiced window: YIN scans every lag (no dip found) and MCM then walks the
  // whole window. Before these fixes this ratio measured around 40x.
  check(
    "worst-case detection stays within its op budget",
    units < REF * 10,
    `${(units / 1000).toFixed(0)}k inner iterations vs ${REF / 1000}k reference ` +
      `(yin ${yinMs.toFixed(3)} ms, auto-on-noise ${autoMs.toFixed(3)} ms, ref ${refMs.toFixed(3)} ms)`,
  );
}

// --------------------------------------------------------------------------
console.log("\nscale snapping (nearest scale degree, ties resolve upwards)");
{
  let down = 0;
  let up = 0;
  for (let m = 36; m <= 84; m++) {
    const snapped = snapMidi(m, "major", 0);
    if (snapped < m) down++;
    if (snapped > m) up++;
    // Every semitone of a 7-note scale is within one degree of the scale.
    if (Math.abs(snapped - m) > 1) {
      check(`major snap of ${m} moves at most a semitone`, false, `-> ${snapped}`);
    }
    const isInScale = [0, 2, 4, 5, 7, 9, 11].includes((((snapped % 12) + 12) % 12));
    if (!isInScale) check(`major snap of ${m} lands in scale`, false, `-> ${snapped}`);
  }
  check("major scale snaps to nearest (ties up)", Math.abs(down - up) <= up && up >= 1, `down=${down} up=${up}`);
  check("in-scale notes are untouched", snapMidi(64, "major", 0) === 64);
  check("out-of-scale note equidistant resolves up", snapMidi(61, "major", 0) === 62, `-> ${snapMidi(61, "major", 0)}`);
  check("closer lower degree wins", snapMidi(62.6, "major", 0) === 62, `-> ${snapMidi(62.6, "major", 0)}`);
  check("closer upper degree wins", snapMidi(60.4, "major", 0) === 60, `-> ${snapMidi(60.4, "major", 0)}`);
  check("chromatic rounds", snapMidi(61.4, "chromatic", 0) === 61);
  check("chromatic handles negatives", snapMidi(-0.6, "chromatic", 0) === -1);
  check("root offset honoured", snapMidi(61, "major", 1) === 61, `-> ${snapMidi(61, "major", 1)}`);
  check("root offset shifts the scale", snapMidi(62, "major", 1) === 63, `-> ${snapMidi(62, "major", 1)}`);
  check("minor keeps its own degrees", snapMidi(70, "minor", 0) === 70, `-> ${snapMidi(70, "minor", 0)}`);
  check("minor does not use the major degree", snapMidi(71, "minor", 0) === 72, `-> ${snapMidi(71, "minor", 0)}`);
  check("non-finite input is contained", snapMidi(Number.NaN, "major", 0) === 0);
  check("snapping is idempotent", [36, 49, 61, 64, 73, 84].every((m) => snapMidi(snapMidi(m, "minor", 3), "minor", 3) === snapMidi(m, "minor", 3)));
}

// --------------------------------------------------------------------------
console.log("\nnote helpers");
{
  check("midiToName(C4)", midiToName(60) === "C4", midiToName(60));
  check("midiToName(A4) is 440 Hz", Math.abs(midiToHz(69) - 440) < 1e-9);
  check("hzToMidi round-trips", Math.abs(hzToMidi(midiToHz(57)) - 57) < 1e-9);
  check("rms of silence is zero", rms(new Float32Array(512)) === 0);
}

// --------------------------------------------------------------------------
console.log("\noffset pipeline (what the meters report vs. what the audio does)");
{
  const base = defaultSettings();
  const knobs = (over) => ({ ...base, ...over });
  /** Steps a tracker until it has settled, then returns the last report. */
  const settle = (k, hz, frames = 400) => {
    const t = newOffsetTracker();
    let r;
    for (let i = 0; i < frames; i++) r = stepOffset(t, k, hz);
    return { t, r };
  };

  // The reported offset and the reported ratio have to describe the same
  // number, because that is what the pitch stage is actually fed.
  let inconsistent = 0;
  for (const mode of ["manual", "adaptive"]) {
    for (const semitones of [-12, -5, -1, 0, 1, 3.7, 7, 12]) {
      for (const hz of [82, 147, 220, 440, 1000]) {
        const k = knobs({ mode, manualSemitones: semitones });
        const t = newOffsetTracker();
        for (let i = 0; i < 60; i++) {
          const r = stepOffset(t, k, hz);
          if (Math.abs(r.ratio - 2 ** (r.appliedSemitones / 12)) > 1e-9) {
            inconsistent++;
          }
        }
      }
    }
  }
  check(
    "reported ratio is always 2 ** (applied offset / 12)",
    inconsistent === 0,
    `${inconsistent} disagreeing frames`,
  );

  // Regression: in manual mode the ratio and the tuner used to be computed
  // from the adaptive target note (C4 by default) instead of from the offset
  // actually applied, so a singer a whole tone below C4 was told "1.189x,
  // +300 cents" while the pitch stage sat at unity.
  {
    const { r } = settle(knobs({ mode: "manual", manualSemitones: 0 }), 220);
    check(
      "manual mode at 0 offset reports unity, whatever is detected",
      Math.abs(r.ratio - 1) < 1e-9 && Math.abs(r.appliedSemitones) < 1e-9,
      `ratio ${r.ratio.toFixed(3)}, offset ${r.appliedSemitones.toFixed(2)} st`,
    );
    check(
      "manual mode ignores the leftover adaptive target note",
      r.referenceNote === "A3",
      `reference ${r.referenceNote}`,
    );
  }
  {
    const { r } = settle(knobs({ mode: "manual", manualSemitones: 5 }), 220);
    check(
      "manual +5 st reports a 5-semitone shift",
      Math.abs(r.appliedSemitones - 5) < 0.01 && Math.abs(r.ratio - 1.3348) < 0.001,
      `${r.appliedSemitones.toFixed(2)} st, ${r.ratio.toFixed(3)}x`,
    );
  }
  {
    const { r } = settle(knobs({ mode: "manual", manualSemitones: -7 }), 300);
    check(
      "manual -7 st reports a 7-semitone shift down",
      Math.abs(r.appliedSemitones + 7) < 0.01 && Math.abs(r.ratio - 0.6674) < 0.001,
      `${r.appliedSemitones.toFixed(2)} st, ${r.ratio.toFixed(3)}x`,
    );
  }

  // The tuner has no target in manual mode, so it must measure against the
  // nearest semitone -- a real chromatic tuner -- and stay inside its +/-50
  // cent travel for any input.
  let worstCents = 0;
  for (let m = 30; m <= 90; m++) {
    const { r } = settle(
      knobs({ mode: "manual", manualSemitones: 0 }),
      midiToHz(m + 0.4),
    );
    worstCents = Math.max(worstCents, Math.abs(r.cents));
  }
  check(
    "manual tuner never leaves its +/-50 cent travel",
    worstCents <= 50.001,
    `worst ${worstCents.toFixed(1)} cents`,
  );
  {
    const { r } = settle(knobs({ mode: "manual" }), 220);
    check("manual tuner reads 0 on an exact semitone", Math.abs(r.cents) < 1, `${r.cents.toFixed(1)} cents`);
    const sharp = settle(knobs({ mode: "manual" }), midiToHz(69.2));
    check(
      "manual tuner sign: sharp is positive",
      Math.abs(sharp.r.cents - 20) < 0.5,
      `${sharp.r.cents.toFixed(1)} cents`,
    );
  }

  // Adaptive mode: reference is the chosen target, and the applied offset is
  // the correction that gets the voice there.
  {
    const { r } = settle(
      knobs({ mode: "adaptive", scale: "chromatic", targetMidi: 60 }),
      220,
    );
    check(
      "adaptive chromatic settles on the target note",
      r.referenceNote === "C4" && Math.abs(r.appliedSemitones - 3) < 0.02,
      `${r.referenceNote}, ${r.appliedSemitones.toFixed(2)} st`,
    );
    check(
      "adaptive tuner shows the singer's own deviation, not the correction",
      Math.abs(r.cents + 300) < 2,
      `${r.cents.toFixed(0)} cents (the voice is 300 flat, the fix is +300 up)`,
    );
  }
  {
    const { r } = settle(
      knobs({ mode: "adaptive", scale: "major", rootPc: 0 }),
      220, // A3 -> snaps to A3, so no movement
    );
    check(
      "adaptive major holds an in-scale note where it is",
      r.referenceNote === "A3" && Math.abs(r.appliedSemitones) < 0.02,
      `${r.referenceNote}, ${r.appliedSemitones.toFixed(2)} st`,
    );
  }
  {
    // F#4 is the one pitch C minor does not contain; it sits exactly between
    // F and G, and the tie resolves upwards.
    const { r } = settle(
      knobs({ mode: "adaptive", scale: "minor", rootPc: 0 }),
      midiToHz(66),
    );
    check(
      "adaptive minor pulls an out-of-scale note into the scale",
      r.referenceNote === "G4" && Math.abs(r.appliedSemitones - 1) < 0.02,
      `${r.referenceNote}, ${r.appliedSemitones.toFixed(2)} st`,
    );
  }
  {
    // Beyond the adaptive range the offset saturates instead of asking for a
    // shift that would fold the voice over.
    const up = settle(
      knobs({ mode: "adaptive", scale: "chromatic", targetMidi: 96 }),
      60,
    );
    const down = settle(
      knobs({ mode: "adaptive", scale: "chromatic", targetMidi: 24 }),
      1000,
    );
    check(
      "adaptive offset saturates at the limit, both directions",
      Math.abs(up.r.appliedSemitones - MAX_ADAPTIVE_SEMITONES) < 0.01 &&
        Math.abs(down.r.appliedSemitones + MAX_ADAPTIVE_SEMITONES) < 0.01,
      `+${up.r.appliedSemitones.toFixed(2)} / ${down.r.appliedSemitones.toFixed(2)} st`,
    );
  }

  // Silence: no reference, no offset movement, and the last offset is held
  // rather than yanked back to unison mid-phrase.
  {
    const k = knobs({ mode: "adaptive", scale: "chromatic", targetMidi: 60 });
    const t = newOffsetTracker();
    let r;
    for (let i = 0; i < 400; i++) r = stepOffset(t, k, 220);
    const held = r.appliedSemitones;
    t.smoothMidi = null;
    r = stepOffset(t, k, null);
    check("silence clears the detection", r.detectedHz === null);
    check(
      "silence holds the last offset",
      Math.abs(r.appliedSemitones - held) < 0.01,
      `${held.toFixed(2)} -> ${r.appliedSemitones.toFixed(2)} st`,
    );
    check("silence reports no tuner deviation", r.cents === 0);
  }

  // The follower runs in the log-frequency domain, so its lag is a fixed
  // number of cents at every pitch. On raw hertz the same weights left a low
  // male voice about five times further behind than a high female one.
  {
    // Error still outstanding one frame after a 12-semitone jump.
    const errorAfterOneFrame = (hz) => {
      const before = smoothDetection(null, hz);
      const after = smoothDetection(before, hz * 2);
      return 12 - (after - before);
    };
    const low = errorAfterOneFrame(100);
    const high = errorAfterOneFrame(1000);
    check(
      "detection lag is scale invariant",
      Math.abs(low - high) < 0.02,
      `${low.toFixed(3)} st of error left at 100 Hz vs ${high.toFixed(3)} st at 1 kHz`,
    );
    // One frame consumes the 1 - DETECT_EMA = 0.26 tail of the jump, so 74% of
    // a 12-semitone octave error is still outstanding: octave glitches are
    // damped exactly as much as a filter on raw hertz damped them.
    check(
      "octave errors are damped by the documented tail",
      Math.abs(low - 12 * DETECT_EMA) < 0.02,
      `${low.toFixed(3)} st left vs ${(12 * DETECT_EMA).toFixed(3)} st expected`,
    );
    check(
      "a dropped frame keeps the previous estimate",
      smoothDetection(60, null) === 60 && smoothDetection(60, Number.NaN) === 60 && smoothDetection(60, -1) === 60,
    );
  }

  // Whatever happens, the offset stays inside what the pitch stage accepts.
  {
    let worst = 0;
    for (const mode of ["manual", "adaptive"]) {
      for (const semitones of [-24, -12, 0, 12, 24]) {
        for (const hz of [45, 82, 220, 1500]) {
          const t = newOffsetTracker();
          for (let i = 0; i < 200; i++) {
            worst = Math.max(worst, Math.abs(stepOffset(t, knobs({ mode, manualSemitones: semitones }), hz).appliedSemitones));
          }
        }
      }
    }
    check("applied offset never leaves +/-24 semitones", worst <= 24.0001, `worst ${worst.toFixed(2)} st`);
  }

  // referenceMidi is what the tuner label reads, so it must be null in manual
  // silence rather than a stale note.
  check(
    "manual silence has no reference note",
    referenceMidi(knobs({ mode: "manual" }), null) === null,
  );
  check(
    "adaptive silence still names its target",
    referenceMidi(knobs({ mode: "adaptive", targetMidi: 64 }), null) === 64,
  );
}

// --------------------------------------------------------------------------
console.log("\nreverb impulse (shape and main-thread cost)");
{
  const make = (seconds) => {
    const length = Math.floor(SR * seconds);
    const { attack, release } = impulseEdges(SR);
    const left = new Float32Array(length);
    const seed = fillImpulse(left, 0x2f6e2b1, attack, release);
    const right = new Float32Array(length);
    fillImpulse(right, seed, attack, release);
    return { left, right, length, attack, release };
  };

  // Both ends must be exactly silent. A non-zero first or last sample is a
  // step discontinuity, i.e. a click on every reverb tail.
  let endsOk = true;
  let peak = 0;
  let mean = 0;
  let positive = 0;
  let negative = 0;
  for (const seconds of [0.2, 1.4, 4]) {
    const { left, right, length } = make(seconds);
    for (const ch of [left, right]) {
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i];
        peak = Math.max(peak, Math.abs(v));
        if (v > 0) positive++;
        else if (v < 0) negative++;
      }
      if (ch[0] !== 0 || ch[length - 1] !== 0) endsOk = false;
    }
    let sum = 0;
    for (let i = 0; i < length; i++) sum += left[i];
    mean += sum / length;
  }
  check("impulse is silent at both ends", endsOk);
  check("impulse stays inside full scale", peak <= 1 && peak > 0.5, `peak ${peak.toFixed(3)}`);
  // The noise has to be sign-symmetric or the reverb injects a one-sided
  // thump. A finite burst always leaves a small residual mean, so the bar is
  // "well under the peak", not "zero".
  const balance = Math.abs(positive - negative) / Math.max(1, positive + negative);
  check(
    "noise is sign-symmetric (no DC kick)",
    balance < 0.02 && Math.abs(mean) < 0.05,
    `${(balance * 100).toFixed(2)}% sign imbalance, mean ${mean.toExponential(2)}`,
  );

  // The tail has to fall, and it has to keep falling: block RMS must decrease
  // across the whole impulse.
  {
    const { left, length } = make(1.4);
    const block = Math.floor(length / 28);
    const rms = [];
    for (let b = 0; b < 28; b++) {
      let sum = 0;
      for (let i = b * block; i < (b + 1) * block; i++) sum += left[i] * left[i];
      rms.push(Math.sqrt(sum / block));
    }
    // The first block is still fading in, so it may sit below the second.
    let rises = 0;
    for (let b = 2; b < rms.length; b++) if (rms[b] > rms[b - 1] * 1.02) rises++;
    check(
      "impulse decays monotonically after the fade-in",
      rises === 0,
      `${rises} rising blocks, ${rms[0].toFixed(3)} -> ${rms[rms.length - 1].toExponential(2)}`,
    );
    check(
      "the last block is far down the tail",
      rms[rms.length - 1] < rms[3] * 0.2,
      `${rms[3].toFixed(3)} -> ${rms[rms.length - 1].toExponential(2)}`,
    );
  }

  // The two channels must not be the same burst, or the reverb collapses to
  // mono in the sum.
  {
    const { left, right } = make(1.4);
    let identical = 0;
    for (let i = 0; i < left.length; i++) if (left[i] === right[i]) identical++;
    check(
      "channels are decorrelated",
      identical < left.length * 0.01,
      `${identical} identical samples of ${left.length}`,
    );
  }

  // The tabulated envelope has to match the closed form it replaced, or the
  // speed-up silently changed the sound. The reference below is the original
  // per-sample Math.pow version, driven by the same xorshift sequence, so on the
  // flat region the two must agree sample for sample.
  //
  // A running product `env *= (1 - 1/L)^power` is NOT equivalent -- it fits a
  // geometric curve to a power curve and leaves the last 5% of the tail 380x
  // too loud, which a voice changer would render as a reverb that never dies.
  {
    const { left, length, attack, release } = make(1.4);
    const ref = new Float32Array(length);
    let seed = 0x2f6e2b1;
    for (let i = 0; i < length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = (seed / 0x7fffffff) % 1;
      const edge = Math.min(1, i / attack, (length - i) / release);
      ref[i] = noise * Math.pow(1 - i / length, IMPULSE_DECAY_POWER) * edge;
    }
    const flatEnd = length - release - 2;
    let worst = 0;
    for (let i = attack; i < flatEnd; i++) {
      worst = Math.max(worst, Math.abs(left[i] - ref[i]));
    }
    check(
      "tabulated envelope matches the closed form",
      worst < 1e-5,
      `worst sample difference ${worst.toExponential(2)} over ${flatEnd - attack} samples`,
    );
    // And the envelope has to actually bound the noise everywhere, or the
    // fast path is louder than the original.
    let over = 0;
    for (let i = 0; i < length; i++) {
      const env =
        (1 - i / length) ** IMPULSE_DECAY_POWER *
        Math.min(1, i / attack, (length - i) / release);
      if (Math.abs(left[i]) > env + 1e-6) over++;
    }
    check("no sample exceeds the envelope", over === 0, `${over} samples over`);
  }

  // Rebuilding while a slider is dragged must not eat a frame. 12.5 ms of
  // main-thread time at 4 s stereo is what the Math.pow form measured.
  {
    const length = Math.floor(SR * 4);
    const { attack, release } = impulseEdges(SR);
    const buf = new Float32Array(length);
    const best = Math.min(
      ...[0, 1, 2].map(() => {
        const t0 = performance.now();
        for (let k = 0; k < 5; k++) fillImpulse(buf, 0x2f6e2b1, attack, release);
        return (performance.now() - t0) / 5;
      }),
    );
    check(
      "a 4 s stereo rebuild stays well under a frame",
      best < 4,
      `${best.toFixed(2)} ms per channel (was 12.5 ms with Math.pow per sample)`,
    );
  }

  // Degenerate inputs must not hang or write out of bounds.
  {
    const tiny = new Float32Array(1);
    fillImpulse(tiny, 1, 4, 4);
    check("length-1 impulse writes one silent sample", tiny[0] === 0);
    const empty = new Float32Array(0);
    check("empty impulse is a no-op", fillImpulse(empty, 7, 4, 4) === 7);
    const short = new Float32Array(8);
    fillImpulse(short, 1, 4, 4);
    check("tiny impulse stays finite", short.every((v) => Number.isFinite(v)));
  }
}

// --------------------------------------------------------------------------
console.log("\nsettings sanitising (untrusted storage / imported files)");
{
  const base = defaultSettings();
  const clean = sanitizeSettings(base);
  check("valid settings round-trip", JSON.stringify(clean) === JSON.stringify(base));

  const nasty = sanitizeSettings({
    ...base,
    reverbTime: 30000,
    delayTime: 1e9,
    outputGain: -50,
    manualSemitones: "loud",
    detector: "telepathy",
    agc: "yes",
    highpassHz: Number.NaN,
    unknownKey: 1,
  });
  check("reverbTime clamped", nasty.reverbTime === 4, `${nasty.reverbTime}`);
  check("delayTime clamped to the node limit", nasty.delayTime === 1.9, `${nasty.delayTime}`);
  check("outputGain clamped", nasty.outputGain === 0, `${nasty.outputGain}`);
  check("non-numeric value rejected", nasty.manualSemitones === 0);
  check("invalid enum rejected", nasty.detector === "auto");
  check("non-boolean flag rejected", nasty.agc === false);
  check("NaN rejected", nasty.highpassHz === 40);
  check("unknown keys dropped", !("unknownKey" in nasty));
  check("garbage input yields defaults", (() => {
    const d = sanitizeSettings("nope");
    return JSON.stringify(d) === JSON.stringify(base);
  })());
  check("null-prototype input is accepted", (() => {
    const d = sanitizeSettings(Object.assign(Object.create(null), { targetMidi: 72 }));
    return d.targetMidi === 72 && d.outputGain === base.outputGain;
  })());
  check("every numeric knob is range-checked", (() => {
    // A knob with no range entry would let arbitrary values reach the graph.
    const keys = Object.keys(base).filter((k) => typeof base[k] === "number");
    return keys.every((k) => sanitizeSettings({ ...base, [k]: -1e9 })[k] !== -1e9);
  })());

  // 4 s of stereo 48 kHz is the largest impulse we will ever build; anything
  // above that used to attempt a multi-gigabyte allocation.
  const impulseSamples = Math.floor(48000 * nasty.reverbTime) * 2;
  check("worst-case impulse stays small", impulseSamples < 500000, `${impulseSamples} samples`);
}

// --------------------------------------------------------------------------
console.log("\nvirtual device detection");
{
  const virtuals = [
    "CABLE Output (2- CABLE Input)",
    "CABLE-A Input",
    "VB-Audio Virtual Cable",
    "VB-Audio VoiceMeeter VAO",
    "BlackHole 2ch",
    "VoiceMeeter Output",
    "Soundflower (2ch)",
    "Multi-Output Device",
    "Aggregate Device",
    "Loopback Audio",
    "Dante Virtual Soundcard",
    "NDI Audio",
    "Scream Cast",
    "Virtual Audio Cable",
  ];
  const real = [
    "MacBook Pro Microphone (Built-in)",
    "MacBook Pro Speakers (Built-in)",
    "USB Audio Device",
    "Realtek High Definition Audio",
    "Realtek USB Audio",
    "USB Hi-Fi Audio",
    "Headset Microphone (HyperX Cloud II)",
    "Focusrite Scarlett 2i2 USB",
    "Samsung USB Digital Audio",
    "Sony WH-1000XM4",
    "Speakers (Realtek Audio)",
    "AirPods Pro Microphone",
    "Digital Output Device (HDMI)",
  ];
  const missed = virtuals.filter((d) => !isVirtualDevice(d));
  const flagged = real.filter((d) => isVirtualDevice(d));
  check("all virtual cables detected", missed.length === 0, missed.join(", "));
  check("no real hardware mislabelled as virtual", flagged.length === 0, flagged.join(", "));
}

// --------------------------------------------------------------------------
console.log("\npreset storage (untrusted localStorage)");
{
  // Minimal localStorage stand-in; presets.ts only ever uses these four calls.
  const store = new Map();
  let writes = 0;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      writes++;
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  const { loadCustomPresets, saveCustomPresets, removeCustomPreset } = await import(
    "../src/audio/presets.ts"
  );
  const KEY = "nabra-custom-presets";
  const base = defaultSettings();

  store.set(KEY, "not json");
  check("corrupt storage yields no presets", loadCustomPresets().length === 0);

  store.set(KEY, JSON.stringify({ nope: true }));
  check("non-array storage yields no presets", loadCustomPresets().length === 0);

  store.set(
    KEY,
    JSON.stringify([
      { id: "a", name: "صوت", settings: { reverbTime: 30000, formant: 999 } },
      { id: "a", name: "مكرر", settings: { formant: 1 } },
      { id: "b", name: "", settings: { agc: "نعم" } },
      { name: "بلا معرّف", settings: { compress: 0.3 } },
      { id: "c", name: "بلا إعدادات" },
      null,
      "nope",
      [1, 2, 3],
    ]),
  );
  const loaded = loadCustomPresets();
  check("unusable entries dropped", loaded.length === 4, `${loaded.length} kept`);
  check("all ids unique", new Set(loaded.map((p) => p.id)).size === 4);
  check("out-of-range reverbTime clamped", loaded[0].settings.reverbTime === 4, `${loaded[0].settings.reverbTime}`);
  check("out-of-range formant clamped", loaded[0].settings.formant === 12, `${loaded[0].settings.formant}`);
  check("blank name replaced", loaded[2].name.length > 0, loaded[2].name);
  check("non-boolean flag rejected", loaded[2].settings.agc === false);
  check("missing id synthesised", typeof loaded[3].id === "string" && loaded[3].id.length > 0);
  check("entry without settings dropped", !loaded.some((p) => p.id === "c"));

  // A quota failure must not take the app down.
  store.set(KEY, JSON.stringify([{ id: "a", name: "x", settings: base }]));
  const realSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  let threw = false;
  try {
    saveCustomPresets([...loadCustomPresets()]);
  } catch {
    threw = true;
  }
  check("quota failure is swallowed", !threw);
  globalThis.localStorage.setItem = realSet;

  store.set(KEY, JSON.stringify([{ id: "a", name: "x", settings: base }]));
  check("remove returns the survivors", removeCustomPreset("a").length === 0);
  check("removal is persisted", loadCustomPresets().length === 0);

  // A bulk write must cost exactly one localStorage write, not one per preset.
  writes = 0;
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `p${i}`,
    name: `م${i}`,
    settings: base,
  }));
  check("bulk save writes once", saveCustomPresets(many).length === 25 && writes === 1, `${writes} writes`);
}

console.log(
  failures === 0
    ? `\nALL ${checks} CHECKS PASSED\n`
    : `\n${failures} of ${checks} CHECKS FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
