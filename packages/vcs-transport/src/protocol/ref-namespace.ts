/**
 * git's ref namespaces (`GIT_NAMESPACE`, `git --namespace=<ns>`, gitnamespaces(7)): one
 * repository served as several, each namespace's refs stored under `refs/namespaces/<ns>/`.
 *
 * ```ts
 * gitNamespacePrefix("a/b"); // "refs/namespaces/a/refs/namespaces/b/"
 * gitNamespacePrefix("//"); // throws GitNamespaceError: bad git namespace path "//"
 * gitNamespacePrefix(""); // "": no namespace
 * ```
 */

import { isValidRefName } from "@statewalker/vcs-core";

/** A `GIT_NAMESPACE` git refuses (`bad git namespace path "<ns>"`, a death). */
export class GitNamespaceError extends Error {
  constructor(readonly namespace: string) {
    super(`bad git namespace path "${namespace}"`);
    this.name = "GitNamespaceError";
  }
}

/**
 * The ref prefix of the namespace `namespace` (git's `get_git_namespace`): each non-empty
 * `/`-separated component becomes `refs/namespaces/<component>/`, nested; "" (no namespace)
 * for an empty or absent value. Throws {@link GitNamespaceError} for a value whose prefix is
 * no valid ref name (git dies), such as `/` alone or a component with `..`.
 */
export function gitNamespacePrefix(namespace: string | undefined): string {
  if (!namespace) return "";
  let prefix = "";
  for (const part of namespace.split("/")) {
    if (part) prefix += `refs/namespaces/${part}/`;
  }
  const name = prefix.replace(/\/+$/, "");
  if (!name || !isValidRefName(name)) throw new GitNamespaceError(namespace);
  return `${name}/`;
}

/** `name` without the namespace's `prefix`, or undefined outside it (git's `strip_namespace`). */
export function stripNamespace(name: string, prefix: string): string | undefined {
  return name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
}
