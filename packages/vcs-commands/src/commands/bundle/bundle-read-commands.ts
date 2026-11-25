/**
 * `git bundle verify`, `git bundle list-heads` and `git bundle unbundle` (builtin/bundle.c):
 * a bundle read, checked against the repository, listed, or its pack stored.
 *
 * @example
 * ```typescript
 * const bytes = await readFile(files, "repo.bundle");
 * // git bundle verify repo.bundle
 * const { exitCode, stdout, stderr } = await git.bundleVerify().setBundle(bytes, "repo.bundle").call();
 * // git bundle list-heads repo.bundle refs/heads/main
 * await git.bundleListHeads().setBundle(bytes).addRefName("refs/heads/main").call();
 * // git bundle unbundle repo.bundle (then update refs from the printed list)
 * const { refs } = await git.bundleUnbundle().setBundle(bytes).call();
 * ```
 */

import type { BundleHeader, BundleRef } from "./bundle-format.js";
import { listBundleRefs } from "./bundle-format.js";
import { BundleCommandBase } from "./bundle-support.js";
import {
  type BundleCommandResult,
  type BundleInput,
  bundleBytes,
  openBundle,
} from "./bundle-verify.js";

/** What a bundle command read. */
export interface BundleReadResult extends BundleCommandResult {
  /** The bundle's header, once it was read */
  header?: BundleHeader;
}

/** What `git bundle unbundle` did. */
export interface BundleUnbundleResult extends BundleReadResult {
  /** The refs listed on stdout (all, or those named) */
  refs: BundleRef[];
  /** The pack stored (when the store keeps packs) */
  packId?: string;
}

/** The setters every bundle reader takes. */
abstract class BundleReadCommand<T> extends BundleCommandBase<T> {
  protected input?: BundleInput;
  protected name = "<stdin>";
  protected readonly refNames: string[] = [];

  /**
   * The bundle's bytes, and the name git reports it by (its path as given; `<stdin>` for
   * `-`, the default).
   */
  setBundle(bundle: BundleInput, name = "<stdin>"): this {
    this.checkCallable();
    this.input = bundle;
    this.name = name;
    return this;
  }

  /** `[<refname>...]`: only these refs are listed (exact names). */
  addRefName(name: string): this {
    this.checkCallable();
    this.refNames.push(name);
    return this;
  }

  protected async read() {
    this.checkCallable();
    this.setCallable(false);
    if (this.input === undefined) {
      return { ok: false as const, error: "fatal: need a <file> argument\n" };
    }
    return openBundle(await bundleBytes(this.input), this.name);
  }
}

/**
 * `git bundle verify [-q] <file>`: the header read, every prerequisite present and connected
 * to the refs (`error: Repository lacks these prerequisite commits:` and one `error: <id> `
 * line per missing one, or `error: some prerequisite commits exist in the object store, but
 * are not connected to the repository's history`; exit 1), what the bundle holds on stdout
 * (unless quiet) and `<file> is okay` on stderr.
 */
export class BundleVerifyCommand extends BundleReadCommand<BundleReadResult> {
  private quiet = false;

  /** `-q` / `--quiet`: no details on stdout, no line per missing prerequisite. */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  async call(): Promise<BundleReadResult> {
    const opened = await this.read();
    if (!opened.ok) return { exitCode: 1, stdout: "", stderr: opened.error };
    const { header } = opened.bundle;
    const verified = await this.verifyBundle(
      header,
      this.quiet ? { quiet: true } : { verbose: true },
    );
    // verify_bundle prints the details even when the connectivity check failed
    if (!verified.ok) {
      return { exitCode: 1, stdout: verified.stdout, stderr: verified.stderr, header };
    }
    return {
      exitCode: 0,
      stdout: verified.stdout,
      stderr: `${verified.stderr}${this.name} is okay\n`,
      header,
    };
  }
}

/**
 * `git bundle list-heads <file> [<refname>...]`: the bundle's refs, `<id> <name>` each
 * (only those named). It reads no repository (git runs it outside one).
 */
export class BundleListHeadsCommand extends BundleReadCommand<BundleReadResult> {
  async call(): Promise<BundleReadResult> {
    const opened = await this.read();
    if (!opened.ok) return { exitCode: 1, stdout: "", stderr: opened.error };
    const { header } = opened.bundle;
    return {
      exitCode: 0,
      stdout: listBundleRefs(header.references, this.refNames),
      stderr: "",
      header,
    };
  }
}

/**
 * `git bundle unbundle <file> [<refname>...]`: the bundle verified as `verify` does (its
 * lines on failure, exit 1), its pack stored (kept as a pack, a filtered bundle's marked as a
 * promisor pack, `from-bundle`), then its refs listed on stdout. No ref is written: the
 * caller updates them from the list (as git's porcelain does).
 */
export class BundleUnbundleCommand extends BundleReadCommand<BundleUnbundleResult> {
  async call(): Promise<BundleUnbundleResult> {
    const opened = await this.read();
    if (!opened.ok) return { exitCode: 1, stdout: "", stderr: opened.error, refs: [] };
    const { header } = opened.bundle;
    const unbundled = await this.unbundleInto(opened.bundle);
    if (!unbundled.ok) {
      return { exitCode: 1, stdout: "", stderr: unbundled.stderr, header, refs: [] };
    }
    const names = this.refNames;
    const refs = header.references.filter((r) => names.length === 0 || names.includes(r.name));
    return {
      exitCode: 0,
      stdout: listBundleRefs(header.references, names),
      stderr: "",
      header,
      refs,
      ...(unbundled.packId !== undefined ? { packId: unbundled.packId } : {}),
    };
  }
}
