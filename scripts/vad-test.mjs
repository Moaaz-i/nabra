/*
 * Offline validation of the voice-activity detector in src/audio/vad.ts and
 * src/audio/vadWorklet.cjs.
 *
 * Four levels, cheapest first:
 *   1. the settings that feed it -- ranges, defaults, and the sanitizer;
 *   2. the probability -> open/close state machine;
 *   3. the box filter and resampler, plus the worklet processor itself, with
 *      the AudioWorklet scope shimmed the way pv-test.cjs shims the pitch
 *      worklet so the real streaming path is what gets exercised;
 *   4. the real Silero model, against four kinds of audio.
 *
 * Level 4 is the one that matters, and it has already earned its keep twice.
 * The first time: the model on Silero's `master` branch scores 0.0031 on
 * genuine speech -- indistinguishable from silence -- while the v5.1.2 release
 * scores 0.9998 on the same samples. Both files are 2 327 524 bytes, so only
 * the pinned hash below tells them apart. The second time: my own first test
 * read the audio at byte 44, and `afconvert` had inserted a 4 044-byte
 * `FLLR` chunk before the data, so it was feeding the model padding and
 * concluding the model was broken. Hence the chunk-walking WAV reader here.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ort from "onnxruntime-web/wasm";

import {
  createVad,
  initialVadState,
  newVadState,
  stepVad,
  vadThresholds,
  VAD_CHUNK_SAMPLES,
  VAD_SAMPLE_RATE,
} from "../src/audio/vad.ts";
import { defaultSettings, sanitizeSettings } from "../src/audio/settings.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
}

function near(label, actual, expected, tolerance) {
  check(
    label,
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${actual} vs ${expected} ±${tolerance}`,
  );
}

/* ------------------------------------------------------------------ */
/* level 1: settings                                                   */
/* ------------------------------------------------------------------ */

console.log("\nsettings");

{
  const d = defaultSettings();
  check("vadEnabled defaults on", d.vadEnabled === true, `${d.vadEnabled}`);
  near("vadSensitivity defaults to the middle", d.vadSensitivity, 0.5, 1e-9);

  const off = sanitizeSettings({ vadEnabled: false });
  check("vadEnabled is settable", off.vadEnabled === false);

  // Settings arrive from localStorage, preset files and hand-edited JSON. A
  // string that happens to be truthy must not become a boolean, or the
  // "enabled" flag would be stuck on for anyone who edits their config.
  for (const bogus of ["false", "yes", 1, 0, null, undefined, {}]) {
    check(
      `vadEnabled ignores ${JSON.stringify(bogus)}`,
      sanitizeSettings({ vadEnabled: bogus }).vadEnabled === true,
    );
  }

  near("vadSensitivity clamps high", sanitizeSettings({ vadSensitivity: 99 }).vadSensitivity, 1, 1e-9);
  near("vadSensitivity clamps low", sanitizeSettings({ vadSensitivity: -5 }).vadSensitivity, 0, 1e-9);
  near("vadSensitivity ignores NaN", sanitizeSettings({ vadSensitivity: NaN }).vadSensitivity, 0.5, 1e-9);
  near("vadSensitivity ignores a string", sanitizeSettings({ vadSensitivity: "0.9" }).vadSensitivity, 0.5, 1e-9);

  const unknown = sanitizeSettings({ vadWhatever: 0.3 });
  check("unknown vad keys are dropped", !("vadWhatever" in unknown));

  // A preset must not be able to flip it. VAD is routing behaviour, not part
  // of a sound, exactly like the gate it feeds.
  const asPreset = sanitizeSettings({ ...defaultSettings(), vadEnabled: false });
  check("a preset-shaped object still sanitizes", asPreset.vadEnabled === false);
}

/* ------------------------------------------------------------------ */
/* level 2: the decision state machine                                 */
/* ------------------------------------------------------------------ */

console.log("\ndecision");

