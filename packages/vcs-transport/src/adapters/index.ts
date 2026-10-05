/**
 * Transport adapters for different communication channels.
 *
 * - messageport: For Web Workers and in-browser communication
 * - http: For HTTP smart protocol (git-upload-pack, git-receive-pack)
 * - webrun: For @statewalker/webrun-streams functional-duplex channels
 * - webrun-http: For git smart-HTTP over a webrun-streams functional Duplex
 */

export * from "./http/index.js";
export * from "./messageport/index.js";
export * from "./webrun/index.js";
export * from "./webrun-http/index.js";
