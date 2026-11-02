/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" runs the whole UI against in-memory fixtures (no backend). */
  readonly VITE_USE_MOCKS?: string;
  /** "browser" switches from hash routing to history routing (needs a server-side SPA fallback). */
  readonly VITE_ROUTER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
