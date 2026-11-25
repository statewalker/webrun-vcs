/**
 * git's bundle files (bundle.c, `Documentation/gitformat-bundle.adoc`): a header naming the
 * refs the bundle carries and the commits it needs, then a pack.
 *
 * @example
 * ```typescript
 * // # v3 git bundle
 * // @object-format=sha256
 * // -<id> <subject>          (a prerequisite)
 * // <id> refs/heads/main     (a ref)
 * //                          (an empty line, then the pack)
 * const header = parseBundleHeader(bytes);
 * if (header.ok) for (const ref of header.header.references) console.log(ref.id, ref.name);
 * ```
 */

import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  type ObjectFormat,
  objectFormatByName,
  SHA1_OBJECT_FORMAT,
} from "@statewalker/vcs-utils/hash";

/** The first line of a v2 bundle. */
export const V2_BUNDLE_SIGNATURE = "# v2 git bundle\n";
/** The first line of a v3 bundle (capabilities may follow). */
export const V3_BUNDLE_SIGNATURE = "# v3 git bundle\n";

/** A ref a bundle carries (`<id> <refname>`). */
export interface BundleRef {
  readonly id: string;
  readonly name: string;
}

/** A commit a bundle needs (`-<id> <subject>`): its pack is thin against it. */
export interface BundlePrerequisite {
  readonly id: string;
  /** What follows the id on its line (the commit's subject), trimmed; never printed by git */
  readonly comment: string;
}

/** A bundle's header (git's `struct bundle_header`). */
export interface BundleHeader {
  readonly version: 2 | 3;
  /** The `@object-format=` capability's hash (v3), else SHA-1 */
  readonly objectFormat: ObjectFormat;
  /** The `@filter=` capability's spec (v3): the pack is a partial clone's */
  readonly filter?: string;
  readonly prerequisites: readonly BundlePrerequisite[];
  readonly references: readonly BundleRef[];
}

/** {@link parseBundleHeader}'s answer. */
export type ParsedBundleHeader =
  | {
      readonly ok: true;
      readonly header: BundleHeader;
      /** Where the pack starts (after the header's empty line; the end when it has none) */
      readonly packOffset: number;
    }
  | {
      readonly ok: false;
      /**
       * git's `error:` line, without the prefix, where it reports one (a bad signature is
       * reported by name: `'<name>' does not look like a v2 or v3 bundle file`)
       */
      readonly error: string;
      /** The signature was not a bundle's (git's `is_bundle` is false) */
      readonly notABundle: boolean;
    };

/** git's sane_ctype isspace: SP, HT, LF, CR */
const SPACE = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const HEX = /^[0-9a-fA-F]$/;

/**
 * bundle.c's `read_bundle_header_fd`: the signature, then lines up to an empty one (or the
 * end): v3 capabilities (`@object-format=`, `@filter=`), prerequisites (`-<id>` optionally
 * followed by a space and a comment) and refs (`<id> <name>`), each line right-trimmed.
 * `name` is how a bad signature is reported (git's `report_path`).
 *
 * @example
 * ```typescript
 * const parsed = parseBundleHeader(bytes, "repo.bundle");
 * if (!parsed.ok) console.error(`error: ${parsed.error}`);
 * ```
 */
