/**
 * The revision expressions a push source (`main~1:refs/heads/x`) or a lease value
 * (`--force-with-lease=main:abc1234`) may be, resolved against the local repository: the part
 * of git's `get_oid` a push needs.
 */

import type { RepositoryFacade } from "../api/repository-facade.js";

/** What revisions are resolved against. */
export interface RevisionSource {
  /** Local refs (`refs/…`), name to object id */
  refs: ReadonlyMap<string, string>;
  /** The local HEAD's value */
  head?: { oid?: string };
  /** The local objects: existence, commits (parents, tree), tags, abbreviated ids */
  repository: Pick<
    RepositoryFacade,
    | "has"
    | "getCommitInfo"
    | "peelTag"
    | "getObjectType"
    | "getTagInfo"
    | "resolvePrefix"
    | "objectFormat"
  >;
}

// git's ref_rev_parse_rules, in the order `dwim_ref` tries them
const RULES = [
  "%s",
  "refs/%s",
  "refs/tags/%s",
  "refs/heads/%s",
  "refs/remotes/%s",
  "refs/remotes/%s/HEAD",
];

/**
 * Resolves a revision expression to an object id, or undefined when it names nothing here:
 *
 * - a ref name, full or short (`main`, `heads/main`, `refs/tags/v1`; git's rev-parse rules, the
 *   first that exists), `HEAD` or `@`
 * - an object id, full or abbreviated (4 or more hex digits, unique among the local objects;
 *   needs the facade's `resolvePrefix`)
 * - followed by any of `~N` (the Nth first-parent ancestor), `^N` (the Nth parent; `^0` the
 *   commit itself), `^{}` (a tag peeled), `^{commit}`, `^{tree}`, `^{tag}`, `^{blob}`,
 *   `^{object}`
 *
 * @example
 * ```ts
 * await resolveRevision("main~1", source); // main's first parent
 * await resolveRevision("v1^{tree}", source); // the tree of the commit tag v1 names
 * ```
 */
export async function resolveRevision(
  expr: string,
  source: RevisionSource,
): Promise<string | undefined> {
  const at = firstSuffix(expr);
  const base = expr.slice(0, at);
  let oid = await resolveBase(base, source);
  let rest = expr.slice(at);
  while (oid && rest) {
    let m = /^\^\{([a-z]*)\}/.exec(rest);
    if (m) {
      oid = await peel(oid, m[1] as string, source);
      rest = rest.slice(m[0].length);
      continue;
    }
    m = /^([~^])(\d*)/.exec(rest);
    if (!m) return undefined;
    const n = m[2] ? Number.parseInt(m[2], 10) : 1;
    rest = rest.slice(m[0].length);
    let commit = await peel(oid, "commit", source);
    if (!commit) return undefined;
    if (m[1] === "~") {
      for (let i = 0; i < n && commit; i++) {
        commit = (await source.repository.getCommitInfo?.(commit))?.parents[0];
      }
      oid = commit;
    } else {
      oid = n === 0 ? commit : (await source.repository.getCommitInfo?.(commit))?.parents[n - 1];
    }
  }
  return rest ? undefined : oid;
}

/** Where the suffixes (`~`, `^`) start. */
function firstSuffix(expr: string): number {
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "~" || expr[i] === "^") return i;
  }
  return expr.length;
}

async function resolveBase(base: string, source: RevisionSource): Promise<string | undefined> {
  if (!base) return undefined;
  if (base === "HEAD" || base === "@") return source.head?.oid;
  for (const rule of RULES) {
    const oid = source.refs.get(rule.replace("%s", base));
    if (oid) return oid;
  }
  // a full id of the repository's width (git's get_oid_hex: the_hash_algo's hexsz)
  const hex = source.repository.objectFormat?.hexLength ?? 40;
  if (base.length === hex && /^[0-9a-f]+$/.test(base)) {
    return (await source.repository.has(base)) ? base : undefined;
  }
  if (
    base.length >= 4 &&
    base.length < hex &&
    /^[0-9a-f]+$/.test(base) &&
    source.repository.resolvePrefix
  ) {
    const found = await source.repository.resolvePrefix(base);
    return found.length === 1 ? found[0] : undefined;
  }
  return undefined;
}

/** `oid` peeled to `type` ("" = every tag peeled; "object" = itself). */
async function peel(
  oid: string,
  type: string,
  source: RevisionSource,
): Promise<string | undefined> {
  const { repository } = source;
  const typeOf = async (o: string) => {
    if (repository.getObjectType) return repository.getObjectType(o);
    if (await repository.getCommitInfo?.(o)) return "commit";
    return (await repository.has(o)) ? "object" : undefined;
  };
  let current: string | undefined = oid;
  for (let depth = 0; current && depth < 32; depth++) {
    const t = await typeOf(current);
    if (!t) return undefined;
    if (type === "object") return current;
    if (t === type) return current;
    if (t === "tag") {
      if (type === "tag") return current;
      const target: string | null | undefined =
        (await repository.getTagInfo?.(current))?.object ?? (await repository.peelTag?.(current));
      if (!target || target === current) return undefined;
      current = target;
      continue;
    }
    if (type === "") return current;
    if (type === "tree" && t === "commit") return (await repository.getCommitInfo?.(current))?.tree;
    return undefined;
  }
  return undefined;
}
