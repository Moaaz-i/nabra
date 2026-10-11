export const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

export function midiToName(midi: number): string {
  const rounded = Math.round(midi)
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12]
  const octave = Math.floor(rounded / 12) - 1
  return `${name}${octave}`
}

export function centsOff(hz: number, midi: number): number {
  return (hzToMidi(hz) - midi) * 100
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]

/**
 * Snaps a (possibly fractional) MIDI number to the nearest member of the
 * scale. A 7-note scale never has three excluded semitones in a row, so the
 * outward search below always finds a candidate within two semitones.
 *
 * A note exactly between two scale degrees is genuinely ambiguous, and ties
 * resolve upwards: consistent, and it means the quantiser never biases the
 * result downwards.
 */
export function snapMidi(
  midi: number,
  scale: 'chromatic' | 'major' | 'minor',
  rootPc: number,
): number {
  if (!Number.isFinite(midi)) return 0
  if (scale === 'chromatic') return Math.round(midi)
  const intervals = scale === 'major' ? MAJOR : MINOR
  const inScale = (candidate: number): boolean => {
    const pc = (((candidate - rootPc) % 12) + 12) % 12
    return intervals.includes(pc)
  }
  const anchor = Math.round(midi)
  if (inScale(anchor)) return anchor
  // Out of scale: measure the real distance to the neighbours rather than
  // assuming the upper one is right, otherwise a value just under an
  // out-of-scale note gets dragged a tone too far up.
  let best = anchor
  let bestDistance = Number.POSITIVE_INFINITY
  for (let d = 1; d <= 2; d++) {
    const up = anchor + d
    if (inScale(up)) {
      const distance = Math.abs(up - midi)
      if (distance <= bestDistance) {
        best = up
        bestDistance = distance
      }
    }
    const down = anchor - d
    if (inScale(down)) {
      const distance = Math.abs(down - midi)
      if (distance < bestDistance) {
        best = down
        bestDistance = distance
      }
    }
  }
  return best
}
