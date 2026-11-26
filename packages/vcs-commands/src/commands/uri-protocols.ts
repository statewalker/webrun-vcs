/**
 * git's `fetch.uriProtocols` (fetch-pack.c's fetch_pack_config): the last value, split at
 * commas, as the fetch options' `uriProtocols`; nothing when unset or valueless.
 *
 * @example
 * ```ts
 * uriProtocolsOption("http,https"); // { uriProtocols: ["http", "https"] }
 * ```
 */
export function uriProtocolsOption(value: string | undefined): { uriProtocols?: string[] } {
  if (value === undefined || value === "") return {};
  return { uriProtocols: value.split(",") };
}
