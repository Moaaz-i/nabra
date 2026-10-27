/**
 * The voice-settings schema: field types, defaults, and validation.
 *
 * Kept separate from `engine.ts` so the schema can be validated without
 * pulling in the Web Audio graph or the worklet blob import.
 */

export type VoiceMode = "adaptive" | "manual";
export type VoiceScale = "chromatic" | "major" | "minor";
export type LatencyMode = "standard" | "low";
export type PitchMethodChoice = "auto" | "yin" | "mcm";

export type VoiceSettings = {
  mode: VoiceMode;
  targetMidi: number;
  scale: VoiceScale;
  rootPc: number;
  manualSemitones: number;
  formant: number;
  inputGain: number;
  micDrive: number;
  outputGain: number;
  muted: boolean;
  smoothing: number;
  monitor: boolean;
  bypass: boolean;
  highpassHz: number;
  lowpassHz: number;
  deess: number;
  presence: number;
  warmth: number;
  compress: number;
  agc: boolean;
  reverbMix: number;
  reverbTime: number;
  chorusMix: number;
  chorusRate: number;
  chorusDepth: number;
  delayMix: number;
  delayTime: number;
  delayFeedback: number;
  distortion: number;
  detector: PitchMethodChoice;
  gateEnabled: boolean;
  gateThreshold: number;
  /**
   * Runs the Silero voice-activity model on the input. Speech is shifted,
   * everything else -- a fan, a game, someone typing -- is passed through
   * untouched, and the noise gate follows the model instead of loudness.
   */
  vadEnabled: boolean;
  /** 0 = strict, 1 = permissive. Maps onto the model's probability axis. */
  vadSensitivity: number;
  latencyMode: LatencyMode;
  /** Acoustic Echo Cancellation: removes speaker playback sound leaking into mic */
  echoCancellation: boolean;
  /** Noise Suppression: cuts ambient fans, background hum and room noise */
  noiseSuppression: boolean;
  /** Real-time Neural AI Noise Suppression (RNNoise) */
  aiDenoiser: boolean;
  /** Neural AI Denoiser Blend (0 = dry, 1 = 100% full neural isolation) */
  aiDenoiserMix: number;
  /** Studio Broadcast Voice Enhancer (Broadcast warmth, clarity air, vocal de-esser) */
  studioEnhancer: boolean;
  /** Anti-Feedback: auto-ducks and caps runaway audio loops when monitor is active */
  antiFeedback: boolean;
  /** Speaker Bleed Shield: suppresses background speaker leakage during pauses */
  speakerBleedShield: boolean;
  /** Robot / Cyber Voice Ring Modulator */
  robotEnabled: boolean;
  robotMix: number;
  robotRate: number;
  /** Walkie-Talkie / Tactical Radio bandpass effect */
  radioEnabled: boolean;
  radioMix: number;
  /** 3D Stereo Widener effect (0 = mono, 1 = max spatial width) */
  stereoWidth: number;
};

export const defaultSettings = (): VoiceSettings => ({
  mode: "manual",
  targetMidi: 60,
  scale: "chromatic",
  rootPc: 0,
  manualSemitones: 0,
  formant: 0,
  inputGain: 1,
  micDrive: 1,
  outputGain: 1,
  muted: false,
  smoothing: 0.32,
  monitor: false,
  bypass: false,
  highpassHz: 40,
  lowpassHz: 18000,
  deess: 0.05,
  presence: 1,
  warmth: 0.5,
  compress: 0.12,
  agc: false,
  reverbMix: 0,
  reverbTime: 1.4,
  chorusMix: 0,
  chorusRate: 1,
  chorusDepth: 0.3,
  delayMix: 0,
  delayTime: 0.32,
  delayFeedback: 0.3,
  distortion: 0,
  detector: "auto",
  gateEnabled: false,
  gateThreshold: -48,
  // On by default because it removes work rather than adding it: without it
  // every loud non-speech sound in the room -- a fan, a keyboard, a game in
  // the next window -- is fed to the pitch shifter as though it were a voice
  // and comes out as warble. Toggling it off restores the old behaviour
  // exactly, including when the model cannot be loaded at all.
  vadEnabled: true,
  vadSensitivity: 0.5,
  latencyMode: "standard",
  echoCancellation: false,
  noiseSuppression: false,
  aiDenoiser: false,
  aiDenoiserMix: 1,
  studioEnhancer: false,
  antiFeedback: true,
  speakerBleedShield: false,
  robotEnabled: false,
  robotMix: 0.8,
  robotRate: 60,
  radioEnabled: false,
  radioMix: 0.85,
  stereoWidth: 0,
});

