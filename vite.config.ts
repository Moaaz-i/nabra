import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

/**
 * Injects a Content-Security-Policy into the built index.html only. Dev mode
 * is skipped on purpose: Vite's react-refresh preamble is an inline script
 * and HMR needs a websocket, both of which a strict CSP would block.
 *
 * Notes on each directive:
 * - `script-src 'self' blob: 'wasm-unsafe-eval'` — the bundle is external
 *   files; the audio worklet processors are registered from blob: URLs, so
 *   blobs must pass; and ONNX Runtime compiles WebAssembly at runtime, which
 *   CSP counts as executing a script. `'wasm-unsafe-eval'` is the keyword that
 *   permits exactly that and nothing more -- `'unsafe-eval'` would also hand
 *   the page `eval()`, which nothing here needs or should have.
 * - `style-src ... 'unsafe-inline'` — React sets style attributes inline.
 * - `img/media/connect 'self'` + `data:/blob:` — local assets, the inline
 *   favicon, and in-page media object URLs. Nothing third-party: the update
 *   check runs in the main process and fonts are self-hosted.
 * - `object-src 'none'` — no plugins, ever.
 */
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' blob: 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return {
    name: 'nabra-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      )
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [
    cspPlugin(),
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
      },
      preload: {
        input: 'electron/preload.ts',
        vite: {
          build: {
            rolldownOptions: {
              // The package is `"type": "module"`, so the plugin names the
              // preload `preload.mjs` and Electron loads it through Node's ESM
              // loader -- where the plugin's default CommonJS output dies on
              // `require is not defined` and `window.nabra` is never exposed.
              // Emit real ESM so the `.mjs` preload actually loads.
              output: { format: 'esm' },
            },
          },
        },
      },
    }),
  ],
})
