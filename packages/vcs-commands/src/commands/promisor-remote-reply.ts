/**
 * The client side of the v2 `promisor-remote` capability (git 2.49+, promisor-remote.c's
 * `filter_promisor_remote` and `promisor_remote_reply`): which promisor remotes a server
 * advertises the client accepts (`promisor.acceptFromServer`: `None`, `KnownUrl`, `KnownName`,
 * `All`; `promisor.checkFields`), what it stores of them (`promisor.storeFields`: the
 * `partialCloneFilter` and `token` of a remote it already has), and which remotes its lazy
 * fetches then try first ({@link acceptedPromisorRemotes}).
 *
 * Not yet: `promisor.acceptFromServerUrl` (2.56: remotes created from an advertised URL) and
 * `--filter=auto`.
 *
 * @example
 * ```ts
 * // [promisor] acceptFromServer = knownUrl; [remote "lop"] url = file:///lop; promisor = true
 * const reply = promisorRemoteReplyOf(workingCopy, (line) => stderr.push(line));
 * await reply("name=lop,url=file:///lop"); // "lop": sent as `promisor-remote=lop`
 * acceptedPromisorRemotes(workingCopy); // Set { "lop" }
 * ```
 */

import { ObjectFilterError, parseObjectFilter } from "@statewalker/vcs-core";
import {
  encodePromisorRemoteNames,
  type PromisorRemoteInfo,
  type PromisorRemoteReply,
  parsePromisorRemoteInfo,
} from "@statewalker/vcs-transport";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { RemoteConfigStore } from "../remote-config/index.js";
import { promisorRemotes } from "./promisor-remote.js";

type AcceptPolicy = "none" | "knownUrl" | "knownName" | "all";

/** The optional fields git knows (`known_fields`), lower-cased. */
const KNOWN_FIELDS = new Map([
  ["partialclonefilter", "partialCloneFilter"],
  ["token", "token"],
]);

const accepted = new WeakMap<object, Set<string>>();

/**
 * The promisor remotes a server's `promisor-remote` advertisement made this repository
 * accept (git's `promisor_remote.accepted`, kept for the process): its lazy fetches try them
 * before the other promisor remotes.
 */
export function acceptedPromisorRemotes(workingCopy: WorkingCopy): ReadonlySet<string> {
  return accepted.get(keyOf(workingCopy)) ?? new Set();
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
 */
export function promisorRemoteReplyOf(
  workingCopy: WorkingCopy,
  stderr: (line: string) => void,
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
    if (policy === "none") return undefined;
    const { remotes, warnings } = parsePromisorRemoteInfo(info);
    for (const w of warnings) stderr(`warning: ${w}`);
    const checked = fieldsOf(store, "promisor.checkFields");
    const local = configuredPromisors(store, checked);
    const accepting: PromisorRemoteInfo[] = [];
    for (const advertised of remotes) {
      if (shouldAccept(policy, advertised, local, checked, stderr)) accepting.push(advertised);
    }
    if (accepting.length === 0) return undefined;
    // promisor_store_advertised_fields: only for a remote configured here
    const storedFields = fieldsOf(store, "promisor.storeFields");
    let changed = false;
    if (storedFields.length > 0) {
      const current = configuredPromisors(store, storedFields);
      for (const advertised of accepting) {
        const mine = current.find((p) => p.name === advertised.name);
        if (!mine) continue;
        if (
          storedFields.includes("partialCloneFilter") &&
          advertised.filter !== undefined &&
          validFilter(advertised.filter, advertised.name, stderr)
        ) {
          changed =
            storeField(
              store,
              advertised.name,
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
          validToken(advertised.token, advertised.name, stderr)
        ) {
          changed =
            storeField(
              store,
              advertised.name,
              "token",
              "token",
              advertised.token,
              mine.token,
              stderr,
            ) || changed;
        }
      }
    }
    if (changed) await store.save();
    // the accepted remotes that are promisor remotes here are tried first by lazy fetches
    const promisors = new Set(
      promisorRemotes(RemoteConfigStore.from(workingCopy)).map((r) => r.name),
    );
    const key = keyOf(workingCopy);
    const set = accepted.get(key) ?? new Set<string>();
    for (const r of accepting) if (promisors.has(r.name)) set.add(r.name);
    accepted.set(key, set);
    return encodePromisorRemoteNames(accepting.map((r) => r.name));
  };
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

/** should_accept_remote (without `promisor.acceptFromServerUrl`). */
function shouldAccept(
  policy: AcceptPolicy,
  advertised: PromisorRemoteInfo,
  local: readonly PromisorRemoteInfo[],
  checked: readonly string[],
  stderr: (line: string) => void,
): boolean {
  const mine = local.find((p) => p.name === advertised.name);
  if (!mine) return policy === "all" && allFieldsMatch(advertised, local, undefined, checked);
  if (policy === "all") return allFieldsMatch(advertised, local, undefined, checked);
  if (policy === "knownName") return allFieldsMatch(advertised, local, mine, checked);
  if (mine.url !== advertised.url) {
    stderr(
      `warning: known remote named '${advertised.name}' but with URL '${mine.url}' instead of '${advertised.url}', ignoring this remote`,
    );
    return false;
  }
  return policy === "knownUrl" && allFieldsMatch(advertised, local, mine, checked);
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
