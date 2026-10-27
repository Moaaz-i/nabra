import * as Tone from "tone";
import { applyMicConstraints, isVirtualDevice, openMic } from "./devices";
import { fillImpulse, impulseEdges } from "./impulse";
import {
  Jungle,
  JUNGLE_LOW_LATENCY,
  JUNGLE_STANDARD,
  type JungleQuality,
  jungleLatencyMs,
} from "./jungle";
import { hzToMidi, midiToName } from "./notes";
import { MAX_OFFSET_SEMITONES, newOffsetTracker, stepOffset } from "./offset";
import pitchWorkletSource from "./pitchWorklet.cjs?raw";
import { defaultSettings, type VoiceSettings } from "./settings";
import {
  initialVadState,
  newVadState,
  stepVad,
  VAD_QUEUE_MAX,
  vadThresholds,
  type VadSession,
  type VadState,
} from "./vad";
import { loadVad } from "./vadAssets";
import { createRnnoiseNode } from "./rnnoiseAssets";
import vadWorkletSource from "./vadWorklet.cjs?raw";
import { detectPitch, rms, rmsToDb } from "./yin";
import {
  MicrophoneModeler,
  AnalogTubeWarmth,
  VocalAirExciter,
  StudioBoothIsolator,
} from "./studioProcessors";

const PV_LOW = { fftSize: 2048, hop: 256 };
const PV_STANDARD = { fftSize: 4096, hop: 512 };

const dbToGain = (db: number) => 10 ** (db / 20);

export { defaultSettings, sanitizeSettings } from "./settings";
export type {
  LatencyMode,
  VoiceMode,
  VoiceScale,
  VoiceSettings,
} from "./settings";

export type AnalysisFrame = {
  rms: number;
  rmsDb: number;
  outDb: number;
  peakDb: number;
  detectedHz: number | null;
  detectedNote: string;
  /** The note the tuner measures against: the target, or the nearest semitone. */
  referenceHz: number | null;
  referenceNote: string;
  /** The frequency ratio actually applied; always `2 ** (appliedSemitones / 12)`. */
  ratio: number;
  /** Cents between the detected voice and the reference note. */
  cents: number;
  appliedSemitones: number;
  agcGain: number;
  latencyMs: number;
  /** The part of `latencyMs` the pitch stage itself is responsible for. */
  pitchLatencyMs: number;
  sampleRate: number;
  clipping: boolean;
  bypass: boolean;
  sinkFallback: boolean;
  /** Silero's speech probability for the newest chunk, 0..1. */
  speechProb: number;
  /** The hysteresis-and-hangover decision derived from `speechProb`. */
  speaking: boolean;
  /** True while VAD is switched on *and* its model has finished loading. */
  vadActive: boolean;
  /** True when the anti-feedback limiter has ducked the monitor output. */
  feedbackDetected: boolean;
  /** True when real-time AI Neural Denoiser (RNNoise) is active */
  denoiserActive: boolean;
  /** True when Studio Broadcast Voice Enhancer is active */
  studioEnhancerActive: boolean;
};

// --- Automatic gain control -------------------------------------------------
/** The level AGC steers the input towards, measured after the AGC node. */
const AGC_TARGET_DB = -20;
/** Below this the input is treated as room tone: no correction is applied. */
const AGC_NOISE_FLOOR_DB = -55;
const AGC_MIN_DB = -12;
const AGC_MAX_DB = 12;
/** Asymmetric loop gains: gentle leveling that never ducks syllables or consonants. */
const AGC_K_DOWN = 0.08;
const AGC_K_UP = 0.04;

/** Detection is skipped below this level; there is no pitch to find. */
const DETECT_FLOOR_DB = -55;
/** Reverb impulses are rebuilt at most this often while a slider is dragged. */
const REVERB_DEBOUNCE_MS = 140;
/** Longest impulse response we will ever allocate (~4 s at 48 kHz stereo). */
const REVERB_MAX_SECONDS = 4;

/**
 * Control-loop timing.
 *
 * The loop runs on a timer rather than on `requestAnimationFrame`. A rAF loop
 * is tied to the compositor: it stops dead when the window is hidden or
 * minimised, and a voice changer is exactly the kind of app people run in the
 * background. When it stalled the whole control path stalled with it -- the
 * gate stopped closing, the AGC froze and adaptive mode kept applying the last
 * offset it had computed, however far the voice had since moved.
 */
const LOOP_INTERVAL_MS = 16;
/** Peak hold decay per 1/60 s. Kept as the old per-frame value on purpose. */
const PEAK_HOLD_DECAY = 0.96;
/** How long the gate stays open after the signal drops below the floor. */
const GATE_HOLD_S = 0.05;
/** How often the tuner runs a detection in manual mode. */
const DETECT_INTERVAL_S = 0.05;
/** Silence that lasts this long clears the tracked pitch. */
const QUIET_CLEAR_S = 0.034;

/**
 * Hysteresis on the dry/wet crossfade, in semitones of applied offset. The
 * higher "on" threshold is what stops the pitch stage being armed and disarmed
 * on every frame while the offset sits near zero.
 */
const WET_ENTER_SEMITONES = 0.14;
const WET_STAY_SEMITONES = 0.03;

/** Time constant used when ramping a mixer gain, in seconds. */
const MIX_RAMP_S = 0.02;

/**
 * Ramps a mixer gain instead of jumping it.
 *
 * Assigning `param.value` while the user drags a slider puts a step in the
 * waveform at every audio frame: a zipper artefact, and in the feedback paths
 * (delay, reverb) an audible tick per frame. Every gain on the output side goes
 * through here.
 */
function ramp(param: AudioParam | undefined, value: number, now: number) {
  if (!param) return;
  if (now <= 0) {
    // No context clock yet (or a closed one): set the target directly.
    param.value = value;
    return;
  }
  param.setTargetAtTime(value, now, MIX_RAMP_S);
}

