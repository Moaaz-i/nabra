import type { MicModel } from "./settings";

/**
 * Generates an asymmetric tube saturation curve mimicking a 12AX7 vacuum tube triode.
 * Combines 2nd harmonic (warmth/even) and 3rd harmonic (punch/odd) distortion.
 */
export function createTubeCurve(samples = 1024): Float32Array {
  const curve = new Float32Array(samples);
  const n = samples - 1;
  for (let i = 0; i < samples; i++) {
    const x = (i / n) * 2 - 1;
    // Asymmetric soft-clipping with even & odd harmonics
    if (x < -1) {
      curve[i] = -1;
    } else if (x > 1) {
      curve[i] = 1;
    } else {
      // Triode transfer function with subtle warmth
      const linear = 1.35 * x;
      const cubic = -0.35 * Math.pow(x, 3);
      const evenHarmonic = 0.14 * (x * Math.abs(x) - Math.pow(x, 3));
      curve[i] = Math.max(-1, Math.min(1, linear + cubic + evenHarmonic));
    }
  }
  return curve;
}

/**
 * Microphone Emulation Processor:
 * Re-shapes incoming microphone frequency response to match legendary broadcast & studio microphones.
 */
export class MicrophoneModeler {
  readonly input: GainNode;
  readonly output: GainNode;
  private lowShelf: BiquadFilterNode;
  private midPeak: BiquadFilterNode;
  private highShelf: BiquadFilterNode;

  constructor(ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.lowShelf = ctx.createBiquadFilter();
    this.midPeak = ctx.createBiquadFilter();
    this.highShelf = ctx.createBiquadFilter();

    this.lowShelf.type = "lowshelf";
    this.midPeak.type = "peaking";
    this.highShelf.type = "highshelf";

    // Clean initial state (flat)
    this.lowShelf.gain.value = 0;
    this.midPeak.gain.value = 0;
    this.highShelf.gain.value = 0;

    this.input.connect(this.lowShelf);
    this.lowShelf.connect(this.midPeak);
    this.midPeak.connect(this.highShelf);
    this.highShelf.connect(this.output);
  }

  setModel(model: MicModel, now: number) {
    const ramp = (param: AudioParam, target: number) => {
      param.setTargetAtTime(target, now, 0.03);
    };

    switch (model) {
      case "sm7b":
        // Shure SM7B: Proximity broadcast bass, scooped lower-mids, smooth broadcast presence peak
        this.lowShelf.frequency.value = 220;
        ramp(this.lowShelf.gain, 3.2);
        this.midPeak.frequency.value = 850;
        this.midPeak.Q.value = 1.2;
        ramp(this.midPeak.gain, -1.8);
        this.highShelf.frequency.value = 4800;
        ramp(this.highShelf.gain, 3.8);
        break;

      case "u87":
        // Neumann U87: Silky high-end sheen, focused vocal core, controlled low-end
        this.lowShelf.frequency.value = 90;
        ramp(this.lowShelf.gain, -1.2);
        this.midPeak.frequency.value = 3200;
        this.midPeak.Q.value = 1.3;
        ramp(this.midPeak.gain, 2.2);
        this.highShelf.frequency.value = 10500;
        ramp(this.highShelf.gain, 4.2);
        break;

      case "re20":
        // Electro-Voice RE20: Legendary Variable-D broadcast radio punch, controlled bass, clear intelligibility
        this.lowShelf.frequency.value = 180;
        ramp(this.lowShelf.gain, 1.4);
        this.midPeak.frequency.value = 2800;
        this.midPeak.Q.value = 1.1;
        ramp(this.midPeak.gain, 3.0);
        this.highShelf.frequency.value = 13000;
        ramp(this.highShelf.gain, -1.8);
        break;

      case "c414":
        // AKG C414: Pristine acoustic air, transparent open top, tight extended lows
        this.lowShelf.frequency.value = 110;
        ramp(this.lowShelf.gain, 1.2);
        this.midPeak.frequency.value = 5200;
        this.midPeak.Q.value = 1.0;
        ramp(this.midPeak.gain, 2.5);
        this.highShelf.frequency.value = 12000;
        ramp(this.highShelf.gain, 4.6);
        break;

      case "none":
      default:
        // Pure transparent neutral passthrough
        ramp(this.lowShelf.gain, 0);
        ramp(this.midPeak.gain, 0);
        ramp(this.highShelf.gain, 0);
        break;
    }
  }

  dispose() {
    this.input.disconnect();
    this.lowShelf.disconnect();
    this.midPeak.disconnect();
    this.highShelf.disconnect();
    this.output.disconnect();
  }
}

/**
 * Analog Tube Warmth & Harmonic Saturation Processor:
 * Infuses dry, sterile digital microphone signals with velvety analog richness.
 */
