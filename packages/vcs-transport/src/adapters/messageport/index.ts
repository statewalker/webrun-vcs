/**
 * MessagePort adapter for git's native protocol.
 *
 * `messagePortDuplex` / `serveGitOverPort` (one session per port) and
 * `connectGitOverPortMux` / `serveGitOverPortMux` (many sessions per port) run on
 * webrun-rpc's stream tier: bounded in both directions, with a half-close. The older
 * `createMessagePortDuplex`, `messagePortFetch` and `messagePortServe` are deprecated.
 */

export * from "./messageport-duplex.js";
export * from "./messageport-fetch.js";
export * from "./messageport-git.js";
export * from "./messageport-serve.js";
