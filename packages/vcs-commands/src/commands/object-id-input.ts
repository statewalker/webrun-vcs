/**
 * Object ids as the commands take them from callers.
 *
 * @module
 */

const FULL_HEX = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/**
 * A full hexadecimal object id in the form stores and refs hold it: lowercase, as git's
 * `get_oid_hex` reads either case (`ABCD...` names the object `abcd...`). Anything else is
 * returned as given.
 *
 * @example
 * ```typescript
 * canonicalObjectId("D90F7D2AD59FC2F2D12C4A4BAEA96C445B5E625D"); // "d90f7d2a..."
 * canonicalObjectId("main"); // "main"
 * ```
 */
export function canonicalObjectId<T extends string>(id: T): T {
  return (FULL_HEX.test(id) ? id.toLowerCase() : id) as T;
}

/** Whether `id` is a full hexadecimal object id, in either case. */
export function isFullHexObjectId(id: string): boolean {
  return FULL_HEX.test(id);
}
