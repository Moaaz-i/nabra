/* Taps the input signal for the voice-activity detector.
 *
 * Runs in three environments, the same contract `pitchWorklet.cjs` keeps:
 *  - AudioWorkletGlobalScope: registers the "nabra-vad-tap" processor.
 *  - Node (CommonJS): exports { Resampler, VAD_SAMPLE_RATE, VAD_CHUNK_SAMPLES }
 *    so the resampler and the chunking can be validated offline.
 *  - Renderer build: consumed as a raw string via `import src from "?raw"`
 *    and injected with a Blob URL (no extra asset, works packaged on file://).
 *
 * The processor does nothing but gather samples and hand over 512-sample
 * chunks. Inference stays on the main thread because ONNX Runtime cannot be
 * loaded inside a worklet scope, and one call costs about 0.5 ms every 32 ms,
 * which is a rounding error against the control loop that already runs there.
 */

"use strict"

/** Silero's native rate. The graph runs at 48 kHz (or 44.1), so this is a downsample. */
const VAD_SAMPLE_RATE = 16000
/** One model call: 32 ms of audio at 16 kHz. */
const VAD_CHUNK_SAMPLES = 512

/**
 * Chunks held while waiting for the analysis loop to drain them. Bounded so a
 * stalled or hidden window cannot turn the worklet into a memory leak: the
 * oldest audio is also the least useful.
 */
const MAX_PENDING_CHUNKS = 8

const EMPTY = new Float32Array(0)

/**
 * Streaming linear-interpolation resampler from the graph rate to 16 kHz.
 *
 * Interpolation on its own is not enough. Decimating to 16 kHz halves the
 * band, and anything the microphone captured above 8 kHz -- sibilance, a
 * hard-drive whine, the top of a notification chime -- would fold back down
 * into the 0-8 kHz speech band and be presented to the model as speech it was
 * never hearing. `VadTapProcessor` puts a three-tap box filter in front of
 * this, which is what keeps that band out; this class's job is only to place
 * the output samples correctly.
 *
 * Linear rather than windowed-sinc because the signal is about to be fed to a
 * neural network, not to a listener: what matters is that phase is preserved
 * sample to sample and that the output lands at the right instants, not that
 * the transition band is steep.
 *
 * It also has to be *streaming*: the worklet sees 128 samples at a time, and
 * an output sample that straddles two calls has to interpolate across them.
 * The one sample of lookback it keeps is the whole reason for the retained
 * buffer, and it is what makes the result independent of where the calls fall
 * -- feeding 128 at a time or the whole signal at once produces bit-identical
 * output, which `vad-test.mjs` asserts.
 */
class Resampler {
  constructor(inRate, outRate) {
    if (!(inRate > 0) || !(outRate > 0)) {
      throw new Error("resampler rates must be positive")
    }
    /** Input samples per output sample; below 1 means upsampling. */
    this.step = inRate / outRate
    /** Fractional read position, measured from index 0 of `acc`. */
    this.pos = 0
    this.len = 0
    this.acc = new Float32Array(256)
  }

  _ensure(extra) {
    if (this.len + extra <= this.acc.length) return
    let cap = this.acc.length
    while (cap < this.len + extra) cap *= 2
    const grown = new Float32Array(cap)
    grown.set(this.acc.subarray(0, this.len))
    this.acc = grown
  }

  /** Consumes `input`; returns the resampled samples it can now produce. */
  push(input) {
    const step = this.step
    const start = this.pos
    let out = EMPTY
    let pos = start

    this._ensure(input.length)
    this.acc.set(input, this.len)
    this.len += input.length

    // An output sample needs the input sample it sits on and the one after
    // it, so `pos` may not reach the end of the buffer: `pos < len - 1`.
    if (start < this.len - 1) {
      const count = Math.ceil((this.len - 1 - start) / step)
      out = new Float32Array(count)
      for (let i = 0; i < count; i++) {
        const base = Math.floor(pos)
        const frac = pos - base
        const a = this.acc[base]
        out[i] = a + (this.acc[base + 1] - a) * frac
        pos += step
      }
    }

    // Drop what has been consumed but keep the sample the read position now
    // stands on, plus whatever follows it, so the next call can interpolate
    // across the boundary. Clamped to `len` because the position may have
    // advanced past the end of the buffer -- that is the case where every
    // retained sample is already behind the reader and the next output wants
    // samples that have not arrived yet.
    const keep = Math.min(this.len, Math.floor(pos))
    if (keep > 0) {
      this.acc.copyWithin(0, keep, this.len)
      this.len -= keep
      pos -= keep
    }
    this.pos = pos
    return out
  }
}

