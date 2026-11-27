/**
 * The client side of the v2 `promisor-remote` capability (git 2.49+, promisor-remote.c's
 * `filter_promisor_remote` and `promisor_remote_reply`): which promisor remotes a server
 * advertises the client accepts (`promisor.acceptFromServer`: `None`, `KnownUrl`, `KnownName`,
 * `All`; `promisor.checkFields`), what it stores of them (`promisor.storeFields`: the
 * `partialCloneFilter` and `token` of a remote it already has), and which remotes its lazy
 * fetches then try first ({@link acceptedPromisorRemotes}).
 *
 * `promisor.acceptFromServerUrl` (git 2.56) is consulted first: an advertised URL matching one
 * of its globs (`[<name>=]<url pattern>`, urlmatch.c's normalization, `*` within the host or
 * the path) is accepted whatever `acceptFromServer` says, an unknown remote being created as
 * `remote.<name>.url`/`promisor`/`advertisedAs` (the pattern's name, else
 * `promisor-auto-<sanitized url>`, `-<n>` added while another URL holds the name). The filters
 * the accepted remotes advertised make `--filter=auto` (git 2.54,
 * {@link promisorAutoFilter}).
 *
 * @example
 * ```ts
 * // [promisor] acceptFromServer = knownUrl; [remote "lop"] url = file:///lop; promisor = true
 * const reply = promisorRemoteReplyOf(workingCopy, (line) => stderr.push(line));
 * await reply("name=lop,url=file:///lop"); // "lop": sent as `promisor-remote=lop`
 * acceptedPromisorRemotes(workingCopy); // Set { "lop" }
 * ```
 */

import { isValidRefName, ObjectFilterError, parseObjectFilter } from "@statewalker/vcs-core";
import {
  encodePromisorRemoteNames,
  type PromisorRemoteInfo,
  type PromisorRemoteReply,
  parsePromisorRemoteInfo,
} from "@statewalker/vcs-transport";
import { isUrlNormalizeError, type NormalizedUrl, normalizeUrl } from "@statewalker/vcs-utils";
import { type WorkingCopy, wildmatchBytes } from "@statewalker/vcs-working-tree";
import { RemoteConfigStore } from "../remote-config/index.js";
import { promisorRemotes } from "./promisor-remote.js";

type AcceptPolicy = "none" | "knownUrl" | "knownName" | "all";

/** The optional fields git knows (`known_fields`), lower-cased. */
const KNOWN_FIELDS = new Map([
  ["partialclonefilter", "partialCloneFilter"],
  ["token", "token"],
]);

const accepted = new WeakMap<object, Set<string>>();
/** The filter each accepted remote advertised (git's `promisor_remote.advertised_filter`). */
const advertisedFilters = new WeakMap<object, Map<string, string>>();

/** An advertised remote accepted under the name it has here (git's `local_name`). */
interface Accepted extends PromisorRemoteInfo {
  localName: string;
}

/**
 * The promisor remotes a server's `promisor-remote` advertisement made this repository
 * accept (git's `promisor_remote.accepted`, kept for the process): its lazy fetches try them
 * before the other promisor remotes.
 */
export function acceptedPromisorRemotes(workingCopy: WorkingCopy): ReadonlySet<string> {
  return accepted.get(keyOf(workingCopy)) ?? new Set();
}

/**
 * Forgets what earlier `promisor-remote` answers accepted for this repository, as each git
 * process starts with none (`promisor_remote.accepted`, `advertised_filter`): a fetch or clone
 * calls it before it connects, so `--filter=auto` and the lazy fetches' order follow only the
 * server it talks to now.
 */
export function resetPromisorAcceptance(workingCopy: WorkingCopy): void {
  const key = keyOf(workingCopy);
  accepted.delete(key);
  advertisedFilters.delete(key);
}

function keyOf(workingCopy: WorkingCopy): object {
  try {
    return workingCopy.history?.objects ?? workingCopy;
  } catch {
    return workingCopy;
  }
}

/**
 * The answer of `workingCopy` to a server's `promisor-remote` capability, given to
 * `fetchFromConnection` (`FetchClientOptions.promisorRemote`). `stderr` gets git's lines
 * (warnings, `Storing new filter from server ...`), each without its newline. Each call reads
 * the configuration afresh: a stored field is not stored (nor told) again.
 *
 * `remember: false` answers as a child process of git would (a lazy fetch's `git fetch`): its
 * acceptance changes the configuration it writes, not the remotes this repository's lazy
 * fetches try first nor `--filter=auto`.
 */
