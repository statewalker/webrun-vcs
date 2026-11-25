/**
 * git's `uploadpack.packObjectsHook`: upload-pack hands the pack it would build to a command
 * instead, `<hook> git pack-objects --revs ...` with pack-objects' input on stdin, and sends
 * what the command writes on stdout as the pack (create_pack_file). git reads the setting
 * only from protected configuration (system, global, command line), never from the served
 * repository's own config, which anyone who can push to it may write: the server here never
 * reads it at all, the host gives the hook as a callback ({@link PackObjectsHook}) and decides
 * what runs.
 *
 * @example
 * ```ts
 * await serveOverDuplex({
 *   duplex, repository, refStore,
 *   // a host that runs the operator's command: `sh -c '<hook> "$@"' <hook> git pack-objects ...`
 *   packObjectsHook: async ({ args, stdin, onStderr }) => runOperatorHook(args, stdin, onStderr),
 * });
 * ```
 */

import { PackObjectsError } from "./pack-objects-error.js";

/** What a {@link PackObjectsHook} is asked to run. */
export interface PackObjectsHookRequest {
  /**
   * The arguments git appends to the hook's command: `git`, then (for a shallow request)
   * `--shallow-file ""`, then `pack-objects --revs [--thin] --stdout [--shallow] [--progress]
   * [--delta-base-offset] [--include-tag] [--filter=<spec>]`
   */
  args: readonly string[];
  /**
   * pack-objects' input: `--shallow <id>` lines, the wanted ids, `--not`, the client's haves
   * the server has, the extra edges, and an empty line
   */
  stdin: Uint8Array;
  /** Called with each chunk of the command's stderr, as it writes it (relayed on band 2) */
  onStderr(chunk: Uint8Array): void;
}

/** A started pack-objects hook. */
export interface PackObjectsHookProcess {
  /** Its stdout: the pack */
  stdout: AsyncIterable<Uint8Array>;
  /** Waits for it to exit: its exit code (not 0: upload-pack aborts the pack) */
  wait(): Promise<number>;
}

/**
 * Runs the host's pack-objects hook (see the module doc); undefined when the hook cannot be
 * started, as git's `unable to fork git-pack-objects`.
 */
export type PackObjectsHook = (
  request: PackObjectsHookRequest,
) => Promise<PackObjectsHookProcess | undefined>;

/** What create_pack_file passes pack-objects. */
export interface PackObjectsHookArgsOptions {
  /** The request has shallow commits (git's `shallow_nr`) */
  shallow?: boolean;
  thin?: boolean;
  progress?: boolean;
  ofsDelta?: boolean;
  includeTag?: boolean;
  /** The filter spec, as the client sent it */
  filter?: string;
}

/**
 * The arguments create_pack_file gives the hook after its command, in git's order.
 *
 * @example
 * ```ts
 * packObjectsHookArgs({ ofsDelta: true, includeTag: true });
 * // ["git", "pack-objects", "--revs", "--stdout", "--delta-base-offset", "--include-tag"]
 * ```
 */
export function packObjectsHookArgs(options: PackObjectsHookArgsOptions): string[] {
  const args = ["git"];
  if (options.shallow) args.push("--shallow-file", "");
  args.push("pack-objects", "--revs");
  if (options.thin) args.push("--thin");
  args.push("--stdout");
  if (options.shallow) args.push("--shallow");
  if (options.progress) args.push("--progress");
  if (options.ofsDelta) args.push("--delta-base-offset");
  if (options.includeTag) args.push("--include-tag");
  if (options.filter !== undefined) args.push(`--filter=${options.filter}`);
  return args;
}

/**
 * pack-objects' stdin as create_pack_file writes it: `--shallow <id>` for each shallow
 * commit, the wants, `--not`, the haves, the extra edges, and an empty line.
 */
export function packObjectsHookInput(input: {
  shallow?: Iterable<string>;
  wants: Iterable<string>;
  haves: Iterable<string>;
  extraEdges?: Iterable<string>;
}): Uint8Array {
  let text = "";
  for (const id of input.shallow ?? []) text += `--shallow ${id}\n`;
  for (const id of input.wants) text += `${id}\n`;
  text += "--not\n";
  for (const id of input.haves) text += `${id}\n`;
  for (const id of input.extraEdges ?? []) text += `${id}\n`;
  text += "\n";
  return new TextEncoder().encode(text);
}

/**
 * The pack the hook writes, chunk by chunk; its stderr goes to `relayStderr` as it comes.
 * A hook that cannot start, or exits with a status other than 0, fails the pack as git's
 * upload-pack does ("git-pack-objects died with error": only the abort reaches the client).
 */
export async function* packFromHook(
  hook: PackObjectsHook,
  args: readonly string[],
  stdin: Uint8Array,
  relayStderr: (chunk: Uint8Array) => void,
): AsyncGenerator<Uint8Array> {
  const process = await hook({ args, stdin, onStderr: relayStderr });
  if (!process) {
    throw new PackObjectsError("git upload-pack: unable to fork git-pack-objects", {
      abortOnly: true,
    });
  }
  for await (const chunk of process.stdout) yield chunk;
  const status = await process.wait();
  if (status !== 0) {
    throw new PackObjectsError("git upload-pack: git-pack-objects died with error.", {
      abortOnly: true,
    });
  }
}
