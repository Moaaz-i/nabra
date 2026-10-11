/**
 * Pitch-offset arithmetic: how far the voice has to move, how far it is
 * actually being moved, and what the tuner should read.
 *
 * Pulled out of `engine.ts` for two reasons. It is the part of the frame loop
 * that is easiest to get silently wrong -- a mismatch here shows up as a meter
 * that contradicts the audio rather than as an error -- and keeping it free of
 * the Web Audio graph and the worklet blob import means it can be tested
 * offline in Node.
 */
import { centsOff, hzToMidi, midiToHz, midiToName, snapMidi } from './notes'
import type { VoiceMode, VoiceScale } from './settings'

/** Largest offset adaptive mode will ever ask for; beyond this it sounds silly. */
export const MAX_ADAPTIVE_SEMITONES = 18
/** Largest offset the pitch stage accepts at all (the worklet param is 0.25x-4x). */
export const MAX_OFFSET_SEMITONES = 24
/**
 * Weight kept from the previous detection. The tail, 1 - DETECT_EMA = 0.26, is
 * what sets how far an octave error pulls the reported pitch.
 */
export const DETECT_EMA = 0.74

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value

/** The subset of `VoiceSettings` the offset maths needs. */
export type OffsetKnobs = {
  mode: VoiceMode
  scale: VoiceScale
  rootPc: number
  targetMidi: number
  manualSemitones: number
  smoothing: number
}

/** Carried between frames; both fields are mutated in place. */
export type OffsetTracker = {
  /**
   * Smoothed detection as a MIDI number, i.e. a log-frequency (cents) value.
   * `null` means the detector is not currently tracking a pitch.
   */
  smoothMidi: number | null
  /** The offset actually sent to the pitch stage, in semitones. */
  applied: number
}

export const newOffsetTracker = (): OffsetTracker => ({
  smoothMidi: null,
  applied: 0,
})

/**
 * Advance the detection smoother.
 *
 * The follower runs on the MIDI number rather than on hertz. A one-pole filter
 * on raw hertz lags in proportion to the frequency being tracked -- the same
 * 0.74/0.26 weights leave a low male voice roughly five times further behind
 * than a high female one -- so a single constant produced a sluggish adaptive
 * offset at the bottom of the range and a jumpy one at the top. In the log
 * domain the lag is a fixed number of cents at every pitch, and octave-error
 * spikes are attenuated exactly as much as before.
 *
 * A `null`/`hz <= 0` reading keeps the previous value: the caller is
 * responsible for declaring silence, and a single dropped frame should not
 * throw the follower across the range.
 */
export function smoothDetection(
  previousMidi: number | null,
  hz: number | null,
): number | null {
  if (hz == null || !Number.isFinite(hz) || hz <= 0) return previousMidi
  const midi = hzToMidi(hz)
  if (!Number.isFinite(midi)) return previousMidi
  if (previousMidi == null) return midi
  return previousMidi * DETECT_EMA + midi * (1 - DETECT_EMA)
}

/**
 * The note the tuner measures against, as a MIDI number.
 *
 * Adaptive mode has a real target: the chosen note, or the nearest degree of
 * the chosen scale. Manual mode has *no* target at all -- the offset is a fixed
 * number of semitones from wherever the voice already is -- so the honest
 * reference is the nearest semitone. Measuring manual mode against
 * `targetMidi` (a leftover from adaptive mode, C4 by default) made the app
 * report a large deviation and a non-unity ratio while it was applying no
 * shift whatsoever.
 */
export function referenceMidi(
  knobs: OffsetKnobs,
  detectedHz: number | null,
): number | null {
  if (detectedHz == null) return knobs.mode === 'adaptive' ? knobs.targetMidi : null
  if (knobs.mode === 'manual') return Math.round(hzToMidi(detectedHz))
  if (knobs.scale === 'chromatic') return knobs.targetMidi
  return snapMidi(hzToMidi(detectedHz), knobs.scale, knobs.rootPc)
}

export type OffsetReport = {
  /** The smoothed detection, in hertz; `null` while nothing is tracked. */
  detectedHz: number | null
  /** The note the tuner is measuring against, as a MIDI number. */
  referenceMidi: number | null
  referenceHz: number | null
  referenceNote: string
  /** The offset the knobs ask for, before the glide filter. */
  desiredSemitones: number
  /** The offset actually applied to the signal, in semitones. */
  appliedSemitones: number
  /** The frequency ratio actually applied; always `2 ** (applied / 12)`. */
  ratio: number
  /** Cents between the detected voice and the reference note. */
  cents: number
}

/**
 * One frame of the offset pipeline. Mutates `tracker` and returns everything
 * the frame reports.
 *
 * The three readouts are derived from a single number on purpose: `ratio` is
 * built from `appliedSemitones`, so the "offset" and "ratio" meters can never
 * disagree with the audio the way they did when the ratio was computed from the
 * detector instead of from the offset actually applied.
 */
export function stepOffset(
  tracker: OffsetTracker,
  knobs: OffsetKnobs,
  rawHz: number | null,
): OffsetReport {
  tracker.smoothMidi = smoothDetection(tracker.smoothMidi, rawHz)
  const detectedHz =
    tracker.smoothMidi == null ? null : midiToHz(tracker.smoothMidi)
  const ref = referenceMidi(knobs, detectedHz)

  let desired: number
  if (knobs.mode === 'adaptive') {
    if (detectedHz != null && ref != null) {
      desired = clamp(
        12 * Math.log2(midiToHz(ref) / detectedHz),
        -MAX_ADAPTIVE_SEMITONES,
        MAX_ADAPTIVE_SEMITONES,
      )
    } else {
      // Nothing detected: hold the last offset instead of returning to unison,
      // which would yank the voice back mid-phrase.
      desired = tracker.applied
    }
  } else {
    desired = clamp(
      knobs.manualSemitones,
      -MAX_OFFSET_SEMITONES,
      MAX_OFFSET_SEMITONES,
    )
  }

  const alpha = clamp(knobs.smoothing, 0.08, 0.9)
  tracker.applied = tracker.applied * (1 - alpha) + desired * alpha

  return {
    detectedHz,
    referenceMidi: ref,
    referenceHz: ref == null ? null : midiToHz(ref),
    referenceNote: ref == null ? '—' : midiToName(ref),
    desiredSemitones: desired,
    appliedSemitones: tracker.applied,
    ratio: 2 ** (tracker.applied / 12),
    cents:
      detectedHz != null && ref != null ? centsOff(detectedHz, ref) : 0,
  }
}