export function promisorRemoteReplyOf(
  workingCopy: WorkingCopy,
  stderr: (line: string) => void,
  options: { remember?: boolean } = {},
): PromisorRemoteReply {
  // fields_checked / fields_stored warn about unknown names once per process
  const warnedFields = new Set<string>();
  const fieldsOf = (store: RemoteConfigStore, key: string): string[] => {
    const value = store.value(key);
    if (!value) return [];
    const out: string[] = [];
    for (const raw of value.split(",")) {
      const field = raw.trim();
      if (field === "") continue;
      const known = KNOWN_FIELDS.get(field.toLowerCase());
      if (!known) {
        if (!warnedFields.has(`${key}\0${field}`)) {
          warnedFields.add(`${key}\0${field}`);
          stderr(`warning: unsupported field '${field}' in '${key}' config`);
        }
        continue;
      }
      if (!out.includes(known)) out.push(known);
    }
    return out;
  };
  return async (info) => {
    const store = RemoteConfigStore.from(workingCopy);
    const policy = acceptPolicyOf(store, stderr);
    const acceptUrls = loadAcceptFromServerUrl(store, stderr);
    if (policy === "none" && acceptUrls.length === 0) return undefined;
    const { remotes, warnings } = parsePromisorRemoteInfo(info);
    for (const w of warnings) stderr(`warning: ${w}`);
    const checked = fieldsOf(store, "promisor.checkFields");
    // config_info and store_info: the promisor remotes as this call found them (a remote it
    // creates is not one of them before the next call)
    const local = configuredPromisors(store, checked);
    const storedFields = fieldsOf(store, "promisor.storeFields");
    const current = configuredPromisors(store, storedFields);
    const accepting: Accepted[] = [];
    let changed = false;
    for (const advertised of remotes) {
      const decision = shouldAccept(policy, advertised, local, checked, acceptUrls, store, stderr);
      if (decision.created) changed = true;
      if (decision.localName === undefined) continue;
      const accepted: Accepted = { ...advertised, localName: decision.localName };
      accepting.push(accepted);
      // promisor_store_advertised_fields: only for a remote configured here
      const mine = current.find((p) => p.name === accepted.localName);
      if (!mine || storedFields.length === 0) continue;
      if (
        storedFields.includes("partialCloneFilter") &&
        advertised.filter !== undefined &&
        validFilter(advertised.filter, accepted.localName, stderr)
      ) {
        changed =
          storeField(
            store,
            accepted.localName,
            "filter",
            "partialCloneFilter",
            advertised.filter,
            mine.filter,
            stderr,
          ) || changed;
      }
      if (
        storedFields.includes("token") &&
        advertised.token !== undefined &&
        validToken(advertised.token, accepted.localName, stderr)
      ) {
        changed =
          storeField(
            store,
            accepted.localName,
            "token",
            "token",
            advertised.token,
            mine.token,
            stderr,
          ) || changed;
      }
    }
    if (changed) await store.save();
    if (accepting.length === 0) return undefined;
    if (options.remember === false) return encodePromisorRemoteNames(accepting.map((r) => r.name));
    // the accepted remotes that are promisor remotes here are tried first by lazy fetches,
    // and their advertised filters make `--filter=auto`
    const promisors = new Set(
      promisorRemotes(RemoteConfigStore.from(workingCopy)).map((r) => r.name),
    );
    const key = keyOf(workingCopy);
    const set = accepted.get(key) ?? new Set<string>();
    const filters = advertisedFilters.get(key) ?? new Map<string, string>();
    for (const r of accepting) {
      if (!promisors.has(r.localName)) continue;
      set.add(r.localName);
      if (r.filter !== undefined) filters.set(r.localName, r.filter);
    }
    accepted.set(key, set);
    advertisedFilters.set(key, filters);
    // the reply names each remote as the server advertised it
    return encodePromisorRemoteNames(accepting.map((r) => r.name));
  };
}

/**
 * git's `promisor_remote_construct_filter`: the filter `--filter=auto` stands for, from the
 * promisor remotes (in config order) a server's `promisor-remote` made this repository accept
 * that advertised one, expanded (`blob:limit=5k` as `blob:limit=5120`); undefined when none
 * did. An invalid one is skipped with git's warning.
 *
 * @throws Error where git hits its `BUG()`: two accepted remotes advertising valid filters
 */
