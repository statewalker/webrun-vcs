/**
 * `git verify-commit` (builtin/verify-commit.c) and `git verify-tag` (builtin/verify-tag.c,
 * tag.c's `gpg_verify_tag`): each object's signature checked through the host's verifier
 * (see {@link checkSignature}), what git prints gathered as its stdout and stderr.
 *
 * @example
 * ```typescript
 * const { exitCode, stderr } = await git.verifyCommit().addCommit("HEAD").call();
 * // stderr: "gpg: Signature made ...\ngpg: Good signature from ..."
 * const raw = await git.verifyTag().addTag("v1").setRaw(true).call();
 * // raw.stderr: "[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG ..."
 * ```
 *
 * @module
 */
import type { ObjectId } from "@statewalker/vcs-core";

import { GitApiError, RefNotFoundError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { type SignatureCheck, verifyCommitBytes, verifyTagBytes } from "./signature-check.js";

/** What `git verify-commit` / `git verify-tag` printed and its exit status. */
export interface VerifyResult {
  /** 0 when every object had a signature good enough, else 1 */
  readonly exitCode: 0 | 1;
  /** git's stdout: with `-v`, each payload (a tag without signature: the whole tag) */
  readonly stdout: Uint8Array;
  /** git's stderr: errors, then each check's output (`--raw`: gpg's status lines) */
  readonly stderr: string;
  /** Each object named, in order, with its check when one was made */
  readonly checks: readonly { name: string; id?: ObjectId; check?: SignatureCheck }[];
}

/** One object's verification as the command's loop runs it. */
interface VerifyOutput {
  out: Uint8Array[];
  err: string[];
  checks: { name: string; id?: ObjectId; check?: SignatureCheck }[];
}

const TYPE_NAMES = new Set(["commit", "tree", "blob", "tag"]);

abstract class VerifyCommandBase extends GitCommand<VerifyResult> {
  protected readonly names: string[] = [];
  protected verbose = false;
  protected raw = false;

  /** `-v` / `--verbose`: the object's contents on stdout. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /** `--raw`: gpg's status lines instead of its human-readable output. */
  setRaw(raw: boolean): this {
    this.checkCallable();
    this.raw = raw;
    return this;
  }

  /** The object's type and bytes as stored (undefined when absent). */
  protected async readObject(
    id: ObjectId,
  ): Promise<{ type: string; bytes: Uint8Array } | undefined> {
    const objects = this.workingCopy.history?.objects;
    if (!objects) return undefined;
    const obj = await objects.get(id).catch(() => undefined);
    if (!obj) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const c of obj.content) {
      chunks.push(c);
      size += c.length;
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { type: obj.type, bytes };
  }

  /** `repo_get_oid`: the object a name gives, undefined when it names none. */
  protected async lookup(name: string): Promise<ObjectId | undefined> {
    try {
      return await this.resolveRevision(name);
    } catch (error) {
      if (error instanceof RefNotFoundError) return undefined;
      throw error;
    }
  }

  /** gpg-interface.c's `print_signature_buffer` */
  protected print(check: SignatureCheck, output: VerifyOutput): void {
    if (this.verbose && check.payload) output.out.push(check.payload);
    const text = this.raw ? check.status : check.output;
    if (text) output.err.push(text);
  }

  protected abstract verifyOne(name: string, output: VerifyOutput): Promise<boolean>;

  async call(): Promise<VerifyResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.names.length === 0) {
      throw new GitApiError(this.usage(), { exitCode: 129 });
    }
    const output: VerifyOutput = { out: [], err: [], checks: [] };
    let failed = false;
    for (const name of this.names) {
      if (!(await this.verifyOne(name, output))) failed = true;
    }
    const size = output.out.reduce((n, b) => n + b.length, 0);
    const stdout = new Uint8Array(size);
    let at = 0;
    for (const b of output.out) {
      stdout.set(b, at);
      at += b.length;
    }
    return {
      exitCode: failed ? 1 : 0,
      stdout,
      stderr: output.err.join(""),
      checks: output.checks,
    };
  }

  protected abstract usage(): string;

  /** The check's own lines (git's `error()`/`warning()` on the way), with newlines. */
  protected messages(check: SignatureCheck, output: VerifyOutput): void {
    for (const line of check.messages) output.err.push(`${line}\n`);
  }
}

