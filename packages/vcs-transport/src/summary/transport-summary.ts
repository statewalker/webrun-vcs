/**
 * Abbreviated ids in fetch and push summaries, as git prints them: each id as long as
 * `repo_find_unique_abbrev` makes it under `core.abbrev` (unique among the local objects,
 * and at least the automatic length of the repository's size), and the summary column as
 * wide as `transport_summary_width` makes it (`2 * longest + 3`, room for `a...b`).
 *
 * @example
 * ```typescript
 * const lengths = await abbrevLengthsOf(repository, [oldOid, newOid], -1);
 * `${abbreviate(oldOid, lengths)}..${abbreviate(newOid, lengths)}`; // "1a2b3c4..5d6e7f8"
 * ```
 *
 * @module
 */

import type { RepositoryFacade } from "../api/repository-facade.js";

/** git's `FALLBACK_DEFAULT_ABBREV`: the length without a repository to ask */
export const FALLBACK_ABBREV_LENGTH = 7;

/** The abbreviated length of each id, as `findAbbrevLengths` of vcs-core gives them. */
export type AbbrevLengths = ReadonlyMap<string, number>;

/**
 * The lengths of `ids` through `repository.abbrevLengths` with `core.abbrev` = `abbrev` (-1,
 * the default, for git's automatic length); without it (or when it fails), `abbrev` itself
 * (7 for automatic), as a repository with no objects to compare with would give.
 */
export async function abbrevLengthsOf(
  repository: Pick<RepositoryFacade, "abbrevLengths">,
  ids: Iterable<string>,
  abbrev = -1,
): Promise<AbbrevLengths> {
  const wanted = [...new Set(ids)];
  if (repository.abbrevLengths && wanted.length > 0) {
    try {
      return await repository.abbrevLengths(wanted, abbrev);
    } catch {
      // the fixed length below
    }
  }
  const fixed = abbrev < 0 ? FALLBACK_ABBREV_LENGTH : abbrev === 0 ? 40 : Math.min(abbrev, 40);
  return new Map(wanted.map((id) => [id, fixed]));
}

/** `id` cut to its length in `lengths` (7 when it is not there). */
export function abbreviate(id: string, lengths?: AbbrevLengths): string {
  return id.slice(0, lengths?.get(id) ?? FALLBACK_ABBREV_LENGTH);
}

/**
 * git's `transport_summary_width`: twice the longest abbreviation of `ids` plus 3 (the
 * `...` of a forced update), or 17 (two fallback lengths) for no ids.
 */
export function transportSummaryWidth(ids: Iterable<string>, lengths?: AbbrevLengths): number {
  let max = -1;
  for (const id of ids) max = Math.max(max, lengths?.get(id) ?? FALLBACK_ABBREV_LENGTH);
  if (max < 0) max = FALLBACK_ABBREV_LENGTH;
  return 2 * max + 3;
}

/** git's `prettify_refname`: a branch, tag or remote-tracking ref without its prefix. */
export function prettifyRefName(name: string): string {
  for (const prefix of ["refs/heads/", "refs/tags/", "refs/remotes/"]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

/** `text` padded with spaces to `width` (git's `%-*s`), never cut. */
export function padSummary(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
