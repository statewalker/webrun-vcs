/**
 * Fetch FSM type definitions.
 */

/**
 * Fetch FSM client events.
 */
export type ClientFetchEvent =
  | "START"
  | "REFS_RECEIVED"
  | "EMPTY_REPO"
  | "WANTS_SENT"
  | "WANTS_SENT_NO_SHALLOW"
  | "WANTS_SENT_FILTER"
  | "NO_WANTS"
  | "FILTER_SENT"
  | "SHALLOW_SENT"
  | "DEEPEN_SENT"
  | "SHALLOW_UPDATED"
  | "HAVES_SENT"
  | "NO_HAVES"
  | "ALL_HAVES_SENT"
  | "NAK"
  | "ACK_CONTINUE"
  | "ACK_COMMON"
  | "ACK_READY"
  | "ACK_SINGLE"
  | "ACK_FINAL"
  | "NAK_FINAL"
  | "MAX_HAVES"
  | "DONE_SENT"
  | "DONE_SENT_STATELESS"
  | "PACK_RECEIVED"
  | "SIDEBAND_ERROR"
  | "REFS_UPDATED"
  | "ERROR";

/**
 * Fetch FSM server events.
 */
export type ServerFetchEvent =
  | "START"
  | "REFS_SENT"
  | "EMPTY_REPO"
  | "WANTS_RECEIVED"
  | "WANTS_WITH_SHALLOW"
  | "WANTS_WITH_FILTER"
  | "NO_WANTS"
  | "VALID"
  | "INVALID_WANT"
  | "ERROR_SENT"
  | "FILTER_RECEIVED"
  | "SHALLOW_RECEIVED"
  | "NO_SHALLOW"
  | "SHALLOW_COMPUTED"
  | "SHALLOW_SENT"
  | "HAVES_RECEIVED"
  | "DONE_RECEIVED"
  | "FLUSH_RECEIVED"
  | "SENT_SINGLE_ACK"
  | "SENT_NAK_SINGLE"
  | "SENT_ACK_CONTINUE"
  | "SENT_NAK"
  | "SENT_ACK_COMMON"
  | "SENT_ACK_READY"
  | "CHECK_REACHABILITY"
  | "READY_TO_GIVE_UP"
  | "NOT_READY"
  | "ACK_SENT"
  | "NAK_SENT"
  | "PACK_SENT"
  | "SIDEBAND_ERROR"
  | "ERROR";
