/**
 * ONNX Runtime Web publishes type declarations only for its root entry, and
 * its `exports` map hides even that from the `./wasm` subpath the app
 * actually loads. Rather than take a dependency on a `@types` package that
 * would drift from the bundled build, the subpath is declared as `unknown`
 * here and narrowed to a structural type in `vadAssets.ts`.
 *
 * Nothing outside that one file touches the runtime, so nothing else has to
 * pretend it knows the shape of a bundle we did not write.
 */
declare module "onnxruntime-web/wasm" {
  const ort: unknown;
  export default ort;
}
