/**
 * The v2 `promisor-remote` capability (git 2.49+, gitprotocol-v2's `promisor-remote=<pr-info>`):
 * a server advertises the promisor remotes it borrows objects from, a client names in its
 * `ls-refs` request the ones it accepts, and an accepting client may then be sent packs that
 * leave out what those remotes hold.
 *
 * @example
 * ```ts
 * const info = encodePromisorRemoteInfo([{ name: "lop", url: "file:///srv/lop" }]);
 * // "name=lop,url=file:///srv/lop"
 * parsePromisorRemoteInfo(info).remotes; // [{ name: "lop", url: "file:///srv/lop" }]
 * encodePromisorRemoteNames(["lop"]); // "lop"
 * ```
 */

/** One advertised promisor remote: promisor-remote.c's `struct promisor_info`. */
export interface PromisorRemoteInfo {
  /** The remote's name on the server (`name=`) */
  name: string;
  /** Its URL (`url=`) */
  url: string;
  /** `partialCloneFilter=` (sent under `promisor.sendFields`) */
  filter?: string;
  /** `token=` (sent under `promisor.sendFields`) */
  token?: string;
}

/** The capability's name. */
export const PROMISOR_REMOTE_CAPABILITY = "promisor-remote";

/** promisor-remote.c's `allow_unsanitized`: printable ASCII but `,`, `;` and `%`. */
function allowUnsanitized(code: number): boolean {
  if (code === 0x2c || code === 0x3b || code === 0x25) return false;
  return code > 32 && code < 127;
}

/** strbuf_addstr_urlencode with `allow_unsanitized`: other bytes (UTF-8) as `%XX`. */
export function promisorUrlEncode(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    out += allowUnsanitized(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** url.c's url_percent_decode: every `%XX` of two hex digits decoded, the rest kept. */
export function promisorUrlDecode(value: string): string {
  const bytes: number[] = [];
  const raw = new TextEncoder().encode(value);
  const hex = (c: number) =>
    c >= 0x30 && c <= 0x39
      ? c - 0x30
      : c >= 0x41 && c <= 0x46
        ? c - 0x37
        : c >= 0x61 && c <= 0x66
          ? c - 0x57
          : -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as number;
    if (c === 0x25 && i + 2 < raw.length) {
      const hi = hex(raw[i + 1] ?? 0);
      const lo = hex(raw[i + 2] ?? 0);
      if (hi >= 0 && lo >= 0) {
        bytes.push(hi * 16 + lo);
        i += 2;
        continue;
      }
    }
    bytes.push(c);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * promisor_remote_info's value: each remote's `name=`, `url=`, then `partialCloneFilter=` and
 * `token=` when set, `,` between fields and `;` between remotes.
 */
export function encodePromisorRemoteInfo(remotes: readonly PromisorRemoteInfo[]): string {
  return remotes
    .map((r) => {
      let s = `name=${promisorUrlEncode(r.name)},url=${promisorUrlEncode(r.url)}`;
      if (r.filter !== undefined) s += `,partialCloneFilter=${promisorUrlEncode(r.filter)}`;
      if (r.token !== undefined) s += `,token=${promisorUrlEncode(r.token)}`;
      return s;
    })
    .join(";");
}

/**
 * parse_one_advertised_remote over each `;`-separated part: fields matched case-sensitively,
 * a remote without a name or URL dropped, with git's warnings (without `warning: `).
 */
export function parsePromisorRemoteInfo(info: string): {
  remotes: PromisorRemoteInfo[];
  warnings: string[];
} {
  const remotes: PromisorRemoteInfo[] = [];
  const warnings: string[] = [];
  for (const part of info.split(";")) {
    let name: string | undefined;
    let url: string | undefined;
    let filter: string | undefined;
    let token: string | undefined;
    for (const elem of part.split(",")) {
      const eq = elem.indexOf("=");
      if (eq < 0) {
        warnings.push(`invalid element '${elem}' from remote info`);
        continue;
      }
      const key = elem.slice(0, eq);
      const value = promisorUrlDecode(elem.slice(eq + 1));
      if (key === "name") name = value;
      else if (key === "url") url = value;
      else if (key === "partialCloneFilter") filter = value;
      else if (key === "token") token = value;
    }
    if (!name || !url) {
      warnings.push(
        `server advertised a promisor remote without a name or URL: '${part}', ignoring this remote`,
      );
      continue;
    }
    remotes.push({
      name,
      url,
      ...(filter !== undefined ? { filter } : {}),
      ...(token !== undefined ? { token } : {}),
    });
  }
  return { remotes, warnings };
}

/** promisor_remote_reply's value: the accepted names, url-encoded, `;` between them. */
export function encodePromisorRemoteNames(names: readonly string[]): string {
  return names.map(promisorUrlEncode).join(";");
}

/** mark_promisor_remotes_as_accepted's reading of a client's `promisor-remote=` value. */
export function parsePromisorRemoteNames(value: string): string[] {
  return value.split(";").map(promisorUrlDecode);
}

/**
 * The client side of the capability: given the server's `promisor-remote` value, the value
 * of the client's `promisor-remote=` line (the accepted names, {@link encodePromisorRemoteNames}),
 * or undefined to send none. git asks it in every `ls-refs` request (connect.c's
 * send_capabilities) and once more before a `fetch` (do_fetch_pack_v2, the answer unused);
 * it may change the client's configuration (`promisor.storeFields`).
 */
export type PromisorRemoteReply = (info: string) => Promise<string | undefined>;
