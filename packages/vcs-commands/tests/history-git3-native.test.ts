/**
 * `git history reword|split` against git master as `$GIT3` (the git3-oracle workflow builds
 * it): the twins of `history-native.test.ts` where CI's release git may predate the command.
 * `git history` does not depend on `breakingChanges`; the fixtures stay on the files ref
 * backend. Skipped without `$GIT3`.
 */

import { historyTwins, type NativeGit } from "./history-native-support.js";
import { git3Binary, nativeGit3Env } from "./native-git3.js";

const binary = git3Binary();

historyTwins(
  "git history under git master, native twins (t3451-history-reword.sh, t3452-history-split.sh)",
  binary ? ({ binary, env: nativeGit3Env } satisfies NativeGit) : undefined,
);