{
  const strict = vadThresholds(0);
  const normal = vadThresholds(0.5);
  const loose = vadThresholds(1);

  near("sensitivity 0 opens at 0.70", strict.open, 0.7, 1e-9);
  near("sensitivity 0.5 opens at 0.45", normal.open, 0.45, 1e-9);
  near("sensitivity 1 opens at 0.20", loose.open, 0.2, 1e-9);
  near("out-of-range sensitivity clamps low", vadThresholds(-9).open, strict.open, 1e-9);
  near("NaN sensitivity clamps low", vadThresholds(NaN).open, strict.open, 1e-9);

  // The whole point of two thresholds is that closing is easier than opening,
  // so a word trailing off does not chatter the gate in the middle of itself.
  for (const t of [strict, normal, loose]) {
    check("close is strictly below open", t.close < t.open, `${t.close} < ${t.open}`);
  }

  // The model's measured peaks are 1.00 for speech and 0.13 for white noise.
  // Even the most permissive setting must sit above the noise peak, or
  // "sensitivity 1" would mean "gate permanently open".
  check("noise peak stays below the loosest threshold", 0.13 < loose.open, `${loose.open}`);

  const t = normal;

  // The state the engine holds before the model has heard anything. It must
  // not silence a routing that has just started.
  const undecided = initialVadState();
  check("initial state is open", undecided.speaking === true);
  check("initial state has an expired deadline", undecided.holdUntil === 0);
  near("initial state carries no probability", undecided.prob, 0, 1e-9);

  // One low chunk closes it: undecided is permission, not momentum.
  const closedByFirstChunk = stepVad(undecided, 0.01, t, 1.0);
  check("first silent chunk closes the initial state", closedByFirstChunk.speaking === false);

  // A run of pure silence never opens, from either starting state.
  for (const start of [newVadState(), initialVadState()]) {
    let s = start;
    for (let i = 0; i < 60; i++) s = stepVad(s, 0.005, t, 1 + i * 0.032);
    check("silence never opens", s.speaking === false);
    near("silence leaves no deadline", s.holdUntil, 0, 1e-9);
    near("the probability is still reported", s.prob, 0.005, 1e-9);
  }

  // Opening is immediate. The model already smooths itself, and a "N
  // consecutive frames" delay would be paid on the onset of every utterance.
  const opened = stepVad(newVadState(), 0.9, t, 10);
  check("one voiced frame opens", opened.speaking === true);
  near("and arms the hangover deadline", opened.holdUntil, 10 + 0.2, 1e-9);

  // Below the open threshold does not open, however briefly true it is.
  check("0.44 does not open at 0.45", stepVad(newVadState(), 0.44, t, 10).speaking === false);
  check("exactly the threshold does open", stepVad(newVadState(), 0.45, t, 10).speaking === true);

  // Hangover: a gap shorter than the deadline is a pause between words, not
  // the end of the sentence.
  let s = stepVad(newVadState(), 0.95, t, 10);
  s = stepVad(s, 0.0, t, 10.05);
  check("a 50 ms gap stays open", s.speaking === true);
  s = stepVad(s, 0.0, t, 10.19);
  check("a 190 ms gap stays open", s.speaking === true);
  s = stepVad(s, 0.0, t, 10.1999);
  check("still open just before the deadline", s.speaking === true);
  s = stepVad(s, 0.0, t, 10.2);
  check("closed exactly at the deadline", s.speaking === false);

  // Hysteresis: a word that trails off below the open threshold but above the
  // close one keeps the gate, and each voiced frame re-arms the deadline.
  s = stepVad(newVadState(), 0.9, t, 20);
  s = stepVad(s, 0.3, t, 20.05); // below 0.45, above 0.225
  check("trailing voice stays open", s.speaking === true);
  s = stepVad(s, 0.3, t, 20.19);
  check("and re-arms the deadline", s.speaking === true);
  s = stepVad(s, 0.3, t, 20.38);
  check("re-armed deadline holds it past the original", s.speaking === true);

  // Only a *rising* probability extends the deadline. Coast on the deadline
  // alone and one voiced frame would hold the gate open for as long as it
  // liked.
  s = stepVad(newVadState(), 0.9, t, 30);
  const coasted = stepVad(s, 0.0, t + 0.19, 30);
  check("a silent frame does not extend the deadline", coasted.holdUntil === s.holdUntil);

  // Below the close threshold, with the deadline expired, it closes.
  s = stepVad(newVadState(), 0.9, t, 40);
  s = stepVad(s, 0.224, t, 40.3);
  check("probability below close drops it", s.speaking === false);

  // Defensive: the engine reads a probability straight out of an inference
  // result. A NaN must never be able to open the gate.
  check("NaN does not open", stepVad(newVadState(), NaN, t, 50).speaking === false);
  check("Infinity is clamped, not opened", stepVad(newVadState(), Infinity, t, 50).speaking === false);
  near("values above 1 clamp to 1", stepVad(newVadState(), 4, t, 50).prob, 1, 1e-9);
  near("values below 0 clamp to 0", stepVad(newVadState(), -4, t, 50).prob, 0, 1e-9);
}

