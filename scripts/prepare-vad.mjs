/*
 * Stages the ONNX Runtime binaries next to the app, in `public/vad/`.
 *
 * They have to be plain files on disk rather than bundled imports for two
 * reasons, both measured on a packaged `file://` window:
 *
 *  - ONNX Runtime's package `exports` map does not expose `./dist/*`, so a
 *    `?url` import of the WebAssembly or of the glue module cannot resolve at
 *    all. Even behind `public/` the runtime still reaches them by URL.
 *  - The runtime dynamic-imports its own glue file relative to wherever the
 *    bundle ended up, which is never where the file lives once Vite has
 *    inlined the runtime into `assets/`. Serving both from a known path and
 *    pointing `wasmPaths` at it is the only arrangement that works.
 *
 * The glue and the WebAssembly are derived from `node_modules`, so they are
 * staged here and never committed -- 15 MB of build artifact in a repository
 * is a mistake that is very hard to undo. The model is not derived from
 * anything, is only 2.2 MB, and must exist for the app to run offline, so it
 * lives in `public/vad/` and is checked here rather than produced.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "vad");
const dist = path.join(root, "node_modules", "onnxruntime-web", "dist");

/**
 * sha256 of the pinned Silero v5.1.2 release.
 *
 * The file on Silero's `master` branch is the same size and scores 0.0031 on
 * genuine speech -- indistinguishable from silence -- so nothing but this
 * hash tells the two apart. `scripts/vad-test.mjs` asserts the same value
 * against the model the tests actually run.
 */
const MODEL_SHA256 =
  "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f";

const STAGED = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

function fail(message, hint) {
  console.error(`\n[prepare-vad] ${message}`);
  if (hint) console.error(`[prepare-vad] ${hint}`);
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });

// --- the model -------------------------------------------------------
// Committed, so this is a check rather than a build step. A wrong hash here
// means the file was replaced by hand and every voice in the app would go
// undetected, which is worth stopping the build over.
const model = path.join(out, "silero_vad.onnx");
if (!fs.existsSync(model)) {
  fail(
    "public/vad/silero_vad.onnx is missing",
    "Restore it from the repository, or fetch the pinned release:\n" +
      "  curl -L -o public/vad/silero_vad.onnx \\\n" +
      "    https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx",
  );
}
const digest = createHash("sha256").update(fs.readFileSync(model)).digest("hex");
if (digest !== MODEL_SHA256) {
  fail(
    `public/vad/silero_vad.onnx is not the pinned v5.1.2 model (sha256 ${digest})`,
    "Silero's master branch ships a file of the same size that never detects " +
      "speech. Re-fetch the release tagged v5.1.2.",
  );
}

// --- the runtime -----------------------------------------------------
for (const name of STAGED) {
  const source = path.join(dist, name);
  if (!fs.existsSync(source)) {
    fail(
      `${path.relative(root, source)} is missing`,
      "onnxruntime-web does not look installed. Run: npm install",
    );
  }
  const target = path.join(out, name);
  const wanted = fs.statSync(source).size;
  // Cheap freshness check: same size means the same build, and skipping keeps
  // a rebuild from touching files Vite has already copied into dist.
  if (fs.existsSync(target) && fs.statSync(target).size === wanted) continue;
  fs.copyFileSync(source, target);
  console.log(`[prepare-vad] staged ${name} (${(wanted / 1024 / 1024).toFixed(1)} MB)`);
}

// --- rnnoise wasm assets ---------------------------------------------
const rnnoiseOut = path.join(root, "public", "rnnoise");
const rnnoiseDist = path.join(root, "node_modules", "@sapphi-red", "web-noise-suppressor", "dist");
const RNNOISE_STAGED = ["rnnoise.wasm", "rnnoise_simd.wasm"];

fs.mkdirSync(rnnoiseOut, { recursive: true });
for (const name of RNNOISE_STAGED) {
  const source = path.join(rnnoiseDist, name);
  if (fs.existsSync(source)) {
    const target = path.join(rnnoiseOut, name);
    const wanted = fs.statSync(source).size;
    if (fs.existsSync(target) && fs.statSync(target).size === wanted) continue;
    fs.copyFileSync(source, target);
    console.log(`[prepare-vad] staged ${name} (${(wanted / 1024).toFixed(1)} KB)`);
  }
}

console.log("[prepare-vad] ok");
