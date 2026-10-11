/**
 * Delay-based live pitch shifter (Jungle), adapted from Chris Wilson's
 * Web Audio delay-modulation voice transpose.
 */

export type JungleQuality = {
  delayTime: number;
  fadeTime: number;
  bufferTime: number;
};

export const JUNGLE_STANDARD: JungleQuality = {
  delayTime: 0.1,
  fadeTime: 0.05,
  bufferTime: 0.1,
};

export const JUNGLE_LOW_LATENCY: JungleQuality = {
  delayTime: 0.055,
  fadeTime: 0.028,
  bufferTime: 0.055,
};

export const JUNGLE_BASE_LATENCY_MS = (JUNGLE_STANDARD.delayTime + JUNGLE_STANDARD.fadeTime) * 1000

export function jungleLatencyMs(quality: JungleQuality): number {
  return (quality.delayTime + quality.fadeTime) * 1000
}

function createFadeBuffer(
  context: AudioContext,
  activeTime: number,
  fadeTime: number,
): AudioBuffer {
  const length1 = Math.floor(activeTime * context.sampleRate)
  const length2 = Math.floor((activeTime - 2 * fadeTime) * context.sampleRate)
  const length = length1 + length2
  const buffer = context.createBuffer(1, Math.max(length, 1), context.sampleRate)
  const data = buffer.getChannelData(0)
  const fadeLength = fadeTime * context.sampleRate
  const fadeIndex1 = fadeLength
  const fadeIndex2 = length1 - fadeLength

  for (let i = 0; i < length; i++) {
    let value = 1
    if (i < fadeIndex1) {
      value = Math.sqrt(i / fadeLength)
    } else if (i >= fadeIndex2) {
      value = Math.sqrt(1 - (i - fadeIndex2) / fadeLength)
    }
    data[i] = value
  }
  return buffer
}

function createDelayTimeBuffer(
  context: AudioContext,
  activeTime: number,
  fadeTime: number,
  shiftUp: boolean,
): AudioBuffer {
  const length1 = Math.floor(activeTime * context.sampleRate)
  const length2 = Math.floor((activeTime - 2 * fadeTime) * context.sampleRate)
  const length = length1 + length2
  const buffer = context.createBuffer(1, Math.max(length, 1), context.sampleRate)
  const data = buffer.getChannelData(0)

  for (let i = 0; i < length; i++) {
    data[i] = shiftUp ? (length1 - i) / length : i / length1
  }
  return buffer
}

export class Jungle {
  readonly input: GainNode
  readonly output: GainNode
  private readonly context: AudioContext
  private readonly mod1Gain: GainNode
  private readonly mod2Gain: GainNode
  private readonly mod3Gain: GainNode
  private readonly mod4Gain: GainNode
  private readonly modGain1: GainNode
  private readonly modGain2: GainNode
  private readonly delayTime: number
  private readonly sources: AudioBufferSourceNode[] = []

  constructor(context: AudioContext, quality: JungleQuality = JUNGLE_STANDARD) {
    this.context = context
    this.delayTime = quality.delayTime
    this.input = context.createGain()
    this.output = context.createGain()

    this.mod1Gain = context.createGain()
    this.mod2Gain = context.createGain()
    this.mod3Gain = context.createGain()
    this.mod4Gain = context.createGain()
    this.mod3Gain.gain.value = 0
    this.mod4Gain.gain.value = 0

    this.modGain1 = context.createGain()
    this.modGain2 = context.createGain()

    const down = createDelayTimeBuffer(context, quality.bufferTime, quality.fadeTime, false)
    const up = createDelayTimeBuffer(context, quality.bufferTime, quality.fadeTime, true)
    const fade = createFadeBuffer(context, quality.bufferTime, quality.fadeTime)

    const mod1 = this.loopSource(down)
    const mod2 = this.loopSource(down)
    const mod3 = this.loopSource(up)
    const mod4 = this.loopSource(up)

    mod1.connect(this.mod1Gain)
    mod2.connect(this.mod2Gain)
    mod3.connect(this.mod3Gain)
    mod4.connect(this.mod4Gain)

    this.mod1Gain.connect(this.modGain1)
    this.mod2Gain.connect(this.modGain2)
    this.mod3Gain.connect(this.modGain1)
    this.mod4Gain.connect(this.modGain2)

    const maxDelay = Math.max(1, quality.delayTime * 5)
    const delay1 = context.createDelay(maxDelay)
    const delay2 = context.createDelay(maxDelay)
    delay1.delayTime.value = quality.delayTime
    delay2.delayTime.value = quality.delayTime
    this.modGain1.connect(delay1.delayTime)
    this.modGain2.connect(delay2.delayTime)

    const fade1 = context.createGain()
    const fade2 = context.createGain()
    const mix1 = this.loopSource(fade)
    const mix2 = this.loopSource(fade)
    mix1.connect(fade1.gain)
    mix2.connect(fade2.gain)

    this.input.connect(delay1)
    this.input.connect(delay2)
    delay1.connect(fade1)
    delay2.connect(fade2)
    fade1.connect(this.output)
    fade2.connect(this.output)

    const t = context.currentTime + 0.05
    const t2 = t + quality.bufferTime - quality.fadeTime
    mod1.start(t)
    mod2.start(t2)
    mod3.start(t)
    mod4.start(t2)
    mix1.start(t)
    mix2.start(t2)

    this.setPitchOffset(0)
  }

  setPitchSemitones(semitones: number) {
    this.setPitchOffset(semitones / 12)
  }

  setPitchOffset(octaves: number) {
    const up = octaves > 0
    this.mod1Gain.gain.value = up ? 0 : 1
    this.mod2Gain.gain.value = up ? 0 : 1
    this.mod3Gain.gain.value = up ? 1 : 0
    this.mod4Gain.gain.value = up ? 1 : 0
    const amount = Math.min(Math.abs(octaves), 1.5)
    const now = this.context.currentTime
    this.modGain1.gain.setTargetAtTime(this.delayTime * amount, now, 0.015)
    this.modGain2.gain.setTargetAtTime(this.delayTime * amount, now, 0.015)
  }

  dispose() {
    for (const source of this.sources) {
      try {
        source.stop()
        source.disconnect()
      } catch {
        // already stopped
      }
    }
    this.input.disconnect()
    this.output.disconnect()
  }

  private loopSource(buffer: AudioBuffer): AudioBufferSourceNode {
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.loop = true
    this.sources.push(source)
    return source
  }
}