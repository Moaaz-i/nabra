/**
 * Fetches ONNX Runtime Web and the Silero model, and hands back a session.
 *
 * This is the one file that knows where the binaries live, kept apart from
 * `vad.ts` so that everything testable stays free of browser and build-tool
 * imports.
 *
 * The files come out of `public/vad/`, staged there by
 * `scripts/prepare-vad.mjs` before every dev and build run, rather than being
 * imported from `node_modules`. Three separate things force that, and all
 * three were measured on a packaged `file://` window rather than assumed:
 *
 *  - ONNX Runtime's package `exports` map does not expose `./dist/*`, so a
 *    `?url` import of the WebAssembly or of the glue module cannot resolve.
 *  - Plain `fetch()` of a sibling file works under `file://`, but ONNX
 *    Runtime's *internal* fetch does not. It tries to load its own WebAssembly
 *    through the module loader and fails, so the bytes are read here and
 *    handed over with `wasmBinary`.
 *  - Compiling WebAssembly counts as executing a script, so the built page's
 *    CSP needs `'wasm-unsafe-eval'`. Without it the runtime reports "no
 *    available backend" and the only sign of it is a voice changer that has
 *    quietly stopped shifting anything.
 *
 * The glue module (`ort-wasm-simd-threaded.mjs`, a 26 KB ESM shim) is the
 * reason for the explicit paths at all: the runtime dynamic-imports it
 * relative to wherever its own bundle ended up, which after Vite has inlined
 * that bundle into `assets/` is not where the file is. `wasmPaths.mjs`
 * redirects that import to a URL that does exist.
 */
import { createVad, type VadOrt, type VadSession } from "./vad";

/**
 * Resolves a served path to an absolute URL.
 *
 * Relative paths here resolve against the document, which is the server root
 * in dev and `dist/` in the packaged app, where `vad/` sits beside `index.html`.
 * The runtime needs absolute URLs because it imports and fetches them from
 * inside its own bundled chunk, whose base is neither of those.
 */
const absolute = (path: string): string => new URL(path, document.baseURI).href;

/** Reads an asset the runtime cannot read for itself. */
const readBytes = async (path: string): Promise<Uint8Array> => {
  const response = await fetch(absolute(path));
  if (!response.ok) throw new Error(`تعذّر تحميل الملف: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** The only parts of the runtime this file touches beyond `VadOrt`. */
type OrtWasmEnv = {
  numThreads?: number;
  proxy?: boolean;
  wasmPaths?: { mjs: string; wasm: string };
  wasmBinary?: Uint8Array;
};
type OrtRuntime = VadOrt & { env: { wasm: OrtWasmEnv } };

export type { VadSession };

/**
 * Loads the model once per routing session and returns a session ready for
 * chunks. Rejects rather than degrading: the caller falls back to running
 * without VAD, which is exactly how the app behaved before the model existed.
 */
export async function loadVad(): Promise<VadSession> {
  const ort = (await import("onnxruntime-web/wasm")) as unknown as OrtRuntime;

  // One thread, no proxy worker. The packaged window is not cross-origin
  // isolated, so shared memory across a worker boundary is unavailable; asking
  // for it anyway produces a runtime that fails to initialise.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  // Both of these are resolved by the runtime from inside its bundled chunk,
  // where neither file exists.
  ort.env.wasm.wasmPaths = {
    mjs: absolute("vad/ort-wasm-simd-threaded.mjs"),
    wasm: absolute("vad/ort-wasm-simd-threaded.wasm"),
  };
  ort.env.wasm.wasmBinary = await readBytes("vad/ort-wasm-simd-threaded.wasm");

  return createVad(ort, await readBytes("vad/silero_vad.onnx"));
}
