/**
 * `git history reword|split` against the git on `PATH` (t3450, t3451, t3452): skipped when
 * that git has no `git history` (before 2.54, as the sandbox's 2.43). See
 * `history-native-support.ts`.
 */

import { hasHistory, historyTwins, type NativeGit } from "./history-native-support.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const native: NativeGit = { binary: "git", env: nativeGitEnv };

historyTwins(
  "git history, native twins (t3451-history-reword.sh, t3452-history-split.sh)",
  nativeGitAvailable() && hasHistory(native) ? native : undefined,
);
