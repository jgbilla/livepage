export const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';
// Must be a different origin from the app. HTML blocks run there.
export const SANDBOX_URL = import.meta.env.VITE_SANDBOX_URL ?? 'http://localhost:5174';