export class VoiceRouter {
  readonly settings: VoiceSettings = defaultSettings();
  onFrame: ((frame: AnalysisFrame) => void) | null = null;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private jungle: Jungle | null = null;
  private toneWidener: Tone.StereoWidener | null = null;
  private pitchWorklet: AudioWorkletNode | null = null;
  private pvFft = 4096;
  private pvHop = 512;
  private nodes: AudioNode[] = [];
  private analyserIn: AnalyserNode | null = null;
  private analyserOut: AnalyserNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private rnnoiseNode: AudioWorkletNode | null = null;
  private airShelf: BiquadFilterNode | null = null;
  private inputGain: GainNode | null = null;
  private agcGain: GainNode | null = null;
  private preampGain: GainNode | null = null;
  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private dryTap: GainNode | null = null;
  private dryEffectsGain: GainNode | null = null;
  private processedGain: GainNode | null = null;
  private fxWetBus: GainNode | null = null;
  private highpass: BiquadFilterNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private lowShelf: BiquadFilterNode | null = null;
  private highShelf: BiquadFilterNode | null = null;
  private warmthShelf: BiquadFilterNode | null = null;
  private presencePeak: BiquadFilterNode | null = null;
  private deessPeak: BiquadFilterNode | null = null;
  private bodyPeak: BiquadFilterNode | null = null;
  private gateGain: GainNode | null = null;
  private jungleQuality: JungleQuality = JUNGLE_STANDARD;
  private compressor: DynamicsCompressorNode | null = null;
  private outputGain: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  /** Post-mute insertion point for the test tone (the limiter). */
  private toneSink: AudioNode | null = null;
  private distortion: WaveShaperNode | null = null;
  private preDistortionGain: GainNode | null = null;
  private postDistortionGain: GainNode | null = null;
  private delay: DelayNode | null = null;
  private delayFeedbackGain: GainNode | null = null;
  private delayWetGain: GainNode | null = null;
  private chorusDelay: DelayNode | null = null;
  private chorusLfo: OscillatorNode | null = null;
  private chorusDepthGain: GainNode | null = null;
  private chorusWetGain: GainNode | null = null;
  private reverbConvolver: ConvolverNode | null = null;
  private reverbWetGain: GainNode | null = null;
  private reverbSend: GainNode | null = null;
  // Character effects
  private robotOsc: OscillatorNode | null = null;
  private robotDryGain: GainNode | null = null;
  private robotWetGain: GainNode | null = null;
  private radioDryGain: GainNode | null = null;
  private radioWetGain: GainNode | null = null;
  // Legendary Studio processors
  private micModeler: MicrophoneModeler | null = null;
  private tubeWarmth: AnalogTubeWarmth | null = null;
  private vocalAirExciter: VocalAirExciter | null = null;
  private boothIsolator: StudioBoothIsolator | null = null;
  // Anti-Feedback protection
  private feedbackDuckUntil = 0;
  private feedbackDetected = false;
  private feedbackFrames = 0;
  private outputDeviceLabel = "";
  private sinkAudio: HTMLAudioElement | null = null;
  private gateLastOpen = false;
  private gateCloseAt = 0;
  private bleedCloseAt = 0;
  private timeIn: Float32Array<ArrayBuffer> | null = null;
  private timeOut: Float32Array<ArrayBuffer> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private offset = newOffsetTracker();
  private agcDb = 0;
  private lastDetectAt = 0;
  private quietSince = 0;
  private peakHold = 0;
  private outPeakHold = 0;
  private lastFrameAt = 0;
  private lastHoldAt = 0;
  private reverbTime = 0;
  private reverbTimer: ReturnType<typeof setTimeout> | null = null;
  private distortionAmount = -1;
  private sinkFallback = false;
  private wetActive = false;
  private wetPrimedAt: number | null = null;
  private latencyMode: VoiceSettings["latencyMode"] | null = null;

  // --- Voice activity detection --------------------------------------------
  private vadSession: VadSession | null = null;
  /** Resolves once, to the loaded session or to nothing if loading failed. */
  private vadLoad: Promise<VadSession | null> | null = null;
  /** Chunks the worklet has posted and inference has not consumed yet. */
  private vadQueue: Float32Array[] = [];
  /** True while a model call is in flight; keeps the LSTM fed in order. */
  private vadBusy = false;
  private vadState: VadState = initialVadState();

  get isRunning() {
    return this.running;
  }

  /**
   * The latency configuration actually in use, or `null` when stopped.
   *
   * `latencyMode` picks the vocoder's window and hop, and those are baked into
   * the worklet node when it is constructed, so changing the setting mid-run
   * does nothing. The UI uses this to say so instead of quietly lying.
   */
  get activeLatencyMode(): VoiceSettings["latencyMode"] | null {
    return this.running ? this.latencyMode : null;
  }

  /** True when the selected latency mode is not the one currently running. */
  get latencyModePending(): boolean {
    return this.running && this.latencyMode !== this.settings.latencyMode;
  }

  getAnalyser() {
    return this.analyserIn;
  }

  getOutputAnalyser() {
    return this.analyserOut;
  }

  getOutputStream(): MediaStream | null {
    return this.destination?.stream ?? null;
  }

  applySettings(partial: Partial<VoiceSettings>) {
    Object.assign(this.settings, partial);
    if ("echoCancellation" in partial || "noiseSuppression" in partial) {
      this.updateMicConstraints();
    }
    this.syncStaticNodes();
  }

  private updateMicConstraints() {
    if (!this.stream) return;
    applyMicConstraints(this.stream, {
      echoCancellation: this.settings.echoCancellation,
      noiseSuppression: this.settings.noiseSuppression,
    }).catch(() => {});
  }

  async start(inputId: string, outputId: string) {
    await this.stop();
    this.outputDeviceLabel = "";
    if (typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices) {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const found = devs.find((d) => d.deviceId === outputId);
        if (found) this.outputDeviceLabel = found.label;
      } catch {}
    }
    try {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      if (ctx.state === "suspended") await ctx.resume();

      const pvCfg = this.settings.latencyMode === "low" ? PV_LOW : PV_STANDARD;
      // The window/hop pair is fixed when the worklet node is built, so the
      // running configuration is recorded here and the UI compares against it.
      this.latencyMode = this.settings.latencyMode;
      let pitchWorklet: AudioWorkletNode | null = null;
      try {
        const blobUrl = URL.createObjectURL(
          new Blob([pitchWorkletSource], { type: "application/javascript" }),
        );
        await ctx.audioWorklet
          .addModule(blobUrl)
          .finally(() => URL.revokeObjectURL(blobUrl));
        pitchWorklet = new AudioWorkletNode(ctx, "nabra-pitch-shift", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          // A microphone is mono. Up-mixing to two channels before the vocoder
          // meant two phase vocoders running on bit-identical data: twice the
          // FFT cost, no difference in what came out. The worklet takes the one
          // channel and the rest of the chain is mono anyway.
          channelCount: 1,
          channelCountMode: "explicit",
          outputChannelCount: [1],
          processorOptions: { fftSize: pvCfg.fftSize, hop: pvCfg.hop },
        });
      } catch {
        pitchWorklet = null;
      }
      this.pvFft = pvCfg.fftSize;
      this.pvHop = pvCfg.hop;
      this.pitchWorklet = pitchWorklet;

      Tone.setContext(ctx);

