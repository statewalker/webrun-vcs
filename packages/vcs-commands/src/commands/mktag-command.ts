/**
 * `git mktag` (builtin/mktag.c): a tag object written from its raw text after git's strict
 * fsck check (`fsck_tag_standalone`), the tagged object read and its type checked.
 *
 * @example
 * ```typescript
 * const { id } = await git
 *   .mktag()
 *   .setInput(`object ${commitId}\ntype commit\ntag v1\ntagger T <t@example.com> 0 +0000\n\nv1\n`)
 *   .call();
 * ```
 */

import { replacementOf } from "@statewalker/vcs-core";
import { MktagFailedError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { fsckTag, type IdShape } from "./fsck/fsck-object-checks.js";
import { FSCK_MSG_IDS, FsckMessageTypes, type FsckMsgId } from "./fsck/fsck-msg-ids.js";
import { configValue } from "./merge-config.js";

/** Result of {@link MktagCommand}. */
export interface MktagResult {
  /** The tag object's id (what git prints on stdout) */
  id: string;
  /**
   * git's stderr of a run that succeeded: `--no-strict`'s `warning: tag input ...` lines,
   * and the `error:` lines of a check whose error a later warning's result hid (fsck's `ret`)
   */
  messages: string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TYPES = new Set(["commit", "tree", "blob", "tag"]);

/**
 * Writes a tag object from its text (`git mktag`), refusing what git refuses.
 *
 * The input passes fsck's tag checks with `--strict` severities, where a warning (a missing
 * tagger, a bad tag name, an extra header, which `fsck.extraHeaderEntry` makes a warning
 * here) is an error too, unless {@link setStrict} is off: it is then printed as
 * `warning: tag input does not pass fsck: <id>: <text>`. Each failing message is printed as
 * `error: tag input does not pass fsck: <id>: <text>`, and the command dies with `fatal: tag
 * on stdin did not pass our strict fsck check` (thrown as {@link MktagFailedError}, its
 * message the whole stderr). The tagged object is read through replace refs and must be of
 * the type the tag names.
 *
 * git 2.43 (`setCompatibility("2.43")`) has no `gpgsig` header in tags: one after the tagger
 * is an extra header.
 */
export class MktagCommand extends GitCommand<MktagResult> {
  private input: Uint8Array = new Uint8Array(0);
  private strict = true;
  private compatibility: "2.43" | "2.56" = "2.56";

  /** The tag's text (git reads it from stdin). */
  setInput(input: string | Uint8Array): this {
    this.checkCallable();
    this.input = typeof input === "string" ? encoder.encode(input) : input;
    return this;
  }

  /** `--[no-]strict` (default on): fsck warnings are errors. */
  setStrict(strict: boolean): this {
    this.checkCallable();
    this.strict = strict;
    return this;
  }

  /** The git version whose checks are followed (default 2.56). */
  setCompatibility(version: "2.43" | "2.56"): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<MktagResult> {
    this.checkCallable();
    this.setCallable(false);
    const stderr: string[] = [];
    const die = (line: string): never => {
      throw new MktagFailedError([...stderr, `fatal: ${line}`].join("\n"));
    };

    // fsck_options_init(FSCK_OPTIONS_STRICT), extraHeaderEntry made a warning, then the
    // config's fsck.<msg-id> (which may set it again)
    const types = new FsckMessageTypes({ strict: true });
    types.set("extraHeaderEntry", "warn");
    for (const id of Object.keys(FSCK_MSG_IDS)) {
      const value = configValue(this.workingCopy, `fsck.${id}`);
      if (value === undefined) continue;
      try {
        types.set(id, value);
      } catch (error) {
        die((error as Error).message);
      }
    }
    // mktag_fsck_error_func
    const report = (msgId: FsckMsgId, text: string): number => {
      const severity = types.severity(msgId);
      if (severity === "ignore") return 0;
      const message = `${msgId}: ${text}`;
      if (severity === "warning" && !this.strict) {
        stderr.push(`warning: tag input does not pass fsck: ${message}`);
        return 0;
      }
      stderr.push(`error: tag input does not pass fsck: ${message}`);
      return 1;
    };
    const format = this.objectFormat;
    const shape: IdShape = { rawLength: format.rawLength, hexLength: format.hexLength };
    if (
      fsckTag(this.input, report, { gpgsig: this.compatibility !== "2.43", shape }) !== 0
    ) {
      die("tag on stdin did not pass our strict fsck check");
    }

    // what fsck_tag_standalone parsed: the object line's id and the type line's name
    const text = decoder.decode(this.input);
    const taggedId = text.slice("object ".length, "object ".length + format.hexLength).toLowerCase();
    const typeLine = text.slice(text.indexOf("\n") + 1);
    const taggedType = typeLine.slice("type ".length, typeLine.indexOf("\n"));
    if (!TYPES.has(taggedType)) die("tag on stdin did not pass our strict fsck check");

    // verify_object_in_tag: read through replace refs, as odb_read_object
    const objects = this.workingCopy.history?.objects;
    if (!objects) throw new Error("mktag needs the object store (history.objects)");
    const replacements = this.useReplaceRefs() ? await this.objectReplacements() : undefined;
    const read = replacements ? replacementOf(replacements.replace, taggedId) : taggedId;
    // the entry's header where the store answers it (oid_object_info), else the object
    const header =
      (await objects.header?.(read).catch(() => undefined)) ??
      (await objects
        .get(read)
        .then(async (o) => {
          await o?.content[Symbol.asyncIterator]().return?.();
          return o ? { type: o.type, size: o.size } : undefined;
        })
        .catch(() => undefined));
    if (!header) die(`could not read tagged object '${taggedId}'`);
    const type = (header as { type: string }).type;
    if (type !== taggedType) {
      die(`object '${taggedId}' tagged as '${taggedType}', but is a '${type}' type`);
    }

    const id = await objects.put("tag", this.input.length, [this.input]);
    return { id, messages: stderr };
  }
}
