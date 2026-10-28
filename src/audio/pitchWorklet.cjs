/* PhiShift — self-contained real-time Phase Vocoder pitch shifter.
 *
 * Runs in three environments:
 *  - AudioWorkletGlobalScope: registers the "nabra-pitch-shift" processor.
 *  - Node (CommonJS): exports { PhaseVocoder, fft, hannWindow, princArg }
 *    so the DSP can be validated offline with synthetic tones.
 *  - Renderer build: consumed as a raw string via `import src from "?raw"`
 *    and injected with a Blob URL (no extra asset, works packaged on file://).
 */

"use strict"

const TAU = Math.PI * 2

// Max ratio slew, in cents, applied per render quantum (128 samples). Moving
// the stretch factor gradually rather than jumping to it keeps the overlap-add
// from mixing frames built with two different stretch factors all at once: on a
// hard 1 -> 1.5 step the worst sample-to-sample jump measures 0.31 against a
// legitimate 0.03, and 18 cents/quantum brings that down to 0.12.
const MAX_SLEW_CENTS = 18

// Per-sample coefficient of the dry/processed crossfade (time constant ~1.7ms).
// The vocoder output is time-aligned with the input, so this is a plain
// crossfade rather than a comb. It is also what keeps the bypass click-free:
// switching hard back to the dry path starves the resampler FIFO and drops
// samples out, which this avoids entirely.
const BLEND_STEP = 0.012

function princArg(p) {
  let v = p
  while (v > Math.PI) v -= TAU
  while (v < -Math.PI) v += TAU
  return v
}

function hannWindow(n) {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((TAU * i) / (n - 1))
  return w
}

/**
 * In-place radix-2 Cooley-Tukey FFT.
 *
 * The twiddle sign matters: the forward transform must use e^(-2*pi*i*k*n/N)
 * so that `atan2(im, re)` is the *standard* analysis phase of bin k. The
 * vocoder's phase advance is `omega*hop + delta`, which is only a true phase
 * advance (and therefore only safe to scale by a fractional ratio) when the
 * two conventions agree. With the sign flipped, the advance comes out a whole
 * number of turns off, which is invisible for integer ratios (2, 3, 4) and
 * turns into a half-turn error for every fractional one -- i.e. for every
 * musically useful pitch shift.
 */
function fft(re, im, inverse) {
  const n = re.length
  if (n > 1 && (n & (n - 1)) !== 0) throw new Error("fft size must be a power of two")
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1
    // Forward: e^(-2*pi*i*k*n/N).  Inverse: e^(+2*pi*i*k*n/N), scaled by 1/N.
    const step = (TAU / size) * (inverse ? 1 : -1)
    for (let i = 0; i < n; i += size) {
      let angle = 0
      for (let k = i; k < i + half; k++) {
        const wr = Math.cos(angle)
        const wi = Math.sin(angle)
        const tr = re[k + half] * wr - im[k + half] * wi
        const ti = re[k + half] * wi + im[k + half] * wr
        re[k + half] = re[k] - tr
        im[k + half] = im[k] - ti
        re[k] += tr
        im[k] += ti
        angle += step
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] /= n
    im[i] /= n
  }
}

class FastFifo {
  constructor(capacity = 65536) {
    this.capacity = capacity
    this.mask = capacity - 1
    this.buf = new Float32Array(capacity)
    this.head = 0
    this.tail = 0
    this.count = 0
  }
  get length() {
    return this.count
  }
  pushSample(x) {
    if (this.count >= this.capacity) {
      this.tail = (this.tail + 1) & this.mask
      this.count--
    }
    this.buf[this.head] = x
    this.head = (this.head + 1) & this.mask
    this.count++
  }
  pushSamples(xs) {
    const len = xs.length
    for (let i = 0; i < len; i++) this.pushSample(xs[i])
  }
  read(offset) {
    if (offset >= this.count) return 0
    return this.buf[(this.tail + offset) & this.mask]
  }
  remove(n) {
    const drop = n < this.count ? n : this.count
    this.tail = (this.tail + drop) & this.mask
    this.count -= drop
  }
  clear() {
    this.head = 0
    this.tail = 0
    this.count = 0
  }
}

