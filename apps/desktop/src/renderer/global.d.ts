import type { AcedApi } from "../ipc.js";

declare global {
  interface Window {
    /** API exposed by the preload bridge (see preload.ts / ipc.ts). */
    aced: AcedApi;
  }
}

export {};
