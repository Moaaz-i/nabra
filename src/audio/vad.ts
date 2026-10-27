/**
 * Voice-activity detection: the decision layer around the Silero ONNX model.
 *
 * Deliberately free of Vite `?url` asset imports and of any top-level ONNX
 * Runtime import, so the whole path -- thresholds, hangover, and the real
 * model -- runs under Node in `scripts/vad-test.mjs` exactly the way the rest
 * of the DSP does. Fetching and wiring the model lives in `vadAssets.ts`.
 *
 * Why a model at all: the noise gate measures loudness, so anything loud
 * opens it -- a fan, a keyboard, a game in the next window -- and those
 * non-speech signals were then being fed to the pitch shifter as though they
 * were a voice. The RMS threshold cannot tell them apart because they share a
 * spectrum with speech. Silero was trained on the difference instead.
 */

/** Silero's native input rate. Audio is resampled to this, never the reverse. */
export const VAD_SAMPLE_RATE = 16000;
/** One model call. 512 samples is 32 ms at 16 kHz -- the size Silero is trained on. */
export const VAD_CHUNK_SAMPLES = 512;

/**
 * How long a decided "speech" survives a gap in the probability, in seconds.
 * Word-internal gaps land around 100-250 ms. Much shorter and the gate chops
 * the stop consonant off the end of a word; much longer and room tone leaks
 * through between sentences.
 */
export const VAD_HANGOVER_S = 0.2;

/**
 * Chunks the engine keeps waiting for inference. At 32 ms per chunk this is
 * about 250 ms of audio: enough to ride out a scheduling hiccup, small enough
 * that the decision never trails the input by more than a perceptible beat,
 * and small enough that a backlog built up while the window was hidden is
 * over after three frames rather than replayed in full.
 */
export const VAD_QUEUE_MAX = 8;

export type VadThresholds = {
  /** Probability at which silence becomes speech. */
  open: number;
  /** Probability below which an already-open decision is abandoned. */
  close: number;
};

const clamp01 = (value: number) =>
  !Number.isFinite(value) ? 0 : value < 0 ? 0 : value > 1 ? 1 : value;

/**
 * Maps the 0..1 sensitivity knob onto the model's probability axis.
 *
 * Measured on the pinned Silero v5.1.2 model (`scripts/vad-test.mjs` asserts
 * these): real speech averages 0.87 and peaks at 1.00, while digital silence
 * averages 0.007, a pure tone 0.047 and white noise 0.059 with a 0.13 peak.
 * That leaves a very wide band of usable thresholds, which is why the whole
 * knob only has to move between 0.70 (strict: ignores faint or distant
 * voices) and 0.20 (permissive: catches a whisper across the room) -- below
 * 0.20 even the noise peak starts to read as speech.
 *
 * The close threshold is half the open one, giving hysteresis: a word that
 * trails off below 0.45 keeps the gate open down to 0.22 rather than
 * chatter-closing halfway through it.
 */
export function vadThresholds(sensitivity: number): VadThresholds {
  const open = 0.7 - 0.5 * clamp01(sensitivity);
  return { open, close: open * 0.5 };
}

export type VadState = {
  speaking: boolean;
  /** Audio-clock second after which a held-open decision drops. */
  holdUntil: number;
  /** The model's most recent speech probability, 0..1. */
  prob: number;
};

export const newVadState = (): VadState => ({
  speaking: false,
  holdUntil: 0,
  prob: 0,
});

/**
 * The state used before the model has produced its first decision.
 *
 * `speaking: true` with an already-expired deadline. The first
 * low-probability chunk closes it, but nothing closes it *before* that: a
 * detector that has not heard anything yet must not be allowed to silence the
 * routing that has just started, and the LSTM needs a moment of audio before
 * its first opinion is worth anything.
 */
export const initialVadState = (): VadState => ({
  speaking: true,
  holdUntil: 0,
  prob: 0,
});

/**
 * One step of the open/close state machine.
 *
 * Opening is immediate: the model already smooths its own output, and a
 * confirm-on-N-frames delay would be paid on the onset of every utterance,
 * which is the one place a voice changer cannot afford to be late. Closing is
 * the delayed half -- it waits for the probability to fall *and* for the
 * hangover to expire, so a pause between words is not heard as a gate.
 */
export function stepVad(
  state: VadState,
  prob: number,
  thresholds: VadThresholds,
  nowS: number,
  hangoverS: number = VAD_HANGOVER_S,
): VadState {
  const p = clamp01(prob);
  if (!state.speaking) {
    if (p < thresholds.open) return { speaking: false, holdUntil: 0, prob: p };
    return { speaking: true, holdUntil: nowS + hangoverS, prob: p };
  }
  if (p >= thresholds.close) {
    // Still voiced: push the deadline out. A rising probability is the only
    // thing allowed to extend it -- coasting on the deadline would stretch a
    // single voiced frame into an arbitrarily long open gate.
    return { speaking: true, holdUntil: nowS + hangoverS, prob: p };
  }
  if (nowS < state.holdUntil) return { ...state, prob: p };
  return { speaking: false, holdUntil: 0, prob: p };
}

/**
 * The slice of ONNX Runtime this module uses.
 *
 * Structural on purpose: the renderer loads the real ESM build, the tests
 * load the Node build, and neither should have to teach the other its types.
 */
export type VadOrt = {
  Tensor: new (
    type: "float32" | "int64",
    data: Float32Array | BigInt64Array,
    dims?: readonly number[],
  ) => unknown;
  InferenceSession: { create(bytes: Uint8Array): Promise<VadRawSession> };
};

type VadRawSession = {
  run(feeds: Record<string, unknown>): Promise<{
    output: { data: ArrayLike<number> };
    stateN: unknown;
  }>;
};

export type VadSession = {
  /** One 512-sample @16 kHz chunk in, speech probability out (0..1). */
  process(chunk: Float32Array): Promise<number>;
  /** Clears the recurrent state; call when routing restarts. */
  reset(): void;
};

/**
 * Wraps a loaded Silero session in the chunk-accurate interface the engine
 * wants, carrying the LSTM's recurrent state across calls.
 *
 * The state is the model's memory of the last few seconds of audio. It is why
 * a model that hears the lead-in to a word can score a word that starts in
 * silence, and it is why it must be reset on restart: reusing a state built
 * from a different microphone's noise floor makes the first second of a new
 * session read as speech that is not there.
 */
export async function createVad(
  ort: VadOrt,
  modelBytes: Uint8Array,
): Promise<VadSession> {
  const session = await ort.InferenceSession.create(modelBytes);
  // Silero takes the sample rate as a tensor, not as a parameter, and takes it
  // as int64 -- an int32 tensor is rejected outright.
  const sr = new ort.Tensor(
    "int64",
    BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]),
    [],
  );
  const freshState = () =>
    new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  let state: unknown = freshState();
  return {
    async process(chunk: Float32Array): Promise<number> {
      const input = new ort.Tensor("float32", chunk, [1, VAD_CHUNK_SAMPLES]);
      const out = await session.run({ input, state, sr });
      state = out.stateN;
      const value = out.output.data[0];
      return typeof value === "number" && Number.isFinite(value)
        ? clamp01(value)
        : 0;
    },
    reset() {
      state = freshState();
    },
  };
}