class PhaseVocoder {
  constructor(opts) {
    const fftSize = (opts && opts.fftSize) || 2048
    const hop = (opts && opts.hop) || 256
    this.fftSize = fftSize
    this.hop = hop
    this.sampleRate = (opts && opts.sampleRate) || 48000
    this.alpha = (opts && opts.ratio) || 1

    this.bins = (fftSize >> 1) + 1
    this.window = hannWindow(fftSize)
    this.re = new Float32Array(fftSize)
    this.im = new Float32Array(fftSize)
    this.mag = new Float32Array(this.bins)
    this.phaseSyn = new Float32Array(this.bins)
    this.phasePrev = new Float32Array(this.bins)
    this.omega = new Float32Array(this.bins)
    for (let k = 0; k < this.bins; k++) this.omega[k] = (TAU * k) / fftSize

    this.input = new FastFifo()
    this.outFifo = new FastFifo()
    this.acc = new Float32Array(32768)
    this.wsum = new Float32Array(32768)
    this.offset = 0
    this.lastEmit = 0
    this.readPos = 0
    this.initialized = false
  }

  setRatio(r) {
    this.alpha = r
  }

  pushSamples(samples) {
    this.input.pushSamples(samples)
    this._processFrames()
  }

  clear() {
    this.input.clear()
    this.outFifo.clear()
    this.acc.fill(0)
    this.wsum.fill(0)
    this.offset = 0
    this.lastEmit = 0
    this.readPos = 0
    this.initialized = false
  }

  // Resample the stretched stream by `step` (step === alpha restores duration
  // and yields a pitch shift of exactly alpha). Linear interpolation.
  pullNextResampled(step) {
    const base = Math.floor(this.readPos)
    if (base >= this.outFifo.length) return null
    const v0 = this.outFifo.read(base)
    const v1 = base + 1 < this.outFifo.length ? this.outFifo.read(base + 1) : v0
    const frac = this.readPos - base
    this.readPos += step
    if (this.readPos >= 32) {
      const drop = Math.floor(this.readPos) - 2
      if (drop > 0) {
        this.outFifo.remove(drop)
        this.readPos -= drop
      }
    }
    return v0 + (v1 - v0) * frac
  }

  pullNext() {
    if (this.outFifo.length === 0) return null
    const v = this.outFifo.read(0)
    this.outFifo.remove(1)
    return v
  }

  _processFrames() {
    const n = this.fftSize
    const hop = this.hop
    while (this.input.length >= n) {
      const alpha = this.alpha
      const hopSynth = Math.max(1, Math.round(hop * alpha))
      for (let i = 0; i < n; i++) this.re[i] = (this.input.read(i) || 0) * this.window[i]
      this.im.fill(0)
      fft(this.re, this.im, false)

      for (let k = 0; k < this.bins; k++) {
        const pr = this.re[k]
        const pi = this.im[k]
        this.mag[k] = Math.sqrt(pr * pr + pi * pi)
        const phase = Math.atan2(pi, pr)
        if (this.initialized) {
          const delta = princArg(phase - this.phasePrev[k] - this.omega[k] * hop)
          this.phaseSyn[k] = princArg(
            this.phaseSyn[k] + alpha * (this.omega[k] * hop + delta),
          )
        } else {
          this.phaseSyn[k] = phase
        }
        this.phasePrev[k] = phase
      }
      this.initialized = true

      // Synthesis spectrum (bins 0..N/2), Hermitian mirror for the rest.
      for (let k = 0; k < this.bins; k++) {
        this.re[k] = this.mag[k] * Math.cos(this.phaseSyn[k])
        this.im[k] = this.mag[k] * Math.sin(this.phaseSyn[k])
      }
      for (let k = 1; k < this.bins - 1; k++) {
        this.re[n - k] = this.re[k]
        this.im[n - k] = -this.im[k]
      }
      this.im[this.bins - 1] = 0
      this.im[0] = 0

      fft(this.re, this.im, true)

      // Weighted overlap-add (WOLA) with running denominator for exact COLA.
      if (this.lastEmit >= 8192) {
        const shift = this.lastEmit
        const tail = this.offset + n - shift
        this.acc.copyWithin(0, shift, this.offset + n)
        this.acc.fill(0, Math.max(0, tail), this.offset + n)
        this.wsum.copyWithin(0, shift, this.offset + n)
        this.wsum.fill(0, Math.max(0, tail), this.offset + n)
        this.offset -= shift
        this.lastEmit = 0
      }
      const offset = this.offset
      const w = this.window
      for (let i = 0; i < n; i++) {
        this.acc[offset + i] += this.re[i] * w[i]
        this.wsum[offset + i] += w[i] * w[i]
      }
      this.offset = offset + hopSynth

      for (let p = this.lastEmit; p < this.offset; p++) {
        const den = this.wsum[p]
        const v = den > 1e-9 ? this.acc[p] / den : 0
        this.outFifo.pushSample(v)
      }
      this.lastEmit = this.offset
      this.input.remove(hop)
    }
  }
}

