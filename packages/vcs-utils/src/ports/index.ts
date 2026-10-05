/**
 * Port-based RPC communication utilities.
 *
 * Provides a simple request/response pattern over MessagePort,
 * as well as bidirectional streaming capabilities for complex communication patterns.
 */

// Bidirectional call/listen with streaming
export {
  type CallBidiOptions,
  type CallBidiParams,
  callBidi,
} from "./call-bidi.js";
export { type CallPortOptions, callPort } from "./call-port.js";
// Core RPC primitives
export { deserializeError, type SerializedError, serializeError } from "./errors.js";
// Bidirectional I/O
export { ioHandle } from "./io-handle.js";
export { ioSend } from "./io-send.js";
export {
  type BidiAcceptor,
  type BidiParams,
  listenBidi,
} from "./listen-bidi.js";
export { type ListenPortOptions, listenPort, type PortHandler } from "./listen-port.js";
export { receive } from "./receive.js";
// Iterator-based streaming
export {
  type MessageHandler,
  type MessageParams,
  receiveIterator,
} from "./receive-iterator.js";
export { send } from "./send.js";
export { sendIterator } from "./send-iterator.js";