export function promisorAutoFilter(
  workingCopy: WorkingCopy,
  stderr: (line: string) => void,
): string | undefined {
  const key = keyOf(workingCopy);
  const acceptedNames = accepted.get(key);
  const filters = advertisedFilters.get(key);
  if (!acceptedNames || !filters) return undefined;
  let result: string | undefined;
  for (const { name } of promisorRemotes(RemoteConfigStore.from(workingCopy))) {
    const filter = filters.get(name);
    if (!acceptedNames.has(name) || filter === undefined) continue;
    let parsed: ReturnType<typeof parseObjectFilter>;
    try {
      parsed = parseObjectFilter(filter);
    } catch (error) {
      const reason = error instanceof ObjectFilterError ? error.message : String(error);
      stderr(`warning: promisor remote '${name}' advertised invalid filter '${filter}': ${reason}`);
      continue;
    }
    // gently_parse_list_objects_filter over an already parsed filter
    if (result !== undefined) throw new Error("BUG: filter_options already populated");
    result = parsed.choice === "blob:limit" ? `blob:limit=${parsed.limit}` : filter;
  }
  return result;
}

/** accept_from_server: the last `promisor.acceptFromServer`, case-insensitive. */
function acceptPolicyOf(store: RemoteConfigStore, stderr: (line: string) => void): AcceptPolicy {
  const value = store.value("promisor.acceptfromserver");
  if (value === undefined) return "none";
  const v = value.toLowerCase();
  if (v === "" || v === "none") return "none";
  if (v === "knownurl") return "knownUrl";
  if (v === "knownname") return "knownName";
  if (v === "all") return "all";
  stderr(`warning: unknown '${value}' value for 'promisor.acceptfromserver' config option`);
  return "none";
}

/** promisor_config_info_list: the promisor remotes with a non-empty URL, with `fields`. */
function configuredPromisors(
  store: RemoteConfigStore,
  fields: readonly string[],
): PromisorRemoteInfo[] {
  const out: PromisorRemoteInfo[] = [];
  const nonEmpty = (key: string) => {
    const v = store.value(key);
    return v ? v : undefined;
  };
  for (const { name } of promisorRemotes(store)) {
    const url = nonEmpty(`remote.${name}.url`);
    if (url === undefined) continue;
    const filter = fields.includes("partialCloneFilter")
      ? nonEmpty(`remote.${name}.partialCloneFilter`)
      : undefined;
    const token = fields.includes("token") ? nonEmpty(`remote.${name}.token`) : undefined;
    out.push({
      name,
      url,
      ...(filter !== undefined ? { filter } : {}),
      ...(token !== undefined ? { token } : {}),
    });
  }
  return out;
}

/** should_accept_remote: the name the advertised remote is accepted under, if it is. */
function shouldAccept(
  policy: AcceptPolicy,
  advertised: PromisorRemoteInfo,
  local: readonly PromisorRemoteInfo[],
  checked: readonly string[],
  acceptUrls: readonly AllowedUrl[],
  store: RemoteConfigStore,
  stderr: (line: string) => void,
): { localName?: string; created?: boolean } {
  const yes = (ok: boolean) => (ok ? { localName: advertised.name } : {});
  const mine = local.find((p) => p.name === advertised.name);
  if (!mine) {
    // should_accept_new_remote_url: a URL the allowlist names makes (or reuses) a remote
    const allowed = urlMatchesAcceptList(acceptUrls, advertised.url);
    if (allowed) {
      const name = handleMatchingAllowedUrl(store, allowed.remoteName, advertised, stderr);
      if (name !== undefined) return { localName: name, created: true };
    }
    return yes(policy === "all" && allFieldsMatch(advertised, local, undefined, checked));
  }
  // a known remote whose URL is the one advertised and allowlisted
  if (mine.url === advertised.url && urlMatchesAcceptList(acceptUrls, advertised.url)) {
    return yes(allFieldsMatch(advertised, local, mine, checked));
  }
  if (policy === "all") return yes(allFieldsMatch(advertised, local, undefined, checked));
  if (policy === "knownName") return yes(allFieldsMatch(advertised, local, mine, checked));
  if (mine.url !== advertised.url) {
    stderr(
      `warning: known remote named '${advertised.name}' but with URL '${mine.url}' instead of '${advertised.url}', ignoring this remote`,
    );
    return {};
  }
  return yes(policy === "knownUrl" && allFieldsMatch(advertised, local, mine, checked));
}