/**
 * Accepted range of every numeric knob. Settings arrive from three untrusted
 * places (localStorage, imported preset files, hand-edited JSON) and
 * out-of-range values are not harmless: a `reverbTime` of 30 000 would try to
 * allocate a multi-gigabyte impulse response and take the process down.
 */
export const SETTING_RANGES = {
  targetMidi: [24, 96],
  rootPc: [0, 11],
  manualSemitones: [-24, 24],
  formant: [-12, 12],
  inputGain: [0, 8],
  micDrive: [0.25, 8],
  outputGain: [0, 4],
  smoothing: [0.08, 0.9],
  highpassHz: [20, 300],
  lowpassHz: [1200, 20000],
  deess: [0, 1],
  presence: [-12, 12],
  warmth: [-12, 12],
  compress: [0, 1],
  reverbMix: [0, 1],
  reverbTime: [0.2, 4],
  chorusMix: [0, 1],
  chorusRate: [0.05, 8],
  chorusDepth: [0, 1],
  delayMix: [0, 1],
  delayTime: [0.01, 1.9],
  delayFeedback: [0, 0.9],
  distortion: [0, 1],
  gateThreshold: [-80, -20],
  vadSensitivity: [0, 1],
  aiDenoiserMix: [0, 1],
  robotMix: [0, 1],
  robotRate: [20, 250],
  radioMix: [0, 1],
  stereoWidth: [0, 1],
} as const satisfies Partial<
  Record<keyof VoiceSettings, readonly [number, number]>
>;

export const SETTING_ENUMS = {
  mode: ["adaptive", "manual"],
  scale: ["chromatic", "major", "minor"],
  detector: ["auto", "yin", "mcm"],
  latencyMode: ["standard", "low"],
} as const satisfies Partial<
  Record<keyof VoiceSettings, readonly string[]>
>;

export const SETTING_FLAGS = [
  "muted",
  "monitor",
  "bypass",
  "agc",
  "gateEnabled",
  "vadEnabled",
  "echoCancellation",
  "noiseSuppression",
  "aiDenoiser",
  "studioEnhancer",
  "antiFeedback",
  "speakerBleedShield",
  "robotEnabled",
  "radioEnabled",
] as const satisfies readonly (keyof VoiceSettings)[];

export const clampSetting = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

/**
 * Coerces an arbitrary object into a valid, in-range `VoiceSettings`. Unknown
 * keys are dropped and unusable values fall back to the default, so a corrupt
 * or hand-edited file can never reach the audio graph.
 */
export function sanitizeSettings(input: unknown): VoiceSettings {
  const out = defaultSettings();
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const raw = input as Record<string, unknown>;

  for (const key of Object.keys(SETTING_RANGES) as (keyof typeof SETTING_RANGES)[]) {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const [min, max] = SETTING_RANGES[key];
    out[key] = clampSetting(value, min, max) as never;
  }
  for (const key of Object.keys(SETTING_ENUMS) as (keyof typeof SETTING_ENUMS)[]) {
    const value = raw[key];
    if (typeof value !== "string") continue;
    if ((SETTING_ENUMS[key] as readonly string[]).includes(value)) {
      out[key] = value as never;
    }
  }
  for (const key of SETTING_FLAGS) {
    const value = raw[key];
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}
