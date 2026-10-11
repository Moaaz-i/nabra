/**
 * Synthetic reverb impulse generation.
 *
 * The kernel lives outside the audio graph for two reasons. It is the one piece
 * of the engine that runs on the main thread in a burst, so it is worth being
 * able to measure; and the shape of a reverb tail has hard requirements (no DC,
 * silent at both ends, monotonically decaying) that are easy to break silently
 * and easy to assert offline.
 */

/** Length of the noise burst's fade-in, in seconds. */
export const IMPULSE_ATTACK_S = 0.006;
/** How long the tail takes to reach silence, in seconds. */
export const IMPULSE_RELEASE_S = 0.01;
/** Exponent of the decay envelope. */
export const IMPULSE_DECAY_POWER = 2.2;

/**
 * Resolution of the precomputed decay envelope. One point every 1024th of the
 * impulse; the curve is smooth, so linear interpolation between them is
 * accurate to about 3e-7 relative -- far below anything audible.
 */
const ENVELOPE_STEPS = 1024;

/**
 * `(1 - t) ^ IMPULSE_DECAY_POWER` sampled uniformly on [0, 1]. It does not
 * depend on the impulse length, so it is built once.
 */
const DECAY_ENVELOPE = (() => {
  const table = new Float32Array(ENVELOPE_STEPS + 1);
  for (let k = 0; k <= ENVELOPE_STEPS; k++) {
    table[k] = (1 - k / ENVELOPE_STEPS) ** IMPULSE_DECAY_POWER;
  }
  return table;
})();

/**
 * Fills one channel of a reverb impulse with noise under a decay envelope, and
 * returns the PRNG state so the next channel continues the sequence instead of
 * repeating it.
 *
 * The decay is read from a table rather than computed with `Math.pow` per
 * sample. `Math.pow` is the expensive part of this loop: at four seconds stereo
 * the direct form measured 12.5 ms of main-thread time, which is more than a
 * whole 60 fps frame, so dragging the reverb-time slider dropped frames.
 *
 * A running product (`env *= (1 - 1/length) ** power`) is not an equivalent
 * substitute: it approximates `(1 - t) ^ power` with a geometric curve, which
 * runs 1.5x louder through the middle of the tail. The table is exact.
 */
export function fillImpulse(
  out: Float32Array,
  seed: number,
  attack: number,
  release: number,
): number {
  const length = out.length;
  if (length < 1) return seed;
  const attackSamples = Math.max(1, Math.floor(attack));
  const releaseSamples = Math.max(1, Math.floor(release));
  const invAttack = 1 / attackSamples;
  const invRelease = 1 / Math.max(1, releaseSamples - 1);
  // First index of the release ramp, and the first index past it.
  const tail = Math.max(attackSamples, length - releaseSamples + 1);
  const envelopeScale = ENVELOPE_STEPS / length;

  let edge = 0;
  for (let i = 0; i < length; i++) {
    // xorshift32: a few hundred thousand draws per rebuild, so it stays off the
    // slow path in a way Math.random() does not.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    // The divisor is 2^31 - 1 and the result keeps the dividend's sign, so
    // this lands uniformly on [-1, 1) with no bias and no DC term.
    const noise = (seed / 0x7fffffff) % 1;

    if (i < attackSamples) {
      edge = i * invAttack;
    } else if (i < tail) {
      edge = 1;
    } else {
      // Ends at exactly zero on the final sample: a non-zero last sample is a
      // step discontinuity, i.e. a click on every tail.
      edge = (length - 1 - i) * invRelease;
      if (edge < 0) edge = 0;
    }

    const pos = i * envelopeScale;
    const k = pos | 0;
    const base = DECAY_ENVELOPE[k];
    const env =
      base + (DECAY_ENVELOPE[k + 1] - base) * (pos - (k | 0));
    out[i] = noise * env * edge;
  }
  return seed;
}

/** Sample counts for `fillImpulse` at a given sample rate. */
export function impulseEdges(sampleRate: number): {
  attack: number;
  release: number;
} {
  return {
    attack: Math.max(2, Math.floor(sampleRate * IMPULSE_ATTACK_S)),
    release: Math.max(2, Math.floor(sampleRate * IMPULSE_RELEASE_S)),
  };
}
