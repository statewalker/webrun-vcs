/**
 * `git patch-id` (builtin/patch-id.c): the patch-ids of the patches on its input, as
 * `git log -p` and `git format-patch` write them, one `<patch-id> <commit>` line each.
 *
 * @example
 * ```typescript
 * // git log -p -1 | git patch-id --stable
 * await git.patchId().setInput(logText).setMode("stable").call();
 * // { exitCode: 0, stdout: "<patch-id> <commit>\n", stderr: "" }
 * ```
 */

import { GitCommand } from "../git-command.js";
import type { PlumbingTextOutput } from "./check-ref-format-command.js";
import { configBool } from "./merge-config.js";
import { patchIdsOfPatchText } from "./patch-id.js";

/** `--unstable`, `--stable`, `--verbatim`. */
export type PatchIdMode = "unstable" | "stable" | "verbatim";

const encoder = new TextEncoder();

/**
 * `git patch-id [--stable | --unstable | --verbatim]` over {@link setInput} (git's stdin).
 * Without a mode, `patchid.stable` and `patchid.verbatim` decide (verbatim implies stable),
 * unstable when neither is set. Ids are of the repository's hash, as git's `the_hash_algo`.
 */
export class PatchIdCommand extends GitCommand<PlumbingTextOutput> {
  private input: Uint8Array = new Uint8Array(0);
  private mode?: PatchIdMode;

  /** The patches (git's stdin). */
  setInput(input: string | Uint8Array): this {
    this.checkCallable();
    this.input = typeof input === "string" ? encoder.encode(input) : input;
    return this;
  }

  /** `--unstable`, `--stable` or `--verbatim`; undefined lets the configuration decide. */
  setMode(mode: PatchIdMode | undefined): this {
    this.checkCallable();
    this.mode = mode;
    return this;
  }

  async call(): Promise<PlumbingTextOutput> {
    this.checkCallable();
    this.setCallable(false);
    let stable: boolean;
    let verbatim: boolean;
    if (this.mode !== undefined) {
      stable = this.mode !== "unstable";
      verbatim = this.mode === "verbatim";
    } else {
      verbatim = configBool(this._workingCopy, "patchid.verbatim", false);
      stable = verbatim || configBool(this._workingCopy, "patchid.stable", false);
    }
    const stdout = patchIdsOfPatchText(this.input, {
      stable,
      verbatim,
      objectFormat: this.objectFormat,
    });
    return { exitCode: 0, stdout, stderr: "" };
  }
}