/**
 * `git verify-commit [-v | --verbose] [--raw] <commit>...`: each commit's `gpgsig` checked.
 * A name that names nothing is `error: commit '<name>' not found.`, one of another type
 * `error: <name>: cannot verify a non-commit object of type <type>.`; an unsigned commit
 * fails silently. Exit 1 when any fails.
 */
export class VerifyCommitCommand extends VerifyCommandBase {
  /** A commit to verify (any revision). */
  addCommit(name: string): this {
    this.checkCallable();
    this.names.push(name);
    return this;
  }

  protected usage(): string {
    return "usage: git verify-commit [-v | --verbose] [--raw] <commit>...";
  }

  protected async verifyOne(name: string, output: VerifyOutput): Promise<boolean> {
    const id = await this.lookup(name);
    if (id === undefined) {
      output.err.push(`error: commit '${name}' not found.\n`);
      output.checks.push({ name });
      return false;
    }
    const object = await this.readObject(id);
    if (!object) {
      output.err.push(`error: ${name}: unable to read file.\n`);
      output.checks.push({ name, id });
      return false;
    }
    if (object.type !== "commit") {
      output.err.push(
        `error: ${name}: cannot verify a non-commit object of type ${object.type}.\n`,
      );
      output.checks.push({ name, id });
      return false;
    }
    const cwd = await this.hostWorkingDir();
    const check = await verifyCommitBytes(this.workingCopy, object.bytes, {
      objectFormat: this.objectFormat,
      ...(cwd !== undefined ? { cwd } : {}),
    });
    this.messages(check, output);
    this.print(check, output);
    output.checks.push({ name, id, check });
    return !check.failed;
  }
}

/**
 * `git verify-tag [-v | --verbose] [--raw] <tag>...`: each tag's appended signature
 * checked. A name that names nothing is `error: tag '<name>' not found.`, one of another
 * type `error: <name>: cannot verify a non-tag object of type <type>.`, a tag without a
 * signature `error: no signature found` (`-v` prints the tag first). Exit 1 when any fails.
 */
export class VerifyTagCommand extends VerifyCommandBase {
  /** A tag to verify (any revision naming a tag object). */
  addTag(name: string): this {
    this.checkCallable();
    this.names.push(name);
    return this;
  }

  protected usage(): string {
    return "usage: git verify-tag [-v | --verbose] [--format=<format>] [--raw] <tag>...";
  }

  protected async verifyOne(name: string, output: VerifyOutput): Promise<boolean> {
    const id = await this.lookup(name);
    if (id === undefined) {
      output.err.push(`error: tag '${name}' not found.\n`);
      output.checks.push({ name });
      return false;
    }
    const object = await this.readObject(id);
    if (!object || object.type !== "tag") {
      const type = object?.type && TYPE_NAMES.has(object.type) ? object.type : "(null)";
      output.err.push(`error: ${name}: cannot verify a non-tag object of type ${type}.\n`);
      output.checks.push({ name, id });
      return false;
    }
    const cwd = await this.hostWorkingDir();
    const check = await verifyTagBytes(this.workingCopy, object.bytes, {
      ...(cwd !== undefined ? { cwd } : {}),
    });
    if (!check) {
      if (this.verbose) output.out.push(object.bytes);
      output.err.push("error: no signature found\n");
      output.checks.push({ name, id });
      return false;
    }
    this.messages(check, output);
    this.print(check, output);
    output.checks.push({ name, id, check });
    return !check.failed;
  }
}
