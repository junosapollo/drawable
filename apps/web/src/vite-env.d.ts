/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LINESCOUT_SERVICES?: 'live' | 'fixture'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
