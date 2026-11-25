/**
 * git's `transfer.advertiseSID` on the client: fetch, clone, pull and push send the process's
 * session id (`session-id=<id>`, git's trace2 session id) to a server that advertises its own.
 */

import { processSessionId } from "@statewalker/vcs-transport";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { RemoteConfigStore } from "../remote-config/index.js";

/**
 * The session id a transport command sends: the process's (`processSessionId()`) when
 * `transfer.advertiseSID` is true (the last value; a key without a value is true), else
 * undefined. A value git cannot read as a boolean counts as false here.
 *
 * @example
 * ```ts
 * // [transfer] advertiseSID = true
 * clientSessionIdOf(workingCopy); // "20261125T101500.123000Z-H5f2c9a01"
 * ```
 */
export function clientSessionIdOf(workingCopy: WorkingCopy): string | undefined {
  const entries = RemoteConfigStore.from(workingCopy).entriesWithOriginFor([
    "transfer.advertisesid",
  ]);
  const last = entries?.[entries.length - 1];
  if (!last) return undefined;
  const on = last.text === undefined ? true : parseGitBool(last.text);
  return on ? processSessionId() : undefined;
}
