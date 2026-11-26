/**
 * Ref namespaces (`GIT_NAMESPACE`): the namespace prefix, hidden refs under a namespace and
 * the namespace's view of a served ref store, which must never reach a ref outside it.
 */
import type { RefCommand } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import {
  GitNamespaceError,
  gitNamespacePrefix,
  isRefHidden,
  namespacedRefStore,
  type RefStore,
  stripNamespace,
} from "../src/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const NS = "refs/namespaces/ns/";

/** A ref store over a map: `ref: <name>` values are symbolic refs. */
function mapStore(entries: Record<string, string>) {
  const refs = new Map(Object.entries(entries));
  const writes: string[] = [];
  const resolve = (name: string): string | undefined => {
    let value = refs.get(name);
    for (let i = 0; value?.startsWith("ref: ") && i < 10; i++) value = refs.get(value.slice(5));
    return value?.startsWith("ref: ") ? undefined : value;
  };
  const store: RefStore = {
    async get(name) {
      return resolve(name);
    },
    async update(name, oid) {
      writes.push(`${name}=${oid}`);
      refs.set(name, oid);
    },
    async batch(commands: RefCommand[]) {
      for (const c of commands) writes.push(`${c.name}=${c.new}`);
      return { ok: true, rejected: [] };
    },
    async listAll() {
      const out: Array<[string, string]> = [];
      for (const name of [...refs.keys()].sort()) {
        const id = resolve(name);
        if (id) out.push([name, id]);
      }
      return out;
    },
    async getSymrefTarget(name) {
      const value = refs.get(name);
      return value?.startsWith("ref: ") ? value.slice(5) : undefined;
    },
  };
  return { store, writes };
}

describe("gitNamespacePrefix (git's get_git_namespace)", () => {
  it("nests each component and drops empty ones", () => {
    expect(gitNamespacePrefix(undefined)).toBe("");
    expect(gitNamespacePrefix("")).toBe("");
    expect(gitNamespacePrefix("ns")).toBe("refs/namespaces/ns/");
    expect(gitNamespacePrefix("/a//b/")).toBe("refs/namespaces/a/refs/namespaces/b/");
    expect(stripNamespace("refs/namespaces/ns/refs/heads/x", NS)).toBe("refs/heads/x");
    expect(stripNamespace("refs/heads/x", NS)).toBeUndefined();
  });

  it("refuses what git dies on (bad git namespace path)", () => {
    for (const bad of ["/", "a..b", "a.lock", "a b", "x:y"]) {
      expect(() => gitNamespacePrefix(bad)).toThrow(GitNamespaceError);
    }
    expect(() => gitNamespacePrefix("/")).toThrow('bad git namespace path "/"');
  });
});

describe("isRefHidden under a namespace (ref_is_hidden(refname, refname_full))", () => {
  it("matches plain patterns on the stripped name, ^ patterns on the full name", () => {
    expect(isRefHidden("refs/tags/v1", ["refs/tags"], NS)).toBe(true);
    expect(isRefHidden("refs/tags/v1", [`${NS}refs/tags`], NS)).toBe(false);
    expect(isRefHidden("refs/tags/v1", [`^${NS}refs/tags`], NS)).toBe(true);
    expect(isRefHidden("refs/tags/v1", ["^refs/namespaces/ns"], NS)).toBe(true);
    expect(isRefHidden("refs/tags/v1", ["^refs/tags"], NS)).toBe(false);
    expect(isRefHidden("refs/tags/v1", ["^refs/namespaces/n"], NS)).toBe(false);
    expect(isRefHidden("HEAD", [`^${NS}HEAD`], NS)).toBe(true);
    expect(isRefHidden("refs/tags/v1", [`^${NS}refs/tags`, `!^${NS}refs/tags/v1`], NS)).toBe(false);
  });
});

describe("namespacedRefStore", () => {
  const entries = {
    HEAD: "ref: refs/heads/main",
    "refs/heads/main": A,
    "refs/heads/secret": C,
    [`${NS}HEAD`]: `ref: ${NS}refs/heads/two`,
    [`${NS}refs/heads/one`]: A,
    [`${NS}refs/heads/two`]: B,
    // symbolic refs of the namespace leaving it: never read, listed or written through
    [`${NS}refs/heads/escape`]: "ref: refs/heads/secret",
    [`${NS}refs/remotes/o/HEAD`]: `ref: ${NS}refs/heads/escape`,
    [`${NS}refs/heads/inside`]: `ref: ${NS}refs/heads/one`,
    "refs/namespaces/other/refs/heads/x": C,
  };

  it("lists HEAD and the namespace's refs, named without the prefix", async () => {
    const { store } = mapStore(entries);
    const view = namespacedRefStore(store, NS);
    expect(await view.listAll()).toEqual([
      ["HEAD", B],
      ["refs/heads/inside", A],
      ["refs/heads/one", A],
      ["refs/heads/two", B],
    ]);
    expect(await view.getSymrefTarget?.("HEAD")).toBe("refs/heads/two");
    expect(await view.getSymrefTarget?.("refs/heads/inside")).toBe("refs/heads/one");
    expect(await view.get("refs/heads/two")).toBe(B);
    expect(await view.isRefTip?.(C)).toBe(false);
  });

  it("never reads a ref outside the namespace", async () => {
    const { store } = mapStore(entries);
    const view = namespacedRefStore(store, NS);
    expect(await view.get("refs/heads/escape")).toBeUndefined();
    expect(await view.get("refs/remotes/o/HEAD")).toBeUndefined();
    expect(await view.getSymrefTarget?.("refs/heads/escape")).toBeUndefined();
    expect(await view.get("ORIG_HEAD")).toBeUndefined();
    expect(await view.get("../../heads/main")).toBeUndefined();
    // a HEAD leaving the namespace is no HEAD
    const outside = namespacedRefStore(
      mapStore({ ...entries, [`${NS}HEAD`]: "ref: refs/heads/secret" }).store,
      NS,
    );
    expect(await outside.get("HEAD")).toBeUndefined();
    expect(await outside.getSymrefTarget?.("HEAD")).toBeUndefined();
    expect((await outside.listAll()).map(([n]) => n)).not.toContain("HEAD");
  });

  it("writes under the prefix, never through a symbolic ref leaving it", async () => {
    const { store, writes } = mapStore(entries);
    const view = namespacedRefStore(store, NS);
    await view.update("refs/heads/new", A);
    await expect(view.update("refs/heads/escape", A)).rejects.toThrow(/outside the namespace/);
    await expect(view.update("HEAD", A)).rejects.toThrow(/outside the namespace/);
    expect(await view.batch?.([{ name: "refs/heads/escape", new: A }])).toEqual({
      ok: false,
      rejected: [{ name: "refs/heads/escape", reason: "invalid-name" }],
    });
    expect(await view.batch?.([{ name: "refs/heads/two", old: B, new: A }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect(writes).toEqual([`${NS}refs/heads/new=${A}`, `${NS}refs/heads/two=${A}`]);
  });
});
