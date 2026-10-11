/**
 * Lets the test scripts import app modules the way the bundler does.
 *
 * The source uses extensionless relative imports (`./settings`), which Vite
 * resolves but Node's ESM resolver does not. Rather than adding `.ts`
 * extensions to the app source purely for the tests, this hook retries a
 * failed relative resolution with a `.ts` suffix.
 *
 * Used via `node --import ./scripts/ts-hooks.mjs`.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        return next(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