/* ------------------------------------------------------------------ */
/* level 3: box filter, resampler, worklet processor                   */
/* ------------------------------------------------------------------ */

console.log("\nworklet");

const require = createRequire(import.meta.url);

// The worklet registers itself at require time, so the globals have to exist
// first -- the same shim pv-test.cjs uses for the pitch worklet.
globalThis.sampleRate = 48000;
globalThis.AudioWorkletGlobalScope = function AudioWorkletGlobalScope() {};
globalThis.AudioWorkletProcessor = class AudioWorkletProcessor {
  constructor() {
    this.messages = [];
    this.port = {
      postMessage: (m) => {
        this.messages.push(m);
      },
      onmessage: null,
      start() {},
      close() {},
    };
  }
};
let registered = null;
globalThis.registerProcessor = (name, cls) => {
  registered = { name, cls };
};

const workletPath = path.join(root, "src", "audio", "vadWorklet.cjs");
const { Resampler, Box3 } = require(workletPath);

const TAU = Math.PI * 2;

function sine(freq, amplitude, seconds, rate) {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((TAU * freq * i) / rate);
  return out;
}

/** Positive-going crossings: a f Hz tone over s seconds has 2*f*s of them. */
function zeroCrossings(x) {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return n;
}

function rmsOf(x) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, x.length));
}

// --- box filter ------------------------------------------------------

{
  const box = new Box3();
  // A fresh filter has no history, so the first two samples ramp in from
  // zero and the third is the first full average. That cold start is 0.04 ms
  // of audio and is not worth suppressing -- but it does mean "passes DC at
  // unity" is a statement about steady state, not about sample zero.
  const dc = box.push(new Float32Array(128).fill(0.6));
  near("the first sample is one third", dc[0], 0.2, 1e-6);
  near("the second is two thirds", dc[1], 0.4, 1e-6);
  near("the third is unity", dc[2], 0.6, 1e-6);
  near("and stays there", dc[127], 0.6, 1e-6);

  // The carry across the quantum boundary is the part that is easy to get
  // wrong: the next block has to see the two samples this one ended on.
  const second = box.push(new Float32Array(4).fill(0.6));
  near("the carry is carried", second[0], 0.6, 1e-6);

  // One long filter has to agree with the piecewise one, sample for sample.
  const long = sine(12000, 1, 0.02, 48000);
  const whole = new Box3().push(long);
  const piecewise = new Box3();
  const joined = new Float32Array(long.length);
  for (let off = 0; off < long.length; off += 128) {
    const part = piecewise.push(long.subarray(off, off + 128));
    joined.set(part, off);
  }
  let worst = 0;
  for (let i = 0; i < long.length; i++) {
    worst = Math.max(worst, Math.abs(whole[i] - joined[i]));
  }
  check("box output does not depend on block size", worst < 1e-7, `worst ${worst}`);

  // The whole reason for the filter: 12 kHz is well inside the band that
  // would otherwise fold down into speech once the rate is halved.
  const tone12k = sine(12000, 0.5, 0.02, 48000);
  const filtered = new Box3().push(tone12k);
  const ratio = rmsOf(filtered) / rmsOf(tone12k);
  check("box attenuates 12 kHz by at least 8 dB", ratio < 0.4, `${(20 * Math.log10(ratio)).toFixed(1)} dB`);
}

// --- resampler -------------------------------------------------------

