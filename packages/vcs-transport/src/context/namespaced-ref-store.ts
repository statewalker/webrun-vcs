/**
 * A served repository's refs as one ref namespace sees them (git's `GIT_NAMESPACE`).
 */

import { type BatchResult, isValidRefName, type RefCommand } from "@statewalker/vcs-core";
import { stripNamespace } from "../protocol/ref-namespace.js";
import type { RefStore } from "./process-context.js";

/** How many symbolic refs a chain may go through (git's SYMREF_MAXDEPTH). */
const MAX_SYMREF_DEPTH = 5;

/**
 * The refs of the namespace whose prefix is `prefix` (`gitNamespacePrefix`), named as its
 * clients see them: `HEAD` is `<prefix>HEAD`, `refs/heads/main` is
 * `<prefix>refs/heads/main`, and only `HEAD` and `<prefix>refs/...` are listed, as git's
 * upload-pack and receive-pack serve a namespace (`refs_head_ref_namespaced`,
 * `for_each_namespaced_ref`). Writes land under the prefix.
 *
 * Nothing outside the namespace is reachable through it, which is stricter than git: a
 * symbolic ref of the namespace whose chain leaves it reads as absent and is never written
 * through (git follows it, advertising or updating the ref outside), names other than `HEAD`
 * and well-formed `refs/...` (no `..`) are absent, and every tip (`isRefTip`) is one of the namespace's.
 *
 * @example
 * ```ts
 * const store = namespacedRefStore(createTransportRefStore(history.refs), "refs/namespaces/a/");
 * await store.listAll(); // [["HEAD", id], ["refs/heads/main", id]]
 * await store.update("refs/heads/topic", id); // writes refs/namespaces/a/refs/heads/topic
 * ```
 */
export function namespacedRefStore(store: RefStore, prefix: string): RefStore {
  // a well-formed name only: `refs/../../x` would reach outside the prefix in a store that
  // joins paths (git's refs_read_ref reads only names check_refname_format accepts)
  const readable = (name: string) =>
    name === "HEAD" || (name.startsWith("refs/") && isValidRefName(name));

  /**
   * The full name a namespaced name ends at, through its symbolic refs: undefined when the
   * chain leaves the namespace (or loops)
   */
  async function insideTarget(name: string): Promise<string | undefined> {
    let full = prefix + name;
    if (!store.getSymrefTarget) return full;
    for (let depth = 0; depth <= MAX_SYMREF_DEPTH; depth++) {
      const target = await store.getSymrefTarget(full);
      if (target === undefined) return full;
      if (stripNamespace(target, prefix) === undefined) return undefined;
      full = target;
    }
    return undefined;
  }

  async function get(name: string): Promise<string | undefined> {
    if (!readable(name)) return undefined;
    const full = await insideTarget(name);
    return full === undefined ? undefined : store.get(full);
  }

  async function listAll(): Promise<Array<[string, string]>> {
    const out: Array<[string, string]> = [];
    const head = await get("HEAD");
    if (head) out.push(["HEAD", head]);
    const refsPrefix = `${prefix}refs/`;
    for (const [full, oid] of await store.listAll()) {
      if (!full.startsWith(refsPrefix)) continue;
      const name = full.slice(prefix.length);
      // a symbolic ref pointing outside the namespace is not the namespace's
      if (store.getSymrefTarget && (await insideTarget(name)) === undefined) continue;
      out.push([name, oid]);
    }
    return out;
  }

  /** Refuses a write to a name the namespace does not own (through a symref leaving it). */
  async function writable(name: string): Promise<boolean> {
    return name !== "HEAD" && readable(name) && (await insideTarget(name)) !== undefined;
  }

  const namespaced: RefStore = {
    get,
    listAll,
    async update(name, oid) {
      if (!(await writable(name))) {
        throw new Error(`refusing to update '${name}' outside the namespace`);
      }
      await store.update(prefix + name, oid);
    },
    async getSymrefTarget(name) {
      if (!readable(name) || !store.getSymrefTarget) return undefined;
      const target = await store.getSymrefTarget(prefix + name);
      if (target === undefined || (await insideTarget(name)) === undefined) return undefined;
      return stripNamespace(target, prefix);
    },
    async isRefTip(oid) {
      return (await listAll()).some(([, id]) => id === oid);
    },
  };
  if (store.batch) {
    const batch = store.batch.bind(store);
    namespaced.batch = async (commands, options): Promise<BatchResult> => {
      const rejected = [];
      for (const command of commands) {
        if (!(await writable(command.name))) {
          rejected.push({ name: command.name, reason: "invalid-name" as const });
        }
      }
      if (rejected.length > 0) return { ok: false, rejected };
      const result = await batch(
        commands.map((command): RefCommand => ({ ...command, name: prefix + command.name })),
        options,
      );
      return {
        ok: result.ok,
        rejected: result.rejected.map((r) => ({
          ...r,
          name: stripNamespace(r.name, prefix) ?? r.name,
        })),
      };
    };
  }
  if (store.getShallow) namespaced.getShallow = store.getShallow.bind(store);
  if (store.setShallow) namespaced.setShallow = store.setShallow.bind(store);
  return namespaced;
}
