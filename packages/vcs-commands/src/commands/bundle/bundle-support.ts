/**
 * What the bundle commands share: bundle.c's `verify_bundle` and `unbundle` over a
 * repository, and the text git prints for them.
 */

import { historyWithoutLazyFetch, type ObjectId } from "@statewalker/vcs-core";
import { connectivityErrors, createRepositoryFacade } from "@statewalker/vcs-transport";

import { GitCommand } from "../../git-command.js";
import { type BundleHeader, listBundleRefs, parseBundleHeader } from "./bundle-format.js";

/** git's text and exit status for a bundle command. */
export interface BundleCommandResult {
  /** 0, or git's exit status (1 for an `error()` return) */
  exitCode: number;
  /** What git prints on stdout */
  stdout: string;
  /** What git prints on stderr (`error:` lines, `<file> is okay`) */
  stderr: string;
}

/** How {@link BundleCommandBase.verifyBundle} reports (bundle.h `verify_bundle_flags`). */
export interface VerifyBundleOptions {
  /** VERIFY_BUNDLE_VERBOSE: the refs, the prerequisites, the hash and filter on stdout */
  verbose?: boolean;
  /** VERIFY_BUNDLE_QUIET: no line per missing prerequisite */
  quiet?: boolean;
}

/** A bundle's bytes as the commands take them: whole, or a stream of chunks. */
export type BundleInput = Uint8Array | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/** The bytes of a {@link BundleInput}, collected. */
export async function bundleBytes(input: BundleInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of input as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A bundle read: its header and its pack. */
export interface OpenedBundle {
  header: BundleHeader;
  pack: Uint8Array;
}

/**
 * builtin/bundle.c's `open_bundle` (`read_bundle_header`): the header and the pack, or git's
 * `error:` line (the bundle reported as `name`: its path, `<stdin>` for `-`).
 */
export function openBundle(
  bytes: Uint8Array,
  name: string,
): { ok: true; bundle: OpenedBundle } | { ok: false; error: string } {
  const parsed = parseBundleHeader(bytes, name);
  if (!parsed.ok) return { ok: false, error: `error: ${parsed.error}\n` };
  return { ok: true, bundle: { header: parsed.header, pack: bytes.subarray(parsed.packOffset) } };
}

/** The commands reading a bundle against the repository. */
export abstract class BundleCommandBase<T> extends GitCommand<T> {
  /**
   * bundle.c's `verify_bundle`: every prerequisite must be an object here (each missing one
   * on an `error:` line after `Repository lacks these prerequisite commits:`, unless quiet),
   * then connected to the refs (`check_connected` of the prerequisites, `--not --all`); with
   * `verbose`, what the bundle holds on stdout.
   */
  protected async verifyBundle(
    header: BundleHeader,
    options: VerifyBundleOptions = {},
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const history = this._workingCopy.history;
    const objects = historyWithoutLazyFetch(history);
    let stderr = "";
    let missing = 0;
    for (const prerequisite of header.prerequisites) {
      if (await objectExists(objects, prerequisite.id)) continue;
      missing++;
      if (options.quiet) continue;
      if (missing === 1) stderr += "error: Repository lacks these prerequisite commits:\n";
      stderr += `error: ${prerequisite.id} \n`;
    }
    if (missing > 0) return { ok: false, stdout: "", stderr };
    let ok = true;
    const tips = header.prerequisites.map((p) => p.id);
    if (tips.length > 0) {
      const facade = createRepositoryFacade({ history: objects });
      const lines = await connectivityErrors(facade, tips, {
        known: await this.allRefValues(),
        shallow: new Set(await this.shallowCommits()),
      });
      if (lines) {
        ok = false;
        stderr +=
          "error: some prerequisite commits exist in the object store, " +
          "but are not connected to the repository's history\n";
      }
    }
    let stdout = "";
    if (options.verbose) {
      const refs = header.references;
      stdout +=
        refs.length === 1
          ? "The bundle contains this ref:\n"
          : `The bundle contains these ${refs.length} refs:\n`;
      stdout += listBundleRefs(refs);
      const prereqs = header.prerequisites;
      if (prereqs.length === 0) stdout += "The bundle records a complete history.\n";
      else {
        stdout +=
          prereqs.length === 1
            ? "The bundle requires this ref:\n"
            : `The bundle requires these ${prereqs.length} refs:\n`;
        stdout += listBundleRefs(prereqs);
      }
      stdout += `The bundle uses this hash algorithm: ${header.objectFormat.name}\n`;
      if (header.filter !== undefined) {
        stdout += `The bundle uses this filter: ${header.filter}\n`;
      }
    }
    return { ok, stdout, stderr };
  }

  /**
   * bundle.c's `unbundle`: the bundle verified (git's lines on failure), then its pack
   * indexed and kept (`index-pack --fix-thin --stdin`), a filtered bundle's marked as a
   * promisor pack (`--promisor=from-bundle`).
   */
  protected async unbundleInto(
    bundle: OpenedBundle,
    options: VerifyBundleOptions = {},
  ): Promise<{ ok: boolean; stderr: string; packId?: string }> {
    const verified = await this.verifyBundle(bundle.header, options);
    if (!verified.ok) return { ok: false, stderr: verified.stderr };
    const history = historyWithoutLazyFetch(this._workingCopy.history);
    const facade = createRepositoryFacade({ history });
    const pack = bundle.pack;
    let imported: { packId?: string };
    try {
      imported = await facade.importPack(
        (async function* () {
          yield pack;
        })(),
        { keepPack: true },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fatal = message.startsWith("fatal: ") ? message : `fatal: ${message}`;
      return { ok: false, stderr: `${fatal}\nerror: index-pack died\n` };
    }
    if (bundle.header.filter !== undefined && imported.packId !== undefined) {
      await facade.markPromisorPack?.(imported.packId, "from-bundle\n");
    }
    return {
      ok: true,
      stderr: "",
      ...(imported.packId !== undefined ? { packId: imported.packId } : {}),
    };
  }

  /** What `rev-list --all` starts from: every ref's value and HEAD's. */
  protected async allRefValues(): Promise<ObjectId[]> {
    const out = new Set<ObjectId>();
    const refs = this.refsStore;
    for await (const ref of refs.list()) {
      const id =
        "objectId" in ref && ref.objectId
          ? ref.objectId
          : (await refs.resolve(ref.name).catch(() => undefined))?.objectId;
      if (id) out.add(id);
    }
    const head = (await refs.resolve("HEAD").catch(() => undefined))?.objectId;
    if (head) out.add(head);
    return [...out];
  }
}

/** git's `parse_object` succeeds: the object is here, whatever its type. */
async function objectExists(
  history: ReturnType<typeof historyWithoutLazyFetch>,
  id: ObjectId,
): Promise<boolean> {
  const objects = (history as { objects?: { has(id: ObjectId): Promise<boolean> } }).objects;
  if (objects) return objects.has(id).catch(() => false);
  for (const store of [history.commits, history.trees, history.blobs, history.tags]) {
    if (await store.has(id).catch(() => false)) return true;
  }
  return false;
}