/** A `promisor.acceptFromServerUrl` entry (git's `struct allowed_url`). */
interface AllowedUrl {
  /** The name before `=`, if any */
  remoteName?: string;
  pattern: NormalizedUrl;
}

/** git's iscntrl over the bytes of a string (C locale). */
function hasControlChar(text: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git's iscntrl check
  return /[\x00-\x1f\x7f]/.test(text);
}

/** valid_remote_name: `refs/remotes/<name>/test` a valid ref name (in a valid refspec). */
function validRemoteName(name: string): boolean {
  return name.length > 0 && isValidRefName(`refs/remotes/${name}/test`);
}

/** load_accept_from_server_url and valid_accept_url: the valid entries, in config order. */
function loadAcceptFromServerUrl(
  store: RemoteConfigStore,
  stderr: (line: string) => void,
): AllowedUrl[] {
  const out: AllowedUrl[] = [];
  for (const entry of store.values("promisor.acceptfromserverurl")) {
    const eq = entry.indexOf("=");
    let remoteName: string | undefined;
    let pattern = entry;
    if (eq >= 0) {
      remoteName = entry.slice(0, eq);
      if (!validRemoteName(remoteName)) {
        stderr(
          `warning: invalid remote name '${remoteName}' before '=' sign in '${entry}' from promisor.acceptFromServerUrl config`,
        );
        continue;
      }
      pattern = entry.slice(eq + 1);
    }
    const normalized = hasControlChar(pattern)
      ? undefined
      : normalizeUrl(pattern, { allowGlobs: true });
    if (normalized === undefined || isUrlNormalizeError(normalized)) {
      stderr(
        `warning: invalid url pattern '${pattern}' in '${entry}' from promisor.acceptFromServerUrl config`,
      );
      continue;
    }
    out.push({ ...(remoteName !== undefined ? { remoteName } : {}), pattern: normalized });
  }
  return out;
}

/** A byte string (one character per byte, as `normalizeUrl` gives) as its bytes. */
function bytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** match_one_url: scheme and port exactly, host and path each through wildmatch. */
function matchOneUrl(p: NormalizedUrl, u: NormalizedUrl): boolean {
  if (
    p.schemeLength !== u.schemeLength ||
    p.url.slice(0, p.schemeLength) !== u.url.slice(0, u.schemeLength)
  ) {
    return false;
  }
  const part = (n: NormalizedUrl, offset: number, length: number) =>
    n.url.slice(offset, offset + length);
  if (
    p.portLength !== u.portLength ||
    part(p, p.portOffset, p.portLength) !== part(u, u.portOffset, u.portLength)
  ) {
    return false;
  }
  return (
    wildmatchBytes(
      bytesOf(part(p, p.hostOffset, p.hostLength)),
      bytesOf(part(u, u.hostOffset, u.hostLength)),
    ) &&
    wildmatchBytes(
      bytesOf(part(p, p.pathOffset, p.pathLength)),
      bytesOf(part(u, u.pathOffset, u.pathLength)),
    )
  );
}

/** url_matches_accept_list: the first entry matching the (normalized) URL. */
function urlMatchesAcceptList(
  acceptUrls: readonly AllowedUrl[],
  url: string,
): AllowedUrl | undefined {
  if (acceptUrls.length === 0) return undefined;
  const normalized = normalizeUrl(url);
  if (isUrlNormalizeError(normalized)) return undefined;
  return acceptUrls.find((a) => matchOneUrl(a.pattern, normalized));
}

/** isalnum in the C locale */
const isAlnum = (c: string) => /^[A-Za-z0-9]$/.test(c);

/** promisor_remote_name_from_url and sanitize_remote_name. */
function promisorRemoteNameFromUrl(
  url: string,
  stderr: (line: string) => void,
): string | undefined {
  const n = normalizeUrl(url);
  if (isUrlNormalizeError(n)) {
    stderr(`warning: couldn't normalize advertised url '${url}', ignoring this remote`);
    return undefined;
  }
  let buf = "";
  if (n.hostLength) buf += `${n.url.slice(n.hostOffset, n.hostOffset + n.hostLength)}-`;
  if (n.portLength) buf += `${n.url.slice(n.portOffset, n.portOffset + n.portLength)}-`;
  if (n.pathLength) {
    let path = n.url.slice(n.pathOffset, n.pathOffset + n.pathLength);
    // strbuf_trim_trailing_dir_sep, then strbuf_strip_suffix(".git")
    path = path.replace(/\/+$/, "");
    if (path.endsWith(".git")) path = path.slice(0, -4);
    buf += path;
  }
  // every byte but an alphanumeric one a '-', no leading or repeated '-'
  let out = "";
  let prev = "-";
  for (const ch of buf) {
    const c = isAlnum(ch) ? ch : "-";
    if (prev === "-" && c === "-") continue;
    out += c;
    prev = c;
  }
  if (out.endsWith("-")) out = out.slice(0, -1);
  if (out === "") {
    stderr(
      `warning: couldn't generate a valid remote name from advertised url '${url}', ignoring this remote`,
    );
    return undefined;
  }
  out = `promisor-auto-${out}`;
  if (!validRemoteName(out)) {
    stderr(
      `warning: generated remote name '${out}' from advertised url '${url}' is invalid, ignoring this remote`,
    );
    return undefined;
  }
  return out;
}

