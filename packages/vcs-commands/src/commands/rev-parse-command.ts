/**
 * RevParseCommand - `git rev-parse --verify <rev>`: the object a revision names, through
 * the same resolver every command uses (see `revision-resolver.ts` for the syntax).
 *
 * @example
 * ```typescript
 * const { objectId } = await git.revParse().setRevision("main@{upstream}").call();
 * const { objectId: tree } = await git.revParse().setRevision("v1.0^{tree}").call();
 * const { warnings } = await git.revParse().setRevision("main@{1.year.ago}").call();
 * // warnings: ["warning: log for 'main' only goes back to Thu, 7 Apr 2005 22:13:13 +0000"]
 * ```
 */

import type { ObjectId } from "@statewalker/vcs-core";

import { MissingArgumentError, RefNotFoundError, RevisionError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";

/** What {@link RevParseCommand} found. */
export interface RevParseResult {
  /** The object the revision names (an annotated tag as the tag object) */
  readonly objectId: ObjectId;
  /** git's warnings while resolving it (`warning: log for 'x' only goes back to ...`) */
  readonly warnings: string[];
}

/**
 * Resolve one revision as `git rev-parse --verify` does.
 *
 * Throws `RefNotFoundError` ("fatal: Needed a single revision") when it names nothing, and
 * `RevisionError` with git's own `fatal:` line where git dies interpreting it
 * (`fatal: no upstream configured for branch 'x'`, `fatal: HEAD does not point to a
 * branch`, `fatal: log for 'x' only has 2 entries`).
 */
export class RevParseCommand extends GitCommand<RevParseResult> {
  private revision?: string;

  /** The revision to resolve (`HEAD~2`, `@{u}`, `main@{yesterday}`, `:/fix`, `HEAD:a.txt`). */
  setRevision(revision: string): this {
    this.checkCallable();
    this.revision = revision;
    return this;
  }

  async call(): Promise<RevParseResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.revision === undefined) throw new MissingArgumentError("revision");
    const resolver = this.revisionResolver();
    let objectId: ObjectId | undefined;
    try {
      objectId = await resolver.resolve(this.revision);
    } catch (error) {
      // what git printed before it died comes first
      if (error instanceof RevisionError && resolver.warnings.length > 0) {
        throw new RevisionError(this.revision, [...resolver.warnings, error.message].join("\n"));
      }
      throw error;
    }
    if (objectId === undefined) {
      const lines = [...resolver.warnings, "fatal: Needed a single revision"];
      throw new RefNotFoundError(this.revision, lines.join("\n"));
    }
    return { objectId, warnings: resolver.warnings };
  }
}