export class AnalogTubeWarmth {
  readonly input: GainNode;
  readonly output: GainNode;
  private shaper: WaveShaperNode;
  private dryGain: GainNode;
  private wetGain: GainNode;
  private preGain: GainNode;
  private postGain: GainNode;

  constructor(ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.preGain = ctx.createGain();
    this.postGain = ctx.createGain();

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = createTubeCurve(2048) as unknown as Float32Array<ArrayBuffer>;
    this.shaper.oversample = "2x";

    this.preGain.gain.value = 1.25;
    this.postGain.gain.value = 0.8;

    // Dry path
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);

    // Wet saturated path
    this.input.connect(this.preGain);
    this.preGain.connect(this.shaper);
    this.shaper.connect(this.postGain);
    this.postGain.connect(this.wetGain);
    this.wetGain.connect(this.output);

    this.setWarmth(0, 0);
  }

  setWarmth(amount: number, now: number) {
    const clamped = Math.max(0, Math.min(1, amount));
    const dry = 1 - clamped * 0.45;
    const wet = clamped * 0.9;
    this.dryGain.gain.setTargetAtTime(dry, now, 0.02);
    this.wetGain.gain.setTargetAtTime(wet, now, 0.02);
  }

  dispose() {
    this.input.disconnect();
    this.dryGain.disconnect();
    this.preGain.disconnect();
    this.shaper.disconnect();
    this.postGain.disconnect();
    this.wetGain.disconnect();
    this.output.disconnect();
  }
}

/**
 * Vocal Exciter & Air Harmonic Generator:
 * Adds commercial radio sheen and sparkling high-end breathiness (10k-18k) without sibilance.
 */
export class VocalAirExciter {
  readonly input: GainNode;
  readonly output: GainNode;
  private highpass: BiquadFilterNode;
  private exciterShaper: WaveShaperNode;
  private airGain: GainNode;

  constructor(ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    this.highpass = ctx.createBiquadFilter();
    this.highpass.type = "highpass";
    this.highpass.frequency.value = 9200;
    this.highpass.Q.value = 0.7;

    this.exciterShaper = ctx.createWaveShaper();
    // Soft high-frequency harmonic generation
    const exciterCurve = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      const x = (i / 511) * 2 - 1;
      exciterCurve[i] = Math.sin((x * Math.PI) / 2);
    }
    this.exciterShaper.curve = exciterCurve as unknown as Float32Array<ArrayBuffer>;
    this.exciterShaper.oversample = "2x";

    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;

    // Direct passthrough
    this.input.connect(this.output);

    // Harmonic air excitation injection
    this.input.connect(this.highpass);
    this.highpass.connect(this.exciterShaper);
    this.exciterShaper.connect(this.airGain);
    this.airGain.connect(this.output);
  }

  setAir(amount: number, now: number) {
    const clamped = Math.max(0, Math.min(1, amount));
    // Subtle, luxurious sheen (up to +6dB injected air)
    this.airGain.gain.setTargetAtTime(clamped * 1.8, now, 0.02);
  }

  dispose() {
    this.input.disconnect();
    this.highpass.disconnect();
    this.exciterShaper.disconnect();
    this.airGain.disconnect();
    this.output.disconnect();
  }
}

/**
 * Studio Booth Acoustic Isolation & De-Mud:
 * Cuts boxy room resonances (350-500 Hz) and room flutter slap so vocal sounds treated.
 */
export class StudioBoothIsolator {
  readonly input: GainNode;
  readonly output: GainNode;
  private mudNotch1: BiquadFilterNode;
  private mudNotch2: BiquadFilterNode;

  constructor(ctx: AudioContext) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    this.mudNotch1 = ctx.createBiquadFilter();
    this.mudNotch1.type = "peaking";
    this.mudNotch1.frequency.value = 420; // typical untreated bedroom boxiness
    this.mudNotch1.Q.value = 1.4;
    this.mudNotch1.gain.value = 0;

    this.mudNotch2 = ctx.createBiquadFilter();
    this.mudNotch2.type = "peaking";
    this.mudNotch2.frequency.value = 680; // hollow cardboard reflection
    this.mudNotch2.Q.value = 1.6;
    this.mudNotch2.gain.value = 0;

    this.input.connect(this.mudNotch1);
    this.mudNotch1.connect(this.mudNotch2);
    this.mudNotch2.connect(this.output);
  }

  setIsolation(amount: number, now: number) {
    const clamped = Math.max(0, Math.min(1, amount));
    this.mudNotch1.gain.setTargetAtTime(-clamped * 4.5, now, 0.02);
    this.mudNotch2.gain.setTargetAtTime(-clamped * 3.5, now, 0.02);
  }

  dispose() {
    this.input.disconnect();
    this.mudNotch1.disconnect();
    this.mudNotch2.disconnect();
    this.output.disconnect();
  }
}
