/** This build of Baton. Shown by `baton --version`, sent to the team server, and bundled in issue reports. */
export const BATON_VERSION = "0.1.0-beta.1";

/**
 * Version of the daemon ↔ team server protocol (`/ingest`). Bump it whenever a
 * change means an older daemon or server can't talk to a newer one; both sides
 * refuse a mismatch with a "please update" error instead of failing quietly.
 */
export const INGEST_PROTOCOL_VERSION = 3;
