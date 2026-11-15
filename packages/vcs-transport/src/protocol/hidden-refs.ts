/**
 * Hidden refs, as git's `transfer.hideRefs`, `uploadpack.hideRefs` and `receive.hideRefs`.
 *
 * ```ts
 * const hide = ["refs/pull", "!refs/pull/1", "^refs/internal"];
 * isRefHidden("refs/pull/7/head", hide); // true
 * isRefHidden("refs/pull/1/head", hide); // false: the later "!refs/pull/1" shows it again
 * isRefHidden("refs/pullx", hide); // false: a pattern matches whole components only
 * ```
 *
 * Each pattern is a ref prefix matched at a component boundary (`refs/pull` hides `refs/pull`
 * and `refs/pull/...`, never `refs/pullx`); trailing slashes are ignored. A leading `!`
 * negates it: a ref it matches is shown. The last pattern that matches decides, so a later
 * pattern overrides an earlier one, as in git's config (where `transfer.hideRefs` and the
 * service's own setting form one list in file order). A `^` after the optional `!` matches the
 * full ref name before git's namespace is stripped; without namespaces (we serve none) it is
 * the same name.
 *
 * Hidden refs are left out of the advertisement (v0/v1) and of `ls-refs` (v2), a v2
 * `want-ref` of one is refused as an unknown ref, an id wanted only through a hidden ref is
 * "not our ref" under the "ADVERTISED" request policy, and receive-pack refuses to change
 * one ("deny updating a hidden ref", "deny deleting a hidden ref").
 *
 * Hiding a ref is not access control, as in git: the objects of a hidden ref stay fetchable by
 * id under the "ANY" (protocol v2's default), "TIP" and reachable request policies, and HEAD
 * is still advertised when it names a hidden branch. Keep data private with a separate
 * repository, or the "ADVERTISED" policy plus an upload-pack `authorize` hook.
 */

/** Whether `refName` is hidden by `patterns` (git's `ref_is_hidden`). */
export function isRefHidden(refName: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns) return false;
  for (let i = patterns.length - 1; i >= 0; i--) {
    let match = patterns[i] as string;
    let negated = false;
    if (match.startsWith("!")) {
      negated = true;
      match = match.slice(1);
    }
    // `^`: the full name, namespace included; we serve no namespaces, so the same name
    if (match.startsWith("^")) match = match.slice(1);
    // git's parse_hide_refs_config drops trailing slashes
    while (match.endsWith("/")) match = match.slice(0, -1);
    if (!refName.startsWith(match)) continue;
    const rest = refName.charAt(match.length);
    if (rest === "" || rest === "/") return !negated;
  }
  return false;
}

/** The refs `patterns` do not hide, in their order. */
export function visibleRefs<T extends readonly [string, ...unknown[]]>(
  refs: Iterable<T>,
  patterns: readonly string[] | undefined,
): T[] {
  const out: T[] = [];
  for (const ref of refs) if (!isRefHidden(ref[0], patterns)) out.push(ref);
  return out;
}
