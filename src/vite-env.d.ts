/// <reference types="vite/client" />

import type { NabraBridge } from "../../electron/preload";

declare global {
  interface Window {
    nabra: NabraBridge;
  }
}

export {};