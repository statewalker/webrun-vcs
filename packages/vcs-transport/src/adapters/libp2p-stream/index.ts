/**
 * libp2p stream adapter (duck-typed, no libp2p dependency): git's native protocol over a
 * stream opened with `/git/1.0.0`, libp2p 3's message streams and libp2p 1/2's
 * `source`/`sink` streams alike, the write side's end for the half-close.
 */

export * from "./libp2p-stream-duplex.js";