{
  check("resampler rejects a zero rate", (() => {
    try {
      new Resampler(0, 16000);
      return false;
    } catch {
      return true;
    }
  })());

  // 48 kHz -> 16 kHz is exactly three, so a second of audio has to come out
  // as a second of audio, give or take the sample the reader is standing on.
  const r = new Resampler(48000, VAD_SAMPLE_RATE);
  const oneSecond = sine(1000, 0.5, 1, 48000);
  const out = r.push(oneSecond);
  check("48k->16k keeps the duration", Math.abs(out.length - 16000) <= 1, `${out.length} samples`);
  near("and the level", rmsOf(out), rmsOf(oneSecond), 0.01);

  // Frequency has to survive, not just length: a resampler that dropped or
  // repeated a sample would still produce the right *number* of samples.
  // A sine completes one cycle per period, so f Hz over s seconds leaves
  // f * s positive-going crossings -- count them and the rate is proven.
  const expected = (x) => 1000 * (x.length / VAD_SAMPLE_RATE);
  const crossings = zeroCrossings(out);
  check(
    "1 kHz survives as 1 kHz",
    Math.abs(crossings - expected(out)) <= 2,
    `${crossings} crossings`,
  );

  // The property that makes the streaming design safe: where the input is
  // handed over in blocks must not change a single output sample. A
  // resampler that forgot its lookback would pass every other test above.
  const whole = new Resampler(48000, VAD_SAMPLE_RATE).push(sine(731, 0.4, 0.5, 48000));
  const piecewise = new Resampler(48000, VAD_SAMPLE_RATE);
  const joined = new Float32Array(whole.length + 8);
  let filled = 0;
  const src = sine(731, 0.4, 0.5, 48000);
  for (let off = 0; off < src.length; off += 128) {
    const part = piecewise.push(src.subarray(off, off + 128));
    joined.set(part, filled);
    filled += part.length;
  }
  let worst = 0;
  for (let i = 0; i < Math.min(filled, whole.length); i++) {
    worst = Math.max(worst, Math.abs(whole[i] - joined[i]));
  }
  check("output does not depend on block size", worst === 0, `worst ${worst}`);

  // 44.1 kHz is not a whole multiple of 16 kHz, so this is the fractional
  // path -- the one an integer-only implementation would get wrong.
  const r441 = new Resampler(44100, VAD_SAMPLE_RATE);
  const out441 = r441.push(sine(1000, 0.5, 1, 44100));
  check("44.1k->16k keeps the duration", Math.abs(out441.length - 16000) <= 1, `${out441.length} samples`);
  check(
    "44.1k->16k keeps the frequency",
    Math.abs(zeroCrossings(out441) - 1000 * (out441.length / VAD_SAMPLE_RATE)) <= 2,
    `${zeroCrossings(out441)} crossings`,
  );

  // Steady state, not just the first block: the buffer has to be compacted
  // correctly or the position drifts and the pitch slides.
  const drift = new Resampler(48000, VAD_SAMPLE_RATE);
  let produced = 0;
  const long = sine(1000, 0.5, 1, 48000);
  for (let off = 0; off < long.length; off += 128) {
    produced += drift.push(long.subarray(off, off + 128)).length;
  }
  check("no drift over a full second", Math.abs(produced - 16000) <= 1, `${produced} samples`);
}

// --- the processor itself --------------------------------------------

