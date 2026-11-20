/**
 * Transport adapters for different communication channels.
 *
 * - http: For HTTP smart protocol (git-upload-pack, git-receive-pack)
 * - libp2p-stream: git's native protocol over a libp2p stream (duck-typed)
 * - messageport: git's native protocol over a MessagePort (webrun-rpc's stream tier)
 * - webrun: For @statewalker/webrun-streams functional-duplex channels
 * - webrun-http: For git smart-HTTP over a webrun-streams functional Duplex
 * - websocket: git's native protocol in WebSocket binary frames
 */

export * from "./http/index.js";
export * from "./libp2p-stream/index.js";
export * from "./messageport/index.js";
export * from "./webrun/index.js";
export * from "./webrun-http/index.js";
export * from "./websocket/index.js";
