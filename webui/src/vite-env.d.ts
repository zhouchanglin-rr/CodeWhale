/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL for the runtime API. Empty/undefined => same-origin (dev proxy). */
  readonly VITE_RUNTIME_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