export function parseBundleHeader(bytes: Uint8Array, name = "<bundle>"): ParsedBundleHeader {
  let at = 0;
  /** strbuf_getwholeline_fd: the next line with its LF; undefined at the end */
  const nextLine = (): Uint8Array | undefined => {
    if (at >= bytes.length) return undefined;
    const lf = bytes.indexOf(10, at);
    const end = lf < 0 ? bytes.length : lf + 1;
    const line = bytes.subarray(at, end);
    at = end;
    return line;
  };
  const first = nextLine();
  const signature = first ? latin1(first) : "";
  const version = signature === V2_BUNDLE_SIGNATURE ? 2 : signature === V3_BUNDLE_SIGNATURE ? 3 : 0;
  if (version === 0) {
    return {
      ok: false,
      error: `'${name}' does not look like a v2 or v3 bundle file`,
      notABundle: true,
    };
  }
  let objectFormat: ObjectFormat = SHA1_OBJECT_FORMAT;
  let filter: string | undefined;
  const prerequisites: BundlePrerequisite[] = [];
  const references: BundleRef[] = [];
  const fail = (error: string): ParsedBundleHeader => ({ ok: false, error, notABundle: false });
  for (let line = nextLine(); line !== undefined; line = nextLine()) {
    if (line.length === 0 || line[0] === 10) break;
    // strbuf_rtrim
    let end = line.length;
    while (end > 0 && SPACE(line[end - 1] as number)) end--;
    let text = line.subarray(0, end);
    if (version === 3 && text[0] === 0x40 /* @ */) {
      const capability = decodeGitPath(text.subarray(1));
      if (capability.startsWith("object-format=")) {
        const format = objectFormatByName(capability.slice("object-format=".length));
        if (!format) {
          return fail(
            `unrecognized bundle hash algorithm: ${capability.slice("object-format=".length)}`,
          );
        }
        objectFormat = format;
        continue;
      }
      if (capability.startsWith("filter=")) {
        filter = capability.slice("filter=".length);
        continue;
      }
      return fail(`unknown capability '${capability}'`);
    }
    const prereq = text[0] === 0x2d; /* - */
    if (prereq) text = text.subarray(1);
    // parse_oid_hex_algop: exactly hexsz hex digits, then nothing or a space
    const hex = objectFormat.hexLength;
    let valid = text.length >= hex;
    for (let i = 0; valid && i < hex; i++) valid = HEX.test(String.fromCharCode(text[i] as number));
    const rest = text.subarray(hex);
    if (valid && rest.length > 0 && !SPACE(rest[0] as number)) valid = false;
    if (valid && !prereq && rest.length === 0) valid = false;
    if (!valid) {
      return fail(
        `unrecognized header: ${prereq ? "-" : ""}${decodeGitPath(text)} (${text.length})`,
      );
    }
    const id = latin1(text.subarray(0, hex)).toLowerCase();
    if (prereq) {
      prerequisites.push({ id, comment: decodeGitPath(rest.subarray(1)).trim() });
    } else {
      references.push({ id, name: decodeGitPath(rest.subarray(1)) });
    }
  }
  return {
    ok: true,
    header: {
      version,
      objectFormat,
      ...(filter !== undefined ? { filter } : {}),
      prerequisites,
      references,
    },
    packOffset: at,
  };
}

/**
 * The header `create_bundle` writes: the signature (v3 with `@object-format=` and, for a
 * filtered bundle, `@filter=`), `-<id> <comment>` per prerequisite, `<id> <name>` per ref,
 * then the empty line the pack follows.
 *
 * @example
 * ```typescript
 * const bytes = encodeBundleHeader({ version: 2, objectFormat: SHA1_OBJECT_FORMAT,
 *   prerequisites: [], references: [{ id, name: "refs/heads/main" }] });
 * ```
 */
export function encodeBundleHeader(header: BundleHeader): Uint8Array {
  const parts: Uint8Array[] = [];
  const text = (s: string) => parts.push(encodeGitPath(s));
  if (header.version === 2) text(V2_BUNDLE_SIGNATURE);
  else {
    text(V3_BUNDLE_SIGNATURE);
    text(`@object-format=${header.objectFormat.name}\n`);
    if (header.filter !== undefined) text(`@filter=${header.filter}\n`);
  }
  for (const p of header.prerequisites) text(`-${p.id} ${p.comment}\n`);
  for (const r of header.references) text(`${r.id} ${r.name}\n`);
  text("\n");
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * bundle.c's `list_refs`: `<id> <name>` per ref, only those named in `names` when any are
 * (exact names, as `git bundle list-heads <file> <refname>...` and `unbundle` take them).
 * A prerequisite is listed with an empty name (`<id> `), as `git bundle verify` prints it.
 */
export function listBundleRefs(
  refs: readonly (BundleRef | BundlePrerequisite)[],
  names: readonly string[] = [],
): string {
  let out = "";
  for (const ref of refs) {
    const name = "name" in ref ? ref.name : "";
    if (names.length > 0 && !names.includes(name)) continue;
    out += `${ref.id} ${name}\n`;
  }
  return out;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return s;
}