{
  check("the worklet registered", registered != null && registered.name === "nabra-vad-tap", registered?.name);

  if (registered) {
    const proc = new registered.cls({ processorOptions: { sampleRate: 48000 } });

    // Silence in, silence out -- the node is wired to the destination purely
    // to be pulled, and real signal through it would double the voice.
    for (let i = 0; i < 40; i++) {
      proc.process([[new Float32Array(128)]], [[new Float32Array(128)]]);
    }
    check("the processor outputs silence", proc.messages.every((m) => m.every((v) => v === 0)));

    // 300 quanta at 48 kHz is 0.8 s, which is 12 800 samples at 16 kHz and so
    // 25 complete chunks. Each has to be exactly the model's input size.
    const proc2 = new registered.cls({ processorOptions: { sampleRate: 48000 } });
    const low = sine(220, 0.5, 0.8, 48000);
    for (let off = 0; off < low.length; off += 128) {
      proc2.process([[low.subarray(off, off + 128)]], [[new Float32Array(128)]]);
    }
    const chunks = proc2.messages;
    check("chunks are produced at the expected rate", chunks.length >= 20, `${chunks.length} chunks`);
    check(
      "every chunk is the model's input size",
      chunks.every((c) => c.length === VAD_CHUNK_SAMPLES),
    );
    check("chunks are copies, not the reused buffer", chunks[0] !== chunks[1]);

    // 220 Hz must still be 220 Hz after the box filter and the decimation.
    const joined = new Float32Array(chunks.length * VAD_CHUNK_SAMPLES);
    chunks.forEach((c, i) => joined.set(c, i * VAD_CHUNK_SAMPLES));
    const crossings = zeroCrossings(joined);
    check(
      "220 Hz survives the whole tap",
      Math.abs(crossings - 220 * (joined.length / VAD_SAMPLE_RATE)) <= 4,
      `${crossings} crossings over ${(joined.length / VAD_SAMPLE_RATE).toFixed(2)} s`,
    );

    // The rate is whatever the context opened at, not a default. 44.1 kHz is
    // the fractional path, so this also proves the processor is not quietly
    // assuming the 48 kHz it was written against.
    const proc441 = new registered.cls({ processorOptions: { sampleRate: 44100 } });
    const alt = sine(1000, 0.5, 1, 44100);
    for (let off = 0; off < alt.length; off += 128) {
      proc441.process([[alt.subarray(off, off + 128)]], [[new Float32Array(128)]]);
    }
    const joined441 = new Float32Array(proc441.messages.length * VAD_CHUNK_SAMPLES);
    proc441.messages.forEach((c, i) => joined441.set(c, i * VAD_CHUNK_SAMPLES));
    const crossings441 = zeroCrossings(joined441);
    check(
      "44.1 kHz input still yields 16 kHz output",
      Math.abs(crossings441 - 1000 * (joined441.length / VAD_SAMPLE_RATE)) <= 4,
      `${crossings441} crossings`,
    );

    // An idle input (nothing connected) must not throw or emit anything.
    const before = proc.messages.length;
    proc.process([[]], [[new Float32Array(128)]]);
    check("an empty input is ignored", proc.messages.length === before);
  }
}

/* ------------------------------------------------------------------ */
/* level 4: the model                                                  */
/* ------------------------------------------------------------------ */

console.log("\nmodel");

/** Reads mono 16-bit PCM, walking the chunks rather than assuming byte 44. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4).toString() !== "RIFF" || buf.subarray(8, 12).toString() !== "WAVE") {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }
  let off = 12;
  let dataOff = 0;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.subarray(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff === 0) throw new Error(`${file} has no data chunk`);
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + dataOff, dataLen >> 1);
  const f32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
  return f32;
}

/**
 * A deterministic generator, so "white noise" means the same samples on every
 * machine and a regression is reproducible. `Math.random` would make a failed
 * assertion impossible to re-run.
 */
function whiteNoise(n, seed) {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = (s / 0xffffffff - 0.5) * 0.5;
  }
  return out;
}

const modelPath = path.join(root, "public", "vad", "silero_vad.onnx");
const wasmPath = path.join(
  root,
  "node_modules",
  "onnxruntime-web",
  "dist",
  "ort-wasm-simd-threaded.wasm",
);