/**
 * Three-tap moving average -- the anti-aliasing half of the downsample.
 *
 * Decimating to 16 kHz halves the band, and sibilance, a drive whine or the
 * top of a notification chime all sit above 8 kHz where they would fold back
 * into the speech band and be handed to the model as something it never heard.
 * The nulls here land on multiples of 16 kHz and the response is already
 * -9.5 dB by 12 kHz, which is enough to keep that band out. It is not a brick
 * wall -- a proper one costs an FIR the worklet has no budget for -- so it is
 * sized against what a microphone actually leaks, not against a spec sheet.
 *
 * `prev` carries the two samples before the current block so the filter runs
 * continuously across the 128-sample quanta the worklet is handed.
 */
class Box3 {
  constructor() {
    this.prev = new Float32Array(2)
    this.out = new Float32Array(0)
  }

  push(input) {
    if (this.out.length !== input.length) {
      this.out = new Float32Array(input.length)
    }
    const out = this.out
    let x2 = this.prev[0]
    let x1 = this.prev[1]
    for (let i = 0; i < input.length; i++) {
      const x0 = input[i]
      out[i] = (x2 + x1 + x0) / 3
      x2 = x1
      x1 = x0
    }
    const n = input.length
    this.prev[0] = n >= 2 ? input[n - 2] : this.prev[1]
    this.prev[1] = input[n - 1]
    return out
  }
}

const api = { Resampler, Box3, VAD_SAMPLE_RATE, VAD_CHUNK_SAMPLES }

if (
  typeof AudioWorkletGlobalScope !== "undefined" &&
  typeof registerProcessor === "function"
) {
  class VadTapProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      const o = (options && options.processorOptions) || {}
      // Passed explicitly by the engine rather than read from the scope
      // global, so the rate is whatever the live AudioContext actually opened
      // at -- 48 kHz on most hardware, 44.1 on some -- not what it defaults to.
      const inRate = Number(o.sampleRate) > 0 ? Number(o.sampleRate) : sampleRate
      this.resampler = new Resampler(inRate, VAD_SAMPLE_RATE)
      this.box = new Box3()
      this.pending = new Float32Array(VAD_CHUNK_SAMPLES)
      this.pendingLen = 0
      this.queue = []
    }

    _push(chunk) {
      let off = 0
      while (off < chunk.length) {
        const take = Math.min(
          VAD_CHUNK_SAMPLES - this.pendingLen,
          chunk.length - off,
        )
        this.pending.set(chunk.subarray(off, off + take), this.pendingLen)
        this.pendingLen += take
        off += take
        if (this.pendingLen === VAD_CHUNK_SAMPLES) {
          this.queue.push(this.pending.slice())
          this.pendingLen = 0
          if (this.queue.length > MAX_PENDING_CHUNKS) this.queue.shift()
        }
      }
    }

    process(inputs, outputs) {
      const input = inputs[0]
      const channel = input && input.length > 0 ? input[0] : null
      if (channel && channel.length > 0) {
        // Anti-alias first, then resample. The box filter's output buffer is
        // reused, which is safe only because the resampler copies what it is
        // given before the next quantum arrives.
        const resampled = this.resampler.push(this.box.push(channel))
        if (resampled.length > 0) this._push(resampled)
        while (this.queue.length > 0) this.port.postMessage(this.queue.shift())
      }
      // The output is silence on purpose. The node has to reach the
      // destination to be pulled at all, and wiring real signal through it
      // would double the voice every time the tap was reconnected.
      for (let c = 0; c < outputs.length; c++) outputs[c].fill(0)
      return true
    }
  }

  registerProcessor("nabra-vad-tap", VadTapProcessor)
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = api
}