      // VAD's own tap worklet. It only gathers and downsamples samples, so it
      // is cheap and always built; whether it is *used* is decided frame by
      // frame by the setting, which is what lets the toggle take effect
      // without restarting the routing.
      let vadNode: AudioWorkletNode | null = null;
      try {
        const blobUrl = URL.createObjectURL(
          new Blob([vadWorkletSource], { type: "application/javascript" }),
        );
        await ctx.audioWorklet
          .addModule(blobUrl)
          .finally(() => URL.revokeObjectURL(blobUrl));
        vadNode = new AudioWorkletNode(ctx, "nabra-vad-tap", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          // A microphone is mono, and up-mixing would only cost the resampler
          // two identical channels to walk.
          channelCount: 1,
          channelCountMode: "explicit",
          outputChannelCount: [1],
          // The worklet's own `sampleRate` global would do, but passing it
          // makes the rate the context actually opened at explicit, and keeps
          // the processor testable outside the worklet scope.
          processorOptions: { sampleRate: ctx.sampleRate },
        });
        vadNode.port.onmessage = (event: MessageEvent) => {
          const data: unknown = event.data;
          if (!(data instanceof Float32Array)) return;
          this.vadQueue.push(data);
          // Bounded on both ends. The worklet drops chunks it cannot post; the
          // engine drops the ones inference is never going to reach.
          while (this.vadQueue.length > VAD_QUEUE_MAX) this.vadQueue.shift();
        };
      } catch {
        vadNode = null;
      }

      let rnnoiseNode: AudioWorkletNode | null = null;
      try {
        rnnoiseNode = await createRnnoiseNode(ctx);
      } catch {
        rnnoiseNode = null;
      }
      this.rnnoiseNode = rnnoiseNode;

      this.stream = await openMic(inputId, {
        echoCancellation: this.settings.echoCancellation,
        noiseSuppression: this.settings.noiseSuppression,
      }).catch((err: unknown) => {
        const name = err instanceof DOMException ? err.name : "";
        if (name === "NotAllowedError") {
          throw new Error(
            "رُفض الوصول إلى المايك. اسمح للتطبيق باستخدام الميكروفون.",
          );
        }
        if (name === "NotFoundError") {
          throw new Error(
            "مايك الإدخال غير موجود. حدّث قائمة الأجهزة واختر مايكك الأصلي.",
          );
        }
        throw new Error(
          "تعذّر فتح المايك الأصلي. تأكد أنه غير مستخدم حصرياً من برنامج آخر.",
        );
      });

      const source = ctx.createMediaStreamSource(this.stream);
      const highpass = ctx.createBiquadFilter();
      const lowpass = ctx.createBiquadFilter();
      const inputGain = ctx.createGain();
      const preampGain = ctx.createGain();
      const agcGain = ctx.createGain();
      const gateGain = ctx.createGain();
      const analyserIn = ctx.createAnalyser();
      const dryGain = ctx.createGain();
      const wetGain = ctx.createGain();
      const dryTap = ctx.createGain();
      const warmthShelf = ctx.createBiquadFilter();
      const lowShelf = ctx.createBiquadFilter();
      const highShelf = ctx.createBiquadFilter();
      const presencePeak = ctx.createBiquadFilter();
      const airShelf = ctx.createBiquadFilter();
      const deessPeak = ctx.createBiquadFilter();
      const bodyPeak = ctx.createBiquadFilter();
      const compressor = ctx.createDynamicsCompressor();
      const processedGain = ctx.createGain();
      const mix = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      const outputGain = ctx.createGain();
      const analyserOut = ctx.createAnalyser();
      const monitorGain = ctx.createGain();
      const destination = ctx.createMediaStreamDestination();

      highpass.type = "highpass";
      highpass.Q.value = 0.7;
      lowpass.type = "lowpass";
      lowpass.Q.value = 0.7;
      warmthShelf.type = "lowshelf";
      warmthShelf.frequency.value = 180;
      lowShelf.type = "lowshelf";
      lowShelf.frequency.value = 280;
      highShelf.type = "highshelf";
      highShelf.frequency.value = 2400;
      presencePeak.type = "peaking";
      presencePeak.frequency.value = 2850;
      presencePeak.Q.value = 0.95;
      airShelf.type = "highshelf";
      airShelf.frequency.value = 11000;
      airShelf.gain.value = 0;
      deessPeak.type = "peaking";
      deessPeak.frequency.value = 6800;
      deessPeak.Q.value = 2.8;
      bodyPeak.type = "peaking";
      bodyPeak.frequency.value = 460;
      bodyPeak.Q.value = 1.4;
      gateGain.gain.value = 1;
      dryTap.gain.value = 0;
      // The pitch stage is crossfaded in by the analysis loop; start fully dry
      // so the very first frames do not play the signal twice.
      dryGain.gain.value = 1;
      wetGain.gain.value = 0;
      analyserIn.fftSize = 2048;
      analyserIn.smoothingTimeConstant = 0.18;
      analyserOut.fftSize = 1024;
      analyserOut.smoothingTimeConstant = 0.3;
      limiter.threshold.value = -0.8;
      limiter.knee.value = 3;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.16;

      // Studio room isolation & mic modeling
      const boothIsolator = new StudioBoothIsolator(ctx);
      const micModeler = new MicrophoneModeler(ctx);
      this.boothIsolator = boothIsolator;
      this.micModeler = micModeler;

      // Analog tube warmth & broadcast air exciter
      const tubeWarmth = new AnalogTubeWarmth(ctx);
      const vocalAirExciter = new VocalAirExciter(ctx);
      this.tubeWarmth = tubeWarmth;
      this.vocalAirExciter = vocalAirExciter;

      // Processed path: mic -> filters -> room de-mud -> mic modeling -> gain -> AGC -> gate -> pitch/EQ/dyn.
      source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(boothIsolator.input);
      boothIsolator.output.connect(micModeler.input);
      micModeler.output.connect(inputGain);
      inputGain.connect(preampGain);
      preampGain.connect(agcGain);
      agcGain.connect(analyserIn);
      if (vadNode) {
        // Tapped after the AGC and before the gate. The detector should judge
        // the same signal the rest of the chain is about to work on, at a
        // level that does not swing by 20 dB every time the user leans in or
        // away from the microphone -- and before the gate, so that closing the
        // gate cannot blind the thing deciding whether to close it.
        agcGain.connect(vadNode);
        // A worklet node only runs while something downstream is pulling it.
        // The processor outputs silence, so this reaches the destination
        // without adding anything to what is heard.
        vadNode.connect(ctx.destination);
      }
      analyserIn.connect(gateGain);
      gateGain.connect(dryGain);
      if (pitchWorklet) {
        gateGain.connect(pitchWorklet);
        pitchWorklet.connect(wetGain);
      } else {
        this.jungleQuality =
          this.settings.latencyMode === "low"
            ? JUNGLE_LOW_LATENCY
            : JUNGLE_STANDARD;
        const jungle = new Jungle(ctx, this.jungleQuality);
        this.jungle = jungle;
        gateGain.connect(jungle.input);
        jungle.output.connect(wetGain);
      }
      wetGain.connect(warmthShelf);
      dryGain.connect(warmthShelf);
      warmthShelf.connect(lowShelf);
      lowShelf.connect(bodyPeak);
      bodyPeak.connect(highShelf);
      highShelf.connect(presencePeak);
      presencePeak.connect(airShelf);
      airShelf.connect(deessPeak);
      deessPeak.connect(compressor);
      compressor.connect(tubeWarmth.input);
      tubeWarmth.output.connect(vocalAirExciter.input);
      vocalAirExciter.output.connect(processedGain);

      // Character effects: Robot Ring Modulator & Walkie-Talkie Radio
      const robotDryGain = ctx.createGain();
      const robotWetGain = ctx.createGain();
      robotDryGain.gain.value = 1;
      robotWetGain.gain.value = 0;
      const robotMod = ctx.createGain();
      const robotOsc = ctx.createOscillator();
      robotOsc.type = "sine";
      robotOsc.frequency.value = this.settings.robotRate;
      robotMod.gain.value = 0;
      robotOsc.connect(robotMod.gain);
      robotOsc.start();

      const characterBus = ctx.createGain();
      processedGain.connect(robotDryGain);
      robotDryGain.connect(characterBus);
      processedGain.connect(robotMod);
      robotMod.connect(robotWetGain);
      robotWetGain.connect(characterBus);

      const radioFilter = ctx.createBiquadFilter();
      radioFilter.type = "bandpass";
      radioFilter.frequency.value = 1600;
      radioFilter.Q.value = 1.2;
      const radioPeak = ctx.createBiquadFilter();
      radioPeak.type = "peaking";
      radioPeak.frequency.value = 2400;
      radioPeak.gain.value = 6;
      radioPeak.Q.value = 1.8;
      const radioDryGain = ctx.createGain();
      const radioWetGain = ctx.createGain();
      radioDryGain.gain.value = 1;
      radioWetGain.gain.value = 0;

      characterBus.connect(radioDryGain);
      radioDryGain.connect(mix);
      characterBus.connect(radioFilter);
      radioFilter.connect(radioPeak);
      radioPeak.connect(radioWetGain);
      radioWetGain.connect(mix);

      // True bypass: the untouched source, not the post-EQ tap it replaced.
      source.connect(dryTap);
      dryTap.connect(mix);

      const effectsBus = ctx.createGain();
      const fxWetBus = ctx.createGain();
      const dryEffectsGain = ctx.createGain();
      const preDistortionGain = ctx.createGain();
      const postDistortionGain = ctx.createGain();
      const distortion = ctx.createWaveShaper();

      const delay = ctx.createDelay(2);
      const delayFeedbackGain = ctx.createGain();
      const delayFilter = ctx.createBiquadFilter();
      const delayWetGain = ctx.createGain();

      const chorusDelay = ctx.createDelay(2);
      const chorusLfo = ctx.createOscillator();
      const chorusDepthGain = ctx.createGain();
      const chorusWetGain = ctx.createGain();

      const reverbConvolver = ctx.createConvolver();
      const reverbWetGain = ctx.createGain();
      const reverbSend = ctx.createGain();

      delay.delayTime.value = 0.32;
      delayFeedbackGain.gain.value = 0.3;
      delayFilter.type = "lowpass";
      delayFilter.frequency.value = 3500;

      distortion.oversample = "2x";

      chorusDelay.delayTime.value = 0.015;
      chorusLfo.type = "sine";
      chorusLfo.frequency.value = 1;
      chorusDepthGain.gain.value = 0.003;
      chorusLfo.connect(chorusDepthGain);
      chorusDepthGain.connect(chorusDelay.delayTime);
      chorusLfo.start();

      // Parallel send/return bus: the dry signal passes at unity and each
      // effect returns at its own mix level, so enabling an effect no longer
      // changes the reverb's character just to keep the sum in check.
      mix.connect(dryEffectsGain);
      dryEffectsGain.connect(effectsBus);
      mix.connect(preDistortionGain);
      preDistortionGain.connect(distortion);
      distortion.connect(postDistortionGain);
      postDistortionGain.connect(fxWetBus);

      mix.connect(delay);
      delay.connect(delayFilter);
      delayFilter.connect(delayWetGain);
      delayWetGain.connect(fxWetBus);
      delayFilter.connect(delayFeedbackGain);
      delayFeedbackGain.connect(delay);

      mix.connect(chorusDelay);
      chorusDelay.connect(chorusWetGain);
      chorusWetGain.connect(fxWetBus);

      mix.connect(reverbSend);
      reverbSend.connect(reverbConvolver);
      reverbConvolver.connect(reverbWetGain);
      reverbWetGain.connect(fxWetBus);

      fxWetBus.connect(effectsBus);
      effectsBus.connect(outputGain);

      // Professional 3D Stereo Widener via Tone.js
      const toneWidener = new Tone.StereoWidener(this.settings.stereoWidth);
      Tone.connect(outputGain, toneWidener);
      Tone.connect(toneWidener, limiter);
      this.toneWidener = toneWidener;

      limiter.connect(analyserOut);
      analyserOut.connect(destination);
      analyserOut.connect(monitorGain);
      monitorGain.connect(ctx.destination);

      this.nodes = [
        source,
        highpass,
        lowpass,
        airShelf,
        inputGain,
        preampGain,
        agcGain,
        gateGain,
        analyserIn,
        dryGain,
        wetGain,
        dryTap,
        warmthShelf,
        lowShelf,
        bodyPeak,
        highShelf,
        presencePeak,
        deessPeak,
        compressor,
        processedGain,
        characterBus,
        robotOsc,
        robotMod,
        robotDryGain,
        robotWetGain,
        radioFilter,
        radioPeak,
        radioDryGain,
        radioWetGain,
        mix,
        limiter,
        outputGain,
        analyserOut,
        monitorGain,
        destination,
        effectsBus,
        fxWetBus,
        dryEffectsGain,
        preDistortionGain,
        postDistortionGain,
        distortion,
        delay,
        delayFeedbackGain,
        delayFilter,
        delayWetGain,
        chorusDelay,
        chorusLfo,
        chorusDepthGain,
        chorusWetGain,
        reverbConvolver,
        reverbWetGain,
        reverbSend,
        ...(pitchWorklet ? [pitchWorklet] : []),
        ...(vadNode ? [vadNode] : []),
        ...(rnnoiseNode ? [rnnoiseNode] : []),
      ];

      const sinkAudio = new Audio();
      sinkAudio.autoplay = true;
      sinkAudio.srcObject = destination.stream;
      this.sinkFallback = false;
      const withSinkId = sinkAudio as HTMLAudioElement & {
        setSinkId?: (deviceId: string) => Promise<void>;
      };
      if (typeof withSinkId.setSinkId === "function") {
        try {
          await withSinkId.setSinkId(outputId);
        } catch {
          this.sinkFallback = true;
        }
      } else {
        this.sinkFallback = true;
      }
      try {
        await sinkAudio.play();
      } catch {
        this.sinkFallback = true;
      }

      this.analyserIn = analyserIn;
      this.analyserOut = analyserOut;
      this.destination = destination;
      this.airShelf = airShelf;
      this.inputGain = inputGain;
      this.preampGain = preampGain;
      this.agcGain = agcGain;
      this.gateGain = gateGain;
      this.dryGain = dryGain;
      this.wetGain = wetGain;
      this.dryTap = dryTap;
      this.processedGain = processedGain;
      this.fxWetBus = fxWetBus;
      this.highpass = highpass;
      this.lowpass = lowpass;
      this.lowShelf = lowShelf;
      this.highShelf = highShelf;
      this.warmthShelf = warmthShelf;
      this.presencePeak = presencePeak;
      this.deessPeak = deessPeak;
      this.bodyPeak = bodyPeak;
      this.compressor = compressor;
      this.outputGain = outputGain;
      this.monitorGain = monitorGain;
      this.toneSink = limiter;
      this.sinkAudio = sinkAudio;
      this.dryEffectsGain = dryEffectsGain;
      this.preDistortionGain = preDistortionGain;
      this.postDistortionGain = postDistortionGain;
      this.distortion = distortion;
      this.delay = delay;
      this.delayFeedbackGain = delayFeedbackGain;
      this.delayWetGain = delayWetGain;
      this.chorusDelay = chorusDelay;
      this.chorusLfo = chorusLfo;
      this.chorusDepthGain = chorusDepthGain;
      this.chorusWetGain = chorusWetGain;
      this.reverbConvolver = reverbConvolver;
      this.reverbWetGain = reverbWetGain;
      this.reverbSend = reverbSend;
      this.robotOsc = robotOsc;
      this.robotDryGain = robotDryGain;
      this.robotWetGain = robotWetGain;
      this.radioDryGain = radioDryGain;
      this.radioWetGain = radioWetGain;
      this.timeIn = new Float32Array(analyserIn.fftSize);
      this.timeOut = new Float32Array(analyserOut.fftSize);
      this.running = true;
      this.offset = newOffsetTracker();
      this.agcDb = 0;
      this.peakHold = 0;
      this.outPeakHold = 0;
      this.quietSince = 0;
      this.lastDetectAt = 0;
      this.lastHoldAt = 0;
      this.distortionAmount = -1;
      this.lastFrameAt = 0;
      this.wetActive = false;
      this.vadQueue = [];
      this.vadBusy = false;
      // The loaded model outlives a stop/start cycle -- it is 2 MB and takes
      // about a third of a second to prepare -- but its recurrent state does
      // not. That state is a memory of the previous microphone's noise floor,
      // and reusing it makes the first second of a new session read as speech
      // that is not there.
      this.vadSession?.reset();
      // Fresh start, fresh detector.
      this.vadState = initialVadState();
      this.reverbTime = 0;
      this.applyReverbImpulse(ctx, reverbConvolver, this.settings.reverbTime);
      this.syncStaticNodes();
      // A timer, not a rAF: see LOOP_INTERVAL_MS.
      this.tickTimer = setInterval(this.loop, LOOP_INTERVAL_MS);
      this.loop();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop() {
    this.running = false;
    this.outputDeviceLabel = "";
    this.feedbackFrames = 0;
    this.latencyMode = null;
    if (this.tickTimer != null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.reverbTimer) {
      clearTimeout(this.reverbTimer);
      this.reverbTimer = null;
    }
    this.sinkFallback = false;
    this.wetActive = false;
    this.wetPrimedAt = null;
    this.toneWidener?.dispose();
    this.toneWidener = null;
    this.jungle?.dispose();
    this.jungle = null;
    this.pitchWorklet = null;
    if (this.rnnoiseNode) {
      try { this.rnnoiseNode.port.postMessage("destroy"); } catch {}
      this.rnnoiseNode = null;
    }
    this.airShelf = null;
    // The session itself is deliberately kept: re-preparing the model on every
    // restart costs about a third of a second for no benefit. Only the audio
    // it has accumulated is thrown away, since the next session may be a
    // different microphone entirely.
    this.vadQueue = [];
    this.vadBusy = false;
    this.vadState = newVadState();
    for (const node of this.nodes) node.disconnect();
    this.nodes = [];
    this.analyserIn = null;
    this.analyserOut = null;
    this.destination = null;
    this.inputGain = null;
    this.preampGain = null;
    this.agcGain = null;
    this.gateGain = null;
    this.dryGain = null;
    this.wetGain = null;
    this.dryTap = null;
    this.fxWetBus = null;
    this.processedGain = null;
    this.highpass = null;
    this.lowpass = null;
    this.lowShelf = null;
    this.highShelf = null;
    this.warmthShelf = null;
    this.presencePeak = null;
    this.deessPeak = null;
    this.bodyPeak = null;
    this.compressor = null;
    this.outputGain = null;
    this.monitorGain = null;
    this.toneSink = null;
    this.dryEffectsGain = null;
    this.preDistortionGain = null;
    this.postDistortionGain = null;
    this.distortion = null;
    this.delay = null;
    this.delayFeedbackGain = null;
    this.delayWetGain = null;
    this.chorusDelay = null;
    this.chorusLfo = null;
    this.chorusDepthGain = null;
    this.chorusWetGain = null;
    this.reverbConvolver = null;
    this.reverbWetGain = null;
    this.reverbSend = null;
    if (this.robotOsc) {
      try { this.robotOsc.stop(); } catch {}
      this.robotOsc = null;
    }
    this.robotDryGain = null;
    this.robotWetGain = null;
    this.radioDryGain = null;
    this.radioWetGain = null;
    if (this.boothIsolator) {
      this.boothIsolator.dispose();
      this.boothIsolator = null;
    }
    if (this.micModeler) {
      this.micModeler.dispose();
      this.micModeler = null;
    }
    if (this.tubeWarmth) {
      this.tubeWarmth.dispose();
      this.tubeWarmth = null;
    }
    if (this.vocalAirExciter) {
      this.vocalAirExciter.dispose();
      this.vocalAirExciter = null;
    }
    this.feedbackDuckUntil = 0;
    this.feedbackDetected = false;
    this.feedbackFrames = 0;
    this.bleedCloseAt = 0;
    this.timeIn = null;
    this.timeOut = null;
    this.reverbTime = 0;
    this.distortionAmount = -1;
    if (this.sinkAudio) {
      this.sinkAudio.pause();
      this.sinkAudio.srcObject = null;
      this.sinkAudio = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.ctx) {
      await this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }

  async playTestTone() {
    // Inserted after `outputGain`: the tone's job is to prove the output
    // path works, and mute zeroes `outputGain`, so a tone wired before it
    // was silent exactly when someone was checking "why hear nothing".
    if (!this.ctx || !this.toneSink) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.16;
    osc.connect(gain);
    gain.connect(this.toneSink);
    osc.start();
    gain.gain.setTargetAtTime(0, this.ctx.currentTime + 0.45, 0.05);
    osc.stop(this.ctx.currentTime + 0.7);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  private applyPitch(semitones: number) {
    if (this.pitchWorklet && this.ctx) {
      const clamped = Math.max(
        -MAX_OFFSET_SEMITONES,
        Math.min(MAX_OFFSET_SEMITONES, semitones),
      );
      const param = (
        this.pitchWorklet.parameters as unknown as Map<string, AudioParam>
      ).get("ratio");
      ramp(param, 2 ** (clamped / 12), this.ctx.currentTime);
    } else {
      this.jungle?.setPitchSemitones(Math.max(-18, Math.min(18, semitones)));
    }
  }

  private syncStaticNodes() {
    const s = this.settings;
    const now = this.ctx?.currentTime ?? 0;
    const volume = s.muted ? 0 : s.outputGain;
    ramp(this.inputGain?.gain, s.inputGain, now);
    ramp(this.preampGain?.gain, s.micDrive, now);
    ramp(this.outputGain?.gain, volume, now);
    // If output is a virtual cable, sinkAudio sends to it continuously for Discord/Zoom.
    // If output is physical speakers/headphones, sinkAudio is muted so monitorGain is the sole
    // low-latency stream, completely preventing double-playback slapback echo and acoustic feedback loops.
    const isVirtual = this.outputDeviceLabel ? isVirtualDevice(this.outputDeviceLabel) : false;
    if (this.sinkAudio) {
      this.sinkAudio.muted = !isVirtual;
    }
    // Live local monitoring: sends processed voice to the user's default output/headphones
    ramp(this.monitorGain?.gain, s.muted ? 0 : (s.monitor ? 0.5 : 0), now);

    // Studio Broadcast Voice Enhancer (Warmth + Presence + Air + De-Esser)
    const enhancer = s.studioEnhancer;
    const targetWarmth = enhancer ? s.warmth + 1.2 : s.warmth;
    const targetPresence = enhancer ? s.presence + 1.5 : s.presence;
    const targetAir = enhancer ? 1.2 : 0;
    const targetDeess = enhancer ? Math.max(s.deess, 0.2) : s.deess;
    const targetHighpass = enhancer ? Math.max(s.highpassHz, 70) : s.highpassHz;

    if (this.highpass)
      this.highpass.frequency.setTargetAtTime(
        Math.max(20, targetHighpass),
        now,
        0.02,
      );
    if (this.lowpass)
      this.lowpass.frequency.setTargetAtTime(
        Math.min(20000, Math.max(1200, s.lowpassHz)),
        now,
        0.02,
      );
    if (this.lowShelf)
      this.lowShelf.gain.setTargetAtTime(-s.formant * 2.2, now, 0.02);
    if (this.highShelf)
      this.highShelf.gain.setTargetAtTime(s.formant * 2.2, now, 0.02);
    if (this.bodyPeak)
      this.bodyPeak.gain.setTargetAtTime(-s.formant * 1.3, now, 0.02);
    if (this.warmthShelf)
      this.warmthShelf.gain.setTargetAtTime(targetWarmth, now, 0.02);
    if (this.presencePeak)
      this.presencePeak.gain.setTargetAtTime(targetPresence, now, 0.02);
    if (this.airShelf)
      this.airShelf.gain.setTargetAtTime(targetAir, now, 0.02);
    if (this.deessPeak)
      this.deessPeak.gain.setTargetAtTime(-targetDeess * 14, now, 0.02);
    if (this.compressor) {
      // Fast, transparent vocal compression that does not pump or swallow following consonants
      const engaged = s.compress > 0.05;
      ramp(this.compressor.threshold, engaged ? -14 - s.compress * 10 : 0, now);
      ramp(this.compressor.ratio, engaged ? 1.4 + s.compress * 1.4 : 1, now);
      ramp(this.compressor.knee, engaged ? 8 : 0, now);
      if (engaged) {
        ramp(this.compressor.attack, 0.008, now);
        ramp(this.compressor.release, 0.06, now); // 60ms fast release prevents ducking consonants
      }
    }

    // Bypass swaps the whole chain for the untouched source. The pitch stage is
    // muted as well so the crossfade in the analysis loop cannot re-open it.
    const bypass = s.bypass;
    this.dryTap?.gain.setTargetAtTime(bypass ? 1 : 0, now, 0.03);
    this.processedGain?.gain.setTargetAtTime(bypass ? 0 : 1, now, 0.03);
    this.fxWetBus?.gain.setTargetAtTime(bypass ? 0 : 1, now, 0.03);

    ramp(this.reverbWetGain?.gain, Math.max(0, Math.min(1, s.reverbMix)), now);
    ramp(this.reverbSend?.gain, 1, now);
    ramp(this.chorusWetGain?.gain, Math.min(1, s.chorusMix), now);
    if (this.chorusLfo)
      this.chorusLfo.frequency.setTargetAtTime(
        Math.max(0.05, s.chorusRate),
        now,
        0.05,
      );
    if (this.chorusDelay)
      this.chorusDelay.delayTime.setTargetAtTime(0.015, now, 0.03);
    ramp(this.chorusDepthGain?.gain, s.chorusDepth * 0.006, now);
    ramp(this.delayWetGain?.gain, Math.min(1, s.delayMix), now);
    if (this.delay)
      this.delay.delayTime.setTargetAtTime(s.delayTime, now, 0.03);
    ramp(this.delayFeedbackGain?.gain, Math.min(0.9, s.delayFeedback), now);
    if (this.distortion)
      this.applyDistortionCurve(this.distortion, s.distortion);
    // A true dry/wet pair, not a send. The dry path is attenuated by exactly as
    // much as the distorted path is added, so the two sum to unity at every
    // position of the knob: dragging "التشويه" changes the character of the
    // voice without moving its level.
    const distortionWet = Math.max(0, Math.min(1, s.distortion));
    ramp(this.preDistortionGain?.gain, 1, now);
    ramp(this.postDistortionGain?.gain, distortionWet, now);
    ramp(this.dryEffectsGain?.gain, 1 - distortionWet, now);

    // Robot Voice (Ring Modulator)
    if (this.robotOsc) {
      this.robotOsc.frequency.setTargetAtTime(
        Math.max(20, Math.min(250, s.robotRate)),
        now,
        0.02,
      );
    }
    const robotWet = s.robotEnabled ? Math.max(0, Math.min(1, s.robotMix)) : 0;
    ramp(this.robotWetGain?.gain, robotWet, now);
    ramp(this.robotDryGain?.gain, 1 - robotWet * 0.8, now);

    // Tactical Walkie-Talkie Radio
    const radioWet = s.radioEnabled ? Math.max(0, Math.min(1, s.radioMix)) : 0;
    ramp(this.radioWetGain?.gain, radioWet, now);
    ramp(this.radioDryGain?.gain, 1 - radioWet, now);

    // 3D Stereo Widener via Tone.js
    if (this.toneWidener) {
      this.toneWidener.width.setTargetAtTime(Math.max(0, Math.min(1, s.stereoWidth)), now, 0.02);
    }

    // Legendary Studio Processors
    this.micModeler?.setModel(s.micModel, now);
    this.tubeWarmth?.setWarmth(s.tubeWarmth, now);
    this.vocalAirExciter?.setAir(s.vocalAir, now);
    this.boothIsolator?.setIsolation(s.boothIsolation, now);

    this.scheduleReverb(s.reverbTime);
  }

  /**
   * Rebuilding an impulse response allocates (and fills) a buffer of up to
   * ~4 s × 48 kHz × 2ch. Doing that on every tick of the reverb-time slider
   * locks the UI, so changes are coalesced into one rebuild once the user
   * stops dragging.
   */
  private scheduleReverb(seconds: number) {
    const clamped = Math.min(REVERB_MAX_SECONDS, Math.max(0.2, seconds));
    if (!this.reverbConvolver || !this.ctx) return;
    // A 50 ms deadband: dragging the slider inside it keeps the impulse already
    // built rather than rebuilding an identical one every 140 ms.
    if (Math.abs(clamped - this.reverbTime) < 0.05) return;
    if (this.reverbTimer) clearTimeout(this.reverbTimer);
    this.reverbTimer = setTimeout(() => {
      this.reverbTimer = null;
      if (!this.ctx || !this.reverbConvolver) return;
      this.applyReverbImpulse(this.ctx, this.reverbConvolver, clamped);
    }, REVERB_DEBOUNCE_MS);
  }

  private applyReverbImpulse(
    context: AudioContext,
    convolver: ConvolverNode,
    seconds: number,
  ) {
    const safe = Math.min(REVERB_MAX_SECONDS, Math.max(0.2, seconds));
    const length = Math.max(1, Math.floor(context.sampleRate * safe));
    const impulse = context.createBuffer(2, length, context.sampleRate);
    const { attack, release } = impulseEdges(context.sampleRate);
    // The noise seed is carried across the channels so they are decorrelated
    // rather than identical, and the two channel sums back to a wider tail
    // than a single burst would give.
    let seed = 0x2f6e2b1;
    for (let ch = 0; ch < impulse.numberOfChannels; ch++) {
      seed = fillImpulse(impulse.getChannelData(ch), seed, attack, release);
    }
    convolver.buffer = impulse;
    this.reverbTime = safe;
  }

  private applyDistortionCurve(shaper: WaveShaperNode, amount: number) {
    // The curve is identical for a given amount; rebuilding it on every slider
    // tick is pure garbage. Quantise so small drags do not miss the cache.
    const quantised = Math.round(Math.max(0, Math.min(1, amount)) * 100) / 100;
    if (quantised === this.distortionAmount) return;
    this.distortionAmount = quantised;
    const n = 1024;
    const curve = new Float32Array(n);
    const k = 1 + quantised * 4;
    // Normalised to a *unity small-signal slope* (tanh(kx)/k), not to a full
    // scale output (tanh(kx)/tanh(k)). The old normalisation had a slope of
    // k/tanh(k) -- 5.4x, i.e. +14.6 dB at full amount -- and it was then stacked
    // on top of a pre-distortion gain of 1 + amount*1.6. The presets landed
    // anywhere from +1.6 to +10.5 dB above "original" for the same voice, which
    // drove the limiter permanently into gain reduction and made every preset
    // sound louder rather than different. With a unity slope the wet path can
    // be mixed against the dry at a constant total level.
    for (let i = 0; i < n; i++) {
      const x = (i / n) * 2 - 1;
      curve[i] = k === 1 ? x : Math.tanh(k * x) / k;
    }
    shaper.curve = curve;
  }

  /**
   * Starts loading the model once, on the first frame that wants it.
   *
   * Not awaited. Routing starts immediately and behaves exactly as it did
   * before the model existed until it lands, because a third of a second of
   * silence on the mic is worse than a third of a second of the old
   * behaviour. A failed load is never retried: the realistic causes -- a
   * missing asset, a CSP that forbids WebAssembly -- do not fix themselves,
   * and retrying every 16 ms would turn a quiet failure into a busy one.
   */
  private ensureVad() {
    if (this.vadLoad) return;
    this.vadLoad = loadVad().then(
      (session) => {
        this.vadSession = session;
        return session;
      },
      () => null,
    );
  }

  /**
   * Consumes at most one queued chunk and folds its result into the decision.
   *
   * Inference is asynchronous and the loop is not, so the call is issued here
   * and its result lands a frame or so later. `vadBusy` is what keeps the
   * recurrent state fed in order -- a second call may not start until the
   * first has resolved -- and the queue between them absorbs the difference
   * between a chunk every 32 ms and a frame every 16 ms.
   */
  private drainVad(nowS: number) {
    if (this.settings.vadEnabled) this.ensureVad();
    const session = this.vadSession;
    if (!session) {
      // Nothing is ever going to read these, so letting them pile up would be
      // a slow leak with no reader. Discarding is also the right answer: the
      // model's state has to start on live audio, not on a backlog.
      if (this.vadQueue.length > 0) this.vadQueue.length = 0;
      return;
    }
    if (this.vadBusy) return;
    const chunk = this.vadQueue.shift();
    if (!chunk) return;
    this.vadBusy = true;
    void session
      .process(chunk)
      .then((prob) => {
        this.vadState = stepVad(
          this.vadState,
          prob,
          vadThresholds(this.settings.vadSensitivity),
          nowS,
        );
      })
      .catch(() => {
        // One failed call is not worth tearing the routing down over, and the
        // safe direction to fail in is the previous decision: it will not
        // silence a voice that is speaking.
      })
      .finally(() => {
        this.vadBusy = false;
      });
  }

  private loop = () => {
    if (!this.running || !this.analyserIn || !this.timeIn) return;
    // Everything below is expressed per *second*, not per frame. It used to be
    // written per frame, which meant the same settings behaved differently on a
    // 60 Hz and a 144 Hz display and changed again the moment the window was
    // hidden and the scheduler slowed the loop down. `dt` is the actual elapsed
    // time and every coefficient is scaled by it, so the physics is the same at
    // any frame rate.
    const now = this.ctx?.currentTime ?? 0;
    const dt = this.lastFrameAt
      ? Math.min(0.25, Math.max(0.001, now - this.lastFrameAt))
      : 1 / 60;
    this.lastFrameAt = now;

    // Voice activity is decided first, because almost everything that can be
    // made lazier downstream is gated on it: the gate, the AGC loop, the
    // detector, and whether the pitch stage belongs in the signal path at all.
    this.drainVad(now);
    const vadActive = this.settings.vadEnabled && this.vadSession != null;
    // Switched off, or still loading, reads as "everything is speech" -- which
    // is precisely what the app did before the model existed, and the reason a
    // model that fails to load is not worth an error message.
    const speaking = vadActive ? this.vadState.speaking : true;

    this.analyserIn.getFloatTimeDomainData(this.timeIn);
    const level = rms(this.timeIn);
    const rmsDb = rmsToDb(level);
    let peak = 0;
    for (let i = 0; i < this.timeIn.length; i++) {
      const a = Math.abs(this.timeIn[i] ?? 0);
      if (a > peak) peak = a;
    }
    // Peak hold decays at a fixed *rate per second* (PEAK_HOLD_DECAY at 60 fps)
    // rather than by a fixed amount per frame.
    const holdDt = this.lastHoldAt
      ? Math.min(0.25, Math.max(0.001, now - this.lastHoldAt))
      : dt;
    this.lastHoldAt = now;
    this.peakHold = Math.max(
      peak,
      this.peakHold * PEAK_HOLD_DECAY ** (holdDt * 60),
    );
    const peakDb = rmsToDb(this.peakHold);

    // AGC steers the *post*-AGC level towards AGC_TARGET_DB. The old logic
    // only ever ducked loud input and could not lift a quiet microphone, which
    // is the case AGC exists for.
    //
    // Frozen while the input is not speech. Room tone and a fan are exactly
    // what AGC is meant to ignore: steered towards the target they raise the
    // noise floor *to* it, and then every word after the pause is measured
    // against a background that has been amplified by as much as the room was
    // quieter than the voice.
    // AGC / Intelligent Vocal Rider steers the level towards target without pumping
    const riderActive = this.settings.vocalRider > 0.02;
    if ((this.settings.agc || riderActive) && rmsDb > AGC_NOISE_FLOOR_DB && speaking) {
      const targetDb = riderActive ? -18 : AGC_TARGET_DB;
      const error = targetDb - rmsDb;
      const speedMult = riderActive ? (0.6 + 0.4 * this.settings.vocalRider) : 1;
      const k = (error > 0 ? AGC_K_UP : AGC_K_DOWN) * speedMult;
      this.agcDb += error * (1 - (1 - k) ** (dt * 60));
      const maxRange = riderActive ? Math.max(AGC_MAX_DB, 10 * this.settings.vocalRider) : AGC_MAX_DB;
      const minRange = riderActive ? Math.min(AGC_MIN_DB, -10 * this.settings.vocalRider) : AGC_MIN_DB;
      this.agcDb = Math.max(minRange, Math.min(maxRange, this.agcDb));
    } else if (!this.settings.agc && !riderActive) {
      this.agcDb += (0 - this.agcDb) * Math.min(1, dt * 4);
    }
    this.agcGain?.gain.setTargetAtTime(
      dbToGain(this.agcDb),
      this.ctx?.currentTime ?? 0,
      riderActive ? 0.08 : 0.05,
    );

    if (this.settings.gateEnabled && this.gateGain) {
      let open: boolean;
      if (vadActive) {
        // Maintain smooth 350ms hangover so speech is never chopped between syllables
        if (speaking) {
          this.gateCloseAt = now + 0.35;
        }
        open = speaking || now < this.gateCloseAt;
      } else if (this.gateLastOpen) {
        // The hold used to be a countdown in frames, so a hidden window
        // stretched a 50 ms hold into several seconds. It is a deadline in
        // seconds now.
        if (rmsDb >= this.settings.gateThreshold - 6) {
          this.gateCloseAt = now + GATE_HOLD_S;
        }
        open =
          rmsDb >= this.settings.gateThreshold - 6 || now < this.gateCloseAt;
      } else {
        open = rmsDb >= this.settings.gateThreshold;
      }
      this.gateLastOpen = open;
      this.gateGain.gain.setTargetAtTime(
        open ? 1 : 0,
        this.ctx?.currentTime ?? 0,
        open ? 0.012 : 0.04,
      );
    } else {
      if (this.settings.speakerBleedShield && this.gateGain) {
        // Natural human speech contains inter-syllable pauses and quiet consonants.
        // Maintain a 350ms hang time so speech flows naturally without chopping.
        const speechActive = vadActive ? speaking : rmsDb >= this.settings.gateThreshold;
        if (speechActive) {
          this.bleedCloseAt = now + 0.35;
        }
        const open = speechActive || now < this.bleedCloseAt;
        this.gateGain.gain.setTargetAtTime(
          open ? 1 : 0.4,
          this.ctx?.currentTime ?? 0,
          open ? 0.02 : 0.08,
        );
      } else {
        this.gateGain?.gain.setTargetAtTime(1, this.ctx?.currentTime ?? 0, 0.02);
      }
      this.gateLastOpen = true;
      this.gateCloseAt = 0;
    }

    // Detection is the most expensive thing on this frame. Adaptive mode needs
    // it constantly; the tuner in manual mode does not, and silence is never
    // worth searching. The throttle is a deadline in seconds rather than a
    // "every third frame" counter, so it means the same thing at 60 fps and at
    // 144 fps.
    //
    // Not-speech counts as silence here. There is no pitch in room tone, and
    // searching for one is how a phantom note ends up on the tuner and drags
    // an adaptive target along with it.
    const audible = rmsDb > DETECT_FLOOR_DB && speaking;
    if (audible) this.quietSince = 0;
    else if (!this.quietSince) this.quietSince = now;
    const beenQuiet =
      this.quietSince > 0 && now - this.quietSince >= QUIET_CLEAR_S;
    const due = now - this.lastDetectAt >= DETECT_INTERVAL_S;
    const shouldDetect =
      audible && !beenQuiet && (this.settings.mode === "adaptive" || due);
    if (shouldDetect) this.lastDetectAt = now;
    const rawHz =
      this.ctx && shouldDetect
        ? detectPitch(this.timeIn, this.ctx.sampleRate, this.settings.detector)
        : null;
    // Do not let the tuner show a stale note from before the silence.
    if (beenQuiet) this.offset.smoothMidi = null;

    const offset = stepOffset(this.offset, this.settings, rawHz);
    const detectedHz = offset.detectedHz;
    const appliedSemitones = offset.appliedSemitones;

    const absApplied = Math.abs(appliedSemitones);
    let wetWanted: boolean;
    if (this.settings.bypass) {
      wetWanted = false;
    } else if (this.wetActive) {
      wetWanted = absApplied >= WET_STAY_SEMITONES;
    } else {
      wetWanted = absApplied > WET_ENTER_SEMITONES;
    }
    const pitchLatencyS = this.pitchWorklet
      ? (this.pvFft + this.pvHop) / (this.ctx?.sampleRate ?? 48000)
      : jungleLatencyMs(this.jungleQuality) / 1000;
    if (wetWanted && this.wetPrimedAt == null) {
      this.wetPrimedAt = now + pitchLatencyS;
    }
    if (!wetWanted) this.wetPrimedAt = null;
    if (this.wetPrimedAt != null && now < this.wetPrimedAt) wetWanted = false;
    const dryTarget = wetWanted ? 0 : 1;
    const fadeMs = 0.024;
    this.dryGain?.gain.setTargetAtTime(dryTarget, now, fadeMs);
    this.wetGain?.gain.setTargetAtTime(1 - dryTarget, now, fadeMs);
    this.wetActive = dryTarget < 0.5;
    const nearZero =
      (!this.wetActive && this.wetPrimedAt == null) || this.settings.bypass;
    if (!this.settings.bypass) this.applyPitch(appliedSemitones);

    let outDb = -96;
    let outPeak = 0;
    if (this.analyserOut && this.timeOut) {
      this.analyserOut.getFloatTimeDomainData(this.timeOut);
      outDb = rmsToDb(rms(this.timeOut));
      for (let i = 0; i < this.timeOut.length; i++) {
        const a = Math.abs(this.timeOut[i] ?? 0);
        if (a > outPeak) outPeak = a;
      }
    }
    this.outPeakHold = Math.max(
      outPeak,
      this.outPeakHold * PEAK_HOLD_DECAY ** (dt * 60),
    );

    // Anti-feedback loop protection: suppress screeching runaway acoustic loops
    let feedbackNow = false;
    if (this.settings.antiFeedback && this.settings.monitor) {
      // Sustained full-scale resonance (howl/screech): sustained peak > 0.98 with low crest factor
      const timeRms = rms(this.timeOut ?? new Float32Array(0));
      const crestFactorDb = outPeak > 0.001 ? 20 * Math.log10(outPeak / Math.max(0.0001, timeRms)) : 20;
      const sustainedPeak = outPeak > 0.98 && this.outPeakHold > 0.96;
      const isHowling = sustainedPeak && crestFactorDb < 3.5; // pure runaway resonance howling

      if (isHowling) {
        this.feedbackFrames++;
      } else {
        this.feedbackFrames = Math.max(0, this.feedbackFrames - 2);
      }

      if (this.feedbackFrames >= 20) { // sustained howling screech
        this.feedbackDuckUntil = now + 0.6;
      }

      if (now < this.feedbackDuckUntil) {
        feedbackNow = true;
        this.monitorGain?.gain.setTargetAtTime(0.25, this.ctx?.currentTime ?? 0, 0.05);
      } else if (this.feedbackDetected) {
        // Just recovered from feedback: restore monitor gain smoothly
        ramp(this.monitorGain?.gain, 0.5, this.ctx?.currentTime ?? 0);
      }
    }
    this.feedbackDetected = feedbackNow;

    const ctx = this.ctx;
    const audioLatency = ctx
      ? ((ctx.baseLatency || 0) +
          ((ctx as AudioContext & { outputLatency?: number }).outputLatency ||
            0)) *
        1000
      : 0;
    // The pitch delay only reaches the output while the wet path is carrying signal.
    const pitchLatency = nearZero ? 0 : pitchLatencyS * 1000;

    this.onFrame?.({
      rms: level,
      rmsDb,
      outDb,
      peakDb,
      detectedHz,
      detectedNote: detectedHz ? midiToName(hzToMidi(detectedHz)) : "—",
      referenceHz: offset.referenceHz,
      referenceNote: offset.referenceNote,
      // Under bypass the pitch stage is not in the signal path at all, so the
      // applied offset is zero however far the knob is turned. Reporting the
      // requested offset here contradicted the audio and broke the invariant
      // the panel advertises: ratio is always 2 ** (applied / 12).
      ratio: this.settings.bypass ? 1 : offset.ratio,
      cents: offset.cents,
      appliedSemitones: this.settings.bypass ? 0 : appliedSemitones,
      agcGain: dbToGain(this.agcDb),
      latencyMs: Math.round((audioLatency + pitchLatency) * 10) / 10,
      pitchLatencyMs: Math.round(pitchLatency * 10) / 10,
      sampleRate: ctx?.sampleRate ?? 48000,
      clipping: this.peakHold > 0.99 || this.outPeakHold > 0.99,
      bypass: this.settings.bypass,
      sinkFallback: this.sinkFallback,
      speechProb: this.vadState.prob,
      speaking,
      vadActive,
      feedbackDetected: this.feedbackDetected,
      denoiserActive: this.settings.aiDenoiser && this.rnnoiseNode != null,
      studioEnhancerActive: this.settings.studioEnhancer,
    });
  };
}
