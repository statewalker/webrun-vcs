/**
 * What `git init` probes the filesystem for besides modes and links: whether it folds case,
 * and whether it folds Unicode decomposed names to precomposed ones (HFS+, APFS).
 */

import { joinPath, type PosixFilesApi } from "@statewalker/vcs-core";

/** What {@link probeCaseFolding} found. */
export interface CaseFolding {
  /** `.git/CoNfIg` names `.git/config` (`core.ignorecase = true`) */
  ignoreCase: boolean;
  /** A file created as `ä` (NFC) is found as `ä` (NFD) (`core.precomposeunicode = true`) */
  precomposeUnicode: boolean;
}

/**
 * Probes the storage under `gitDir` as `git init` does: the repository's `config` looked up
 * as `CoNfIg` (git's ignorecase probe), and a file created with a precomposed name looked up
 * by its decomposed spelling (git's `probe_utf8_pathname_composition`, removed again).
 *
 * Only a real filesystem folds names, and only a FilesApi with `lstat` is taken for one: any
 * other (memory, browser, object store) is reported case-sensitive and composition-keeping.
 * The repository's `config` must exist.
 *
 * @example
 * ```typescript
 * const folding = await probeCaseFolding(createNodeFilesApi({ rootDir }), ".git");
 * if (folding.ignoreCase) config.set("core.ignorecase", "true");
 * ```
 */
export async function probeCaseFolding(files: PosixFilesApi, gitDir: string): Promise<CaseFolding> {
  const none = { ignoreCase: false, precomposeUnicode: false };
  if (!files.lstat) return none;
  const lstat = files.lstat.bind(files);
  const exists = async (path: string) => (await lstat(path).catch(() => undefined)) !== undefined;
  if (!(await exists(joinPath(gitDir, "config")))) return none;
  const ignoreCase = await exists(joinPath(gitDir, "CoNfIg"));

  let precomposeUnicode = false;
  const nfc = joinPath(gitDir, "ä");
  const nfd = joinPath(gitDir, "ä");
  const created = files.createExclusive
    ? await files.createExclusive(nfc, []).catch(() => false)
    : false;
  if (created) {
    try {
      precomposeUnicode = await exists(nfd);
    } finally {
      await files.remove(nfc).catch(() => false);
    }
  }
  return { ignoreCase, precomposeUnicode };
}
