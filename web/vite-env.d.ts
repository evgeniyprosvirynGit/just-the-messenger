/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISABLE_REALTIME?: string;
  readonly VITE_DEMO_MODE?: string;
  readonly VITE_MAPTILER_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
