import type { ObjectId } from "@statewalker/vcs-core";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";

import { LogCommand } from "./log-command.js";

/**
 * `git show <id> --` of one commit, as the child git runs for `rebase --show-current-patch`
 * and `am --show-current-patch` prints it without a terminal: the configuration's format,
 * dates, notes and mailmap, then its patch (`--cc` for a merge, git show's default).
 */
export async function showCommitBytes(
  workingCopy: ConstructorParameters<typeof LogCommand>[0],
  id: ObjectId,
): Promise<Uint8Array> {
  return new LogCommand(workingCopy).add(id).setMaxCount(1).callBytes({ patch: true, cc: true });
}

/** {@link showCommitBytes} as text. */
export async function showCommit(
  workingCopy: ConstructorParameters<typeof LogCommand>[0],
  id: ObjectId,
): Promise<string> {
  return decodeGitPath(await showCommitBytes(workingCopy, id));
}
