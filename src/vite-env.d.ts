/// <reference types="vite/client" />

import type { NabraBridge } from "./nabra-bridge";

declare global {
  interface Window {
    nabra: NabraBridge;
  }
}

export {};