{
  const bytes = fs.readFileSync(modelPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  // Silero's `master` branch ships a file of the *same size* that scores
  // 0.0031 on real speech. Nothing but this hash tells the two apart.
  const PINNED =
    "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f";
  check(
    "the model is the pinned v5.1.2 release",
    digest === PINNED,
    digest === PINNED ? digest.slice(0, 16) : `got ${digest}`,
  );
}

/** Runs a signal through the real model and reports its probabilities. */
async function probabilities(session, signal) {
  const probs = [];
  for (let i = 0; i + VAD_CHUNK_SAMPLES <= signal.length; i += VAD_CHUNK_SAMPLES) {
    probs.push(await session.process(signal.subarray(i, i + VAD_CHUNK_SAMPLES)));
  }
  return probs;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const peak = (xs) => xs.reduce((a, b) => (b > a ? b : a), 0);

{
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = new Uint8Array(fs.readFileSync(wasmPath));

  const session = await createVad(ort, new Uint8Array(fs.readFileSync(modelPath)));
  check("the session was created", session != null);

  const silence = new Float32Array(512 * 30);
  const tone = sine(220, 0.3, 512 * 30 / VAD_SAMPLE_RATE, VAD_SAMPLE_RATE);
  const noise = whiteNoise(512 * 30, 12345);
  const speech = readWav(path.join(root, "scripts", "fixtures", "speech-16k.wav"));

  const pSilence = await probabilities(session, silence);
  const pTone = await probabilities(session, tone);
  const pNoise = await probabilities(session, noise);

  // A fresh session per signal, so one cannot warm the next.
  session.reset();
  const pSpeech = await probabilities(session, speech);

  console.log(
    `    silence mean ${mean(pSilence).toFixed(4)} · tone ${mean(pTone).toFixed(4)} · ` +
      `noise ${mean(pNoise).toFixed(4)} · speech peak ${peak(pSpeech).toFixed(4)} mean ${mean(pSpeech).toFixed(4)}`,
  );

  // These bounds are deliberately far from the measured values. The
  // separation is what the detector runs on -- speech averages 0.87 and the
  // noisiest non-speech peaks at 0.13 -- so a check that only just passed
  // would mean the feature is already unreliable.
  check("silence stays well below any threshold", peak(pSilence) < 0.15, `peak ${peak(pSilence).toFixed(4)}`);
  check("a pure tone stays well below", peak(pTone) < 0.15, `peak ${peak(pTone).toFixed(4)}`);
  check("white noise stays well below", peak(pNoise) < 0.25, `peak ${peak(pNoise).toFixed(4)}`);
  check("real speech is unmistakable", peak(pSpeech) > 0.9, `peak ${peak(pSpeech).toFixed(4)}`);
  check("real speech is mostly above half", mean(pSpeech) > 0.5, `mean ${mean(pSpeech).toFixed(4)}`);
  check(
    "most of a spoken sentence counts as speech",
    pSpeech.filter((p) => p > 0.5).length > pSpeech.length * 0.5,
    `${pSpeech.filter((p) => p > 0.5).length}/${pSpeech.length}`,
  );
  console.log(
    `    speech, first 12 chunks: ${pSpeech.slice(0, 12).map((p) => p.toFixed(2)).join(" ")}`,
  );

  // --- end to end: probability in, open/close out ---
  // The headline behaviour of the whole feature, and the one a user notices:
  // speech opens the gate, and everything else -- which is what used to get
  // pitch-shifted as though it were a voice -- does not.
  session.reset();
  const thr = vadThresholds(0.5);
  let state = newVadState();
  const decisions = [];
  for (const p of pSpeech) {
    state = stepVad(state, p, thr, decisions.length * 0.032);
    decisions.push(state.speaking);
  }
  const openFrames = decisions.filter(Boolean).length;
  check(
    "speech holds the gate open for most of the sentence",
    openFrames > decisions.length * 0.6,
    `${openFrames}/${decisions.length}`,
  );

  for (const [label, probs] of [
    ["silence", pSilence],
    ["tone", pTone],
    ["noise", pNoise],
  ]) {
    let s = newVadState();
    let opened = 0;
    for (let i = 0; i < probs.length; i++) {
      s = stepVad(s, probs[i], thr, i * 0.032);
      if (s.speaking) opened++;
    }
    check(`${label} never opens the gate`, opened === 0, `${opened} of ${probs.length} frames`);
  }

  // Reset has to mean something: the engine relies on it to stop a new
  // session inheriting the old microphone's noise floor.
  session.reset();
  const afterReset = await probabilities(session, silence);
  check("reset clears the recurrent state", peak(afterReset) < 0.15, `peak ${peak(afterReset).toFixed(4)}`);
}

/* ------------------------------------------------------------------ */

console.log(
  failed === 0
    ? `\nALL ${passed} CHECKS PASSED\n`
    : `\n${failed} of ${passed + failed} CHECKS FAILED\n`,
);
process.exit(failed === 0 ? 0 : 1);
