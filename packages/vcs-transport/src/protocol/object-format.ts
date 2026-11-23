/**
 * The `object-format` capability (git's protocol support for SHA-256 repositories): the
 * servers advertise the hash their repository names objects with, the clients read the ids
 * of the advertisement in that hash and refuse to mix formats as git does (connect.c,
 * serve.c, receive-pack.c, fetch-pack.c, send-pack.c).
 *
 * @example
 * ```ts
 * v0ObjectFormatCapabilities(["multi_ack", "ofs-delta"], SHA256_OBJECT_FORMAT);
 * // ["multi_ack", "ofs-delta", "object-format=sha256"]
 * remoteObjectFormat(new Map([["object-format", "sha256"]])).hexLength; // 64
 * ```
 */
import {
  isHexObjectId,
  type ObjectFormat,
  objectFormatByName,
  SHA1_OBJECT_FORMAT,
} from "@statewalker/vcs-utils/hash";

/** The capability's name (`object-format=<name>`). */
export const OBJECT_FORMAT_CAPABILITY = "object-format";

/** A repository's format (its facade's `objectFormat`), SHA-1 when it names none. */
export function formatOf(repository?: { readonly objectFormat?: ObjectFormat }): ObjectFormat {
  return repository?.objectFormat ?? SHA1_OBJECT_FORMAT;
}

/**
 * The v0 capabilities of a repository of `format`: git's upload-pack and receive-pack name
 * `object-format=<hash>` on the first ref line, before `agent=`. A SHA-1 repository's
 * advertisement is left as it is (a client reading no `object-format` assumes SHA-1, git's
 * `GIT_HASH_SHA1_LEGACY`), so are capabilities that name one already.
 */
export function v0ObjectFormatCapabilities(
  capabilities: readonly string[],
  format: ObjectFormat,
): string[] {
  const list = [...capabilities];
  if (format.name === "sha1" || list.some((c) => c.startsWith(`${OBJECT_FORMAT_CAPABILITY}=`))) {
    return list;
  }
  const value = `${OBJECT_FORMAT_CAPABILITY}=${format.name}`;
  const agent = list.findIndex((c) => c.startsWith("agent="));
  if (agent < 0) list.push(value);
  else list.splice(agent, 0, value);
  return list;
}

/**
 * The v2 capabilities of a repository of `format` (serve.c's `object_format_advertise`:
 * `object-format=<hash>`, always): an `object-format=` line already there names the
 * repository's hash; without one a non-SHA-1 repository gets one at the end.
 */
export function v2ObjectFormatCapabilities(
  capabilities: readonly string[],
  format: ObjectFormat,
): string[] {
  const value = `${OBJECT_FORMAT_CAPABILITY}=${format.name}`;
  const at = capabilities.findIndex((c) => c.startsWith(`${OBJECT_FORMAT_CAPABILITY}=`));
  if (at >= 0) return capabilities.map((c, i) => (i === at ? value : c));
  return format.name === "sha1" ? [...capabilities] : [...capabilities, value];
}

/**
 * The hash a server speaks, from its capabilities (v0 first-line capabilities or the v2
 * advertisement): `object-format=<name>`, SHA-1 without one (git's
 * `GIT_HASH_SHA1_LEGACY`). A name git does not know is left to the caller (undefined), as
 * connect.c dies on it in v2 and keeps SHA-1 in v0.
 */
export function remoteObjectFormat(
  capabilities: ReadonlyMap<string, string>,
): ObjectFormat | undefined {
  const name = capabilities.get(OBJECT_FORMAT_CAPABILITY);
  if (name === undefined) return SHA1_OBJECT_FORMAT;
  return objectFormatByName(name);
}

/** Whether `id` is a full lowercase hex id of `format` (git's `get_oid_hex` of its hexsz). */
export function isObjectIdOf(id: string, format: ObjectFormat): boolean {
  return isHexObjectId(id, format);
}

/** Whether `id` is the null id (all zeros) of either format. */
export function isNullId(id: string | undefined): boolean {
  return id !== undefined && (id.length === 40 || id.length === 64) && /^0+$/.test(id);
}

/**
 * git's message when the client's repository and the server name different hashes
 * (connect.c `write_command_and_capabilities`): fetch, and every v2 command after ls-refs.
 */
export function mismatchedAlgorithms(client: ObjectFormat, server: string): string {
  return `mismatched algorithms: client ${client.name}; server ${server}`;
}