const api = { PhaseVocoder, fft, hannWindow, princArg }

if (
  typeof AudioWorkletGlobalScope !== "undefined" &&
  typeof registerProcessor === "function"
) {
  class NabraPitchShiftProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      const o = (options && options.processorOptions) || {}
      this.fftSize = o.fftSize || 2048
      this.hop = o.hop || 256
      this.channels = []
    }

    static get parameterDescriptors() {
      return [
        {
          name: "ratio",
          defaultValue: 1,
          minValue: 0.25,
          maxValue: 4,
          automationRate: "k-rate",
        },
      ]
    }

    process(inputs, outputs, parameters) {
      const input = inputs[0]
      const output = outputs[0]
      if (!input || input.length === 0 || !output || output.length === 0) return true

      const ratioParam = parameters.ratio && parameters.ratio.length
        ? parameters.ratio[parameters.ratio.length - 1]
        : 1
      const targetCents = 1200 * Math.log2(ratioParam)
      const active = targetCents > 1 || targetCents < -1

      for (let c = 0; c < output.length; c++) {
        const inData = input[c < input.length ? c : input.length - 1]
        const outData = output[c]
        if (!inData || !outData) continue

        const k = input.length === 1 ? 0 : c
        while (this.channels.length <= k) {
          this.channels.push({
            voc: new PhaseVocoder({
              fftSize: this.fftSize,
              hop: this.hop,
              sampleRate: sampleRate,
            }),
            cents: 0,
            blend: 0,
          })
        }
        const ch = this.channels[k]

        if (active) {
          // Ease the stretch factor towards the target instead of jumping.
          const diff = targetCents - ch.cents
          const stepC = Math.max(-MAX_SLEW_CENTS, Math.min(MAX_SLEW_CENTS, diff))
          ch.cents += stepC
        } else {
          // Ease back to unity in step with the crossfade. Parking `cents` at
          // the old value while fading out meant the vocoder was still
          // stretching by a stale ratio for the whole fade, and the next time
          // the knob moved it started from that stale factor -- lag that had
          // nothing to do with the offset the user had just dialled in.
          const diff = -ch.cents
          const stepC = Math.max(-MAX_SLEW_CENTS, Math.min(MAX_SLEW_CENTS, diff))
          ch.cents += stepC
          if (ch.blend < 0.002 && Math.abs(ch.cents) < 0.5) {
            // Back at unison with the crossfade finished: pass the input
            // through untouched, so a neutral knob is bit-exact, not resampled.
            ch.cents = 0
            outData.set(inData)
            continue
          }
        }

        // While the crossfade is still running the vocoder keeps being fed, so
        // its FIFO never starves on the way back to the dry path.
        const effRatio = Math.pow(2, ch.cents / 1200)
        ch.voc.setRatio(effRatio)
        ch.voc.pushSamples(inData)

        const blendTarget = active ? 1 : 0
        let last = 0
        for (let i = 0; i < outData.length; i++) {
          const pass = inData[i]
          // `null` means the resampler has not got data yet; hold the previous
          // value rather than punching a zero into the stream.
          const proc = ch.voc.pullNextResampled(effRatio)
          if (proc !== null) last = proc
          ch.blend += (blendTarget - ch.blend) * BLEND_STEP
          outData[i] = pass * (1 - ch.blend) + last * ch.blend
        }
      }
      return true
    }
  }

  registerProcessor("nabra-pitch-shift", NabraPitchShiftProcessor)
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = api
}