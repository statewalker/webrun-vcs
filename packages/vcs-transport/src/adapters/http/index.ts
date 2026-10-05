/**
 * HTTP Smart Protocol adapter for Git transport FSM.
 *
 * Implements the Git Smart HTTP protocol:
 * - GET /info/refs?service=git-upload-pack
 * - POST /git-upload-pack
 */

export * from "./http-client.js";
export * from "./http-duplex.js";
export * from "./http-server.js";
