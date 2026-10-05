/**
 * webrun-streams transport adapter.
 *
 * Bridges the transport's imperative object `Duplex` to the functional
 * `Duplex` of `@statewalker/webrun-streams`, letting the existing git protocol
 * engine run over a webrun-streams channel unchanged.
 */

export * from "./webrun-duplex.js";