const MAX_REMOTES_WITH_SIMILAR_NAMES = 20;

/**
 * handle_matching_allowed_url and configure_auto_promisor_remote: the name the remote gets
 * (a free one, or one already holding the URL, reused), written to the configuration.
 */
function handleMatchingAllowedUrl(
  store: RemoteConfigStore,
  allowedName: string | undefined,
  advertised: PromisorRemoteInfo,
  stderr: (line: string) => void,
): string | undefined {
  const basename = allowedName ?? promisorRemoteNameFromUrl(advertised.url, stderr);
  if (basename === undefined) return undefined;
  let name = basename;
  let reuse = false;
  let i = 0;
  while (i < MAX_REMOTES_WITH_SIMILAR_NAMES) {
    const existing = store.value(`remote.${name}.url`);
    if (existing === undefined) break;
    if (existing === advertised.url) {
      reuse = true;
      break;
    }
    i++;
    name = `${basename}-${i}`;
  }
  if (i >= MAX_REMOTES_WITH_SIMILAR_NAMES) {
    stderr(
      `warning: too many remotes accepted with name like '${basename}-X', ignoring this remote`,
    );
    return undefined;
  }
  if (!reuse) {
    stderr(`Auto-creating promisor remote '${name}' for URL '${advertised.url}'`);
    store.setValue(`remote.${name}.url`, advertised.url);
  }
  // reusing promotes an existing non-promisor remote
  store.setValue(`remote.${name}.promisor`, "true");
  store.setValue(`remote.${name}.advertisedAs`, advertised.name);
  return name;
}

/** all_fields_match: every checked field advertised and equal to one remote's (or `mine`'s). */
function allFieldsMatch(
  advertised: PromisorRemoteInfo,
  local: readonly PromisorRemoteInfo[],
  mine: PromisorRemoteInfo | undefined,
  checked: readonly string[],
): boolean {
  const fieldOf = (r: PromisorRemoteInfo, field: string) =>
    field === "partialCloneFilter" ? r.filter : r.token;
  for (const field of checked) {
    const value = fieldOf(advertised, field);
    if (value === undefined) return false;
    const candidates = mine ? [mine] : local;
    if (!candidates.some((r) => fieldOf(r, field) === value)) return false;
  }
  return true;
}

/** store_one_field: a new value written (`repo_config_set_gently`) and told on stderr. */
function storeField(
  store: RemoteConfigStore,
  remote: string,
  label: string,
  field: string,
  advertised: string,
  current: string | undefined,
  stderr: (line: string) => void,
): boolean {
  if (current !== undefined && current === advertised) return false;
  stderr(`Storing new ${label} from server for remote '${remote}'.`);
  stderr(`    '${current ?? ""}' -> '${advertised}'`);
  store.setValue(`remote.${remote}.${field}`, advertised);
  return true;
}

/** valid_filter: the advertised filter must parse (git warns with the parser's reason). */
function validFilter(filter: string, remote: string, stderr: (line: string) => void): boolean {
  try {
    parseObjectFilter(filter);
    return true;
  } catch (error) {
    const reason = error instanceof ObjectFilterError ? error.message : String(error);
    stderr(
      `warning: invalid filter '${filter}' for remote '${remote}' will not be stored: ${reason}`,
    );
    return false;
  }
}

/** valid_token: no control character. */
function validToken(token: string, remote: string, stderr: (line: string) => void): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git's iscntrl check
  if (/[\x00-\x1f\x7f]/.test(token)) {
    stderr(`warning: invalid token '${token}' for remote '${remote}' will not be stored`);
    return false;
  }
  return true;
}
