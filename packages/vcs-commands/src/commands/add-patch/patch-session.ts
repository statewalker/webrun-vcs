/**
 * `run_add_p` for the commands: the configuration add-patch.c reads (`diff.context`,
 * `diff.interHunkContext`, `diff.algorithm`, the comment character), the backend and the
 * selection.
 */

import { EMPTY_TREE_ID } from "@statewalker/vcs-core";
import type { XdiffAlgorithm } from "@statewalker/vcs-utils";

import { InvalidArgumentError } from "../../errors/index.js";
import type { GitCommand } from "../../git-command.js";
import type { WorkingCopy } from "../../types.js";
import { configValue } from "../merge-config.js";
import {
  type PatchCompatibility,
  type PatchResult,
  type PatchSelector,
  runAddPatch,
} from "./add-patch.js";
import { createPatchBackend, type TemporaryIndex } from "./patch-backend.js";
import { type PatchMode, patchModeFor } from "./patch-modes.js";

/** The patch-mode options every `-p` command takes. */
export interface PatchOptions {
  /** `-U<n>` / `--unified=<n>` (default `diff.context`) */
  context?: number;
  /** `--inter-hunk-context=<n>` (default `diff.interHunkContext`) */
  interHunkContext?: number;
  /** `--no-auto-advance` (git 2.5x): false stays in a file until `q` and applies at the end */
  autoAdvance?: boolean;
}

/** What {@link runPatchSelection} needs besides the options. */
export interface PatchSelectionRequest extends PatchOptions {
  mode: PatchMode;
  selector: PatchSelector | undefined;
  /** The revision the diff compares with (a tree-ish; the empty tree for an unborn HEAD) */
  diffRevision?: string;
  paths: string[];
  compatibility?: PatchCompatibility;
  temporaryIndex?: TemporaryIndex;
  /** The command running the selection, whose hook session gathers the hooks' output */
  hookSource?: GitCommand<unknown>;
}

const ALGORITHMS = new Set(["myers", "minimal", "patience", "histogram"]);

function intConfig(workingCopy: WorkingCopy, key: string): number | undefined {
  const value = configValue(workingCopy, key);
  if (value === undefined) return undefined;
  const m = /^\s*(-?\d+)([kmg]?)\s*$/i.exec(value);
  if (!m)
    throw new InvalidArgumentError(
      key,
      value,
      `fatal: bad numeric config value '${value}' for '${key}'`,
    );
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1;
  const n = Number(m[1]) * unit;
  if (n < 0) throw new InvalidArgumentError(key, value, `fatal: ${key} cannot be negative`);
  return n;
}

/** Runs a patch selection as `run_add_p` does for a command. */
export async function runPatchSelection(
  workingCopy: WorkingCopy,
  request: PatchSelectionRequest,
): Promise<PatchResult> {
  const { selector } = request;
  if (!selector) {
    throw new InvalidArgumentError(
      "patchSelector",
      undefined,
      "patch mode needs a selector (setPatchSelector) to answer its prompts",
    );
  }
  if (request.context !== undefined && request.context < 0) {
    throw new InvalidArgumentError(
      "context",
      request.context,
      "fatal: '--unified' cannot be negative",
    );
  }
  if (request.interHunkContext !== undefined && request.interHunkContext < 0) {
    throw new InvalidArgumentError(
      "interHunkContext",
      request.interHunkContext,
      "fatal: '--inter-hunk-context' cannot be negative",
    );
  }
  // 2.43's add-patch reads neither, and its plumbing diff neither: git's defaults
  const legacy = request.compatibility === "2.43";
  const context = request.context ?? (legacy ? 3 : intConfig(workingCopy, "diff.context"));
  const interHunkContext =
    request.interHunkContext ?? (legacy ? 0 : intConfig(workingCopy, "diff.interHunkContext"));
  const configured = configValue(workingCopy, "diff.algorithm")?.trim().toLowerCase();
  const algorithm =
    configured === "default"
      ? "myers"
      : configured && ALGORITHMS.has(configured)
        ? (configured as XdiffAlgorithm)
        : undefined;
  const comment =
    configValue(workingCopy, "core.commentString") ?? configValue(workingCopy, "core.commentChar");
  const backend = createPatchBackend({
    workingCopy,
    mode: request.mode,
    paths: request.paths,
    ...(request.diffRevision !== undefined ? { revision: request.diffRevision } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(interHunkContext !== undefined ? { interHunkContext } : {}),
    ...(algorithm ? { algorithm } : {}),
    ...(request.temporaryIndex ? { temporaryIndex: request.temporaryIndex } : {}),
    ...(request.hookSource ? { hookSource: request.hookSource } : {}),
  });
  return runAddPatch({
    mode: request.mode,
    backend,
    selector,
    compatibility: request.compatibility ?? "2.56",
    ...(request.autoAdvance !== undefined ? { autoAdvance: request.autoAdvance } : {}),
    ...(comment && comment !== "auto" ? { commentString: comment } : {}),
  });
}

/**
 * The revision checkout's patch mode hands run_add_p, and the one its diff compares with:
 * `HEAD` stays `HEAD` (the empty tree on an unborn branch), a commit becomes its full id
 * (`<a>...<b>` included), a tree keeps its name.
 */
export async function patchRevisionOf(
  revision: string | undefined,
  access: {
    headId: () => Promise<string | undefined>;
    resolve: (name: string) => Promise<string>;
    peelCommit: (id: string) => Promise<string | undefined>;
  },
): Promise<{ revision?: string; diffRevision?: string }> {
  if (revision === undefined) return {};
  const rev = revision === "@" ? "HEAD" : revision;
  if (rev === "HEAD") {
    return { revision: rev, diffRevision: (await access.headId()) ? rev : EMPTY_TREE_ID };
  }
  const id = await access.resolve(rev);
  let commit: string | undefined;
  try {
    commit = await access.peelCommit(id);
  } catch {
    commit = undefined;
  }
  return commit ? { revision: commit, diffRevision: commit } : { revision: rev, diffRevision: rev };
}

/** The mode of a path checkout's `-p` by what it restores (builtin/checkout.c). */
export function pathPatchMode(index: boolean, worktree: boolean, revision?: string): PatchMode {
  if (index && worktree) return patchModeFor("checkout", revision);
  if (index) return patchModeFor("reset", revision);
  return patchModeFor("worktree", revision);
}
