import rnnoiseWorkletSource from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?raw";

const absolute = (path: string): string => {
  if (typeof document !== "undefined" && document.baseURI) {
    return new URL(path, document.baseURI).href;
  }
  return path;
};

const isSimdSupported = async (): Promise<boolean> => {
  try {
    return await WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10,
        10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
};

const registeredContexts = new WeakSet<AudioContext>();

/**
 * Creates and registers the real-time AI RNNoise suppression node.
 * Runs in AudioWorklet on background audio thread with ~0% CPU.
 */
export async function createRnnoiseNode(
  ctx: AudioContext,
): Promise<AudioWorkletNode | null> {
  try {
    if (typeof AudioWorkletNode === "undefined" || !ctx.audioWorklet) {
      return null;
    }

    if (!registeredContexts.has(ctx)) {
      const blobUrl = URL.createObjectURL(
        new Blob([rnnoiseWorkletSource], { type: "application/javascript" }),
      );
      await ctx.audioWorklet
        .addModule(blobUrl)
        .finally(() => URL.revokeObjectURL(blobUrl));
      registeredContexts.add(ctx);
    }

    const hasSimd = await isSimdSupported();
    const wasmFile = hasSimd
      ? "rnnoise/rnnoise_simd.wasm"
      : "rnnoise/rnnoise.wasm";

    const response = await fetch(absolute(wasmFile));
    if (!response.ok) {
      console.warn(`تعذّر تحميل ملف rnnoise wasm: ${response.status}`);
      return null;
    }
    const wasmBinary = await response.arrayBuffer();

    const node = new AudioWorkletNode(
      ctx,
      "@sapphi-red/web-noise-suppressor/rnnoise",
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: "explicit",
        outputChannelCount: [1],
        processorOptions: {
          maxChannels: 1,
          wasmBinary,
        },
      },
    );

    return node;
  } catch (err) {
    console.warn("تعذّر تهيئة معالج الذكاء الاصطناعي RNNoise:", err);
    return null;
  }
}
