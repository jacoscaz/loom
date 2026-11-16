import { fileURLToPath } from "node:url";

/** Absolute path to the compiled echo tool server fixture. */
export const ECHO_SERVER = fileURLToPath(new URL('./echo-server.js', import.meta.url));
