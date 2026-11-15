/**
 * The fetch client: one implementation of git's fetch-pack (negotiation, shallow, tags, ref
 * updates) over protocol v2 or v0, with I/O adapters for smart HTTP and duplex streams.
 */

export * from "./completeness.js";
export * from "./connection.js";
export * from "./fetch-pack.js";
export * from "./fetch-remote.js";
export * from "./negotiator.js";
export * from "./pkt-stream.js";
export * from "./ref-updates.js";
