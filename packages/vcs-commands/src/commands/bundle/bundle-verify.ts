/**
 * bundle.c's reading side without a command: a bundle's bytes read (`read_bundle_header`)
 * and checked against a repository (`verify_bundle`), as the bundle commands and the bundle
 * transport do.
 */

import { type History, historyWithoutLazyFetch, type ObjectId } from "@statewalker/vcs-core";
import { connectivityErrors, createRepositoryFacade } from "@statewalker/vcs-transport";
import type { ObjectFormat } from "@statewalker/vcs-utils/hash";

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
  /** The hash of a header without `@object-format=` (the repository's) */
  defaultFormat?: ObjectFormat,
): { ok: true; bundle: OpenedBundle } | { ok: false; error: string } {
  const parsed = parseBundleHeader(bytes, name, defaultFormat);
  if (!parsed.ok) return { ok: false, error: `error: ${parsed.error}\n` };
  return { ok: true, bundle: { header: parsed.header, pack: bytes.subarray(parsed.packOffset) } };
}

/** What {@link verifyBundleIn} reads of a repository. */
export interface BundleVerifyRepository {
  history: History;
  /** What `rev-list --all` starts from: every ref's value and HEAD's */
  refValues(): Promise<ObjectId[]>;
  /** The repository's shallow commits */
  shallow(): Promise<ObjectId[]>;
}

/**
 * bundle.c's `verify_bundle`: every prerequisite must be an object here (each missing one
 * on an `error:` line after `Repository lacks these prerequisite commits:`, unless quiet),
 * then connected to the refs (`check_connected` of the prerequisites, `--not --all`); with
 * `verbose`, what the bundle holds on stdout.
 */
export async function verifyBundleIn(
  repository: BundleVerifyRepository,
  header: BundleHeader,
  options: VerifyBundleOptions = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const objects = historyWithoutLazyFetch(repository.history);
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
      known: await repository.refValues(),
      shallow: new Set(await repository.shallow()),
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
