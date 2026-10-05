/**
 * MessagePort adapter for Git transport FSM.
 *
 * Provides Git fetch operations over MessagePort channels,
 * useful for in-browser client-server communication via
 * Web Workers or SharedWorkers.
 */

export * from "./messageport-duplex.js";
export * from "./messageport-fetch.js";
export * from "./messageport-serve.js";
