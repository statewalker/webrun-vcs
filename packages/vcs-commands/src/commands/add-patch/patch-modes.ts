/**
 * The patch modes of git's interactive hunk selection (add-patch.c's `patch_mode_*`
 * tables): which diff each mode shows, how the selected hunks are applied, and the texts
 * git prints for them.
 */

/** The patch mode git picks for a command (add-patch.c's `patch_mode_*`). */
export type PatchModeName =
  /** `add -p` */
  | "stage"
  /** `stash push -p` */
  | "stash"
  /** `reset -p [HEAD]`, `restore -p --staged` */
  | "reset_head"
  /** `reset -p <tree-ish>`, `restore -p --staged --source=<tree-ish>` */
  | "reset_nothead"
  /** `checkout -p`, `restore -p` (from the index) */
  | "checkout_index"
  /** `checkout -p HEAD`, `restore -p --staged --worktree` */
  | "checkout_head"
  /** `checkout -p <tree-ish>`, `restore -p -SW --source=<tree-ish>` */
  | "checkout_nothead"
  /** `restore -p --source=HEAD` */
  | "worktree_head"
  /** `restore -p --source=<tree-ish>` */
  | "worktree_nothead";

/** The diff a mode shows (add-patch.c's `diff_cmd`). */
export type PatchDiffKind =
  /** `diff-files`: the index against the worktree */
  | "files"
  /** `diff-index <rev>`: the revision against the worktree */
  | "index"
  /** `diff-index --cached <rev>`: the revision against the index */
  | "index-cached";

/** How `git apply` is run (`--cached`, `-R`). */
export interface PatchApplyArgs {
  cached: boolean;
  reverse: boolean;
}

/** A patch mode: its diff, how it applies, and its texts. */
export interface PatchMode {
  readonly name: PatchModeName;
  readonly diff: PatchDiffKind;
  /** `-R` given to the diff */
  readonly diffReverse: boolean;
  /** `apply_args`; undefined for the checkout modes (`apply_for_checkout`) */
  readonly applyArgs?: PatchApplyArgs;
  /** `apply_check_args` */
  readonly applyCheckArgs: PatchApplyArgs;
  readonly isReverse: boolean;
  readonly indexOnly: boolean;
  readonly applyForCheckout: boolean;
  /**
   * The prompts (mode change, deletion, addition, hunk), with git's `%s` placeholders: 2.5x
   * takes the earlier decision (" (was: y)") and then the choices, 2.43 only the choices
   */
  readonly promptMode: readonly [string, string, string, string];
  readonly editHunkHint: string;
  readonly helpPatchText: string;
}

/** The kind of a prompt (add-patch.c's `prompt_mode_type`). */
export type PatchPromptKind = "mode-change" | "deletion" | "addition" | "hunk";

const PROMPT_ORDER: readonly PatchPromptKind[] = ["mode-change", "deletion", "addition", "hunk"];

/** The index of a prompt kind in {@link PatchMode.promptMode}. */
export function promptIndex(kind: PatchPromptKind): number {
  return PROMPT_ORDER.indexOf(kind);
}

const help = (verb: string, object: string, all: string) =>
  `y - ${verb} this hunk${object}\n` +
  `n - do not ${verb} this hunk${object}\n` +
  `q - quit; do not ${verb} this hunk or any of the remaining ones\n` +
  `a - ${verb} this hunk ${all}and all later hunks in the file\n` +
  `d - do not ${verb} this hunk or any of the later hunks in the file\n`;

const hint = (what: string) =>
  `If the patch applies cleanly, the edited hunk will immediately be marked for ${what}.`;

const prompts = (
  prefix: string,
  suffix: string,
  hunkPrefix: string,
): [string, string, string, string] => [
  `${prefix} mode change${suffix}%s [y,n,q,a,d%s,?]? `,
  `${prefix} deletion${suffix}%s [y,n,q,a,d%s,?]? `,
  `${prefix} addition${suffix}%s [y,n,q,a,d%s,?]? `,
  `${hunkPrefix}${suffix}%s [y,n,q,a,d%s,?]? `,
];

const NONE: PatchApplyArgs = { cached: false, reverse: false };
const CACHED: PatchApplyArgs = { cached: true, reverse: false };
const REVERSE: PatchApplyArgs = { cached: false, reverse: true };
const REVERSE_CACHED: PatchApplyArgs = { cached: true, reverse: true };

/** add-patch.c's patch modes, by name. */
export const PATCH_MODES: Readonly<Record<PatchModeName, PatchMode>> = {
  stage: {
    name: "stage",
    diff: "files",
    diffReverse: false,
    applyArgs: CACHED,
    applyCheckArgs: CACHED,
    isReverse: false,
    indexOnly: false,
    applyForCheckout: false,
    promptMode: prompts("Stage", "", "Stage this hunk"),
    editHunkHint: hint("staging"),
    helpPatchText: help("stage", "", ""),
  },
  stash: {
    name: "stash",
    diff: "index",
    diffReverse: false,
    applyArgs: CACHED,
    applyCheckArgs: CACHED,
    isReverse: false,
    indexOnly: false,
    applyForCheckout: false,
    promptMode: prompts("Stash", "", "Stash this hunk"),
    editHunkHint: hint("stashing"),
    helpPatchText: help("stash", "", ""),
  },
  reset_head: {
    name: "reset_head",
    diff: "index-cached",
    diffReverse: false,
    applyArgs: REVERSE_CACHED,
    applyCheckArgs: REVERSE_CACHED,
    isReverse: true,
    indexOnly: true,
    applyForCheckout: false,
    promptMode: prompts("Unstage", "", "Unstage this hunk"),
    editHunkHint: hint("unstaging"),
    helpPatchText: help("unstage", "", ""),
  },
  reset_nothead: {
    name: "reset_nothead",
    diff: "index-cached",
    diffReverse: true,
    applyArgs: CACHED,
    applyCheckArgs: CACHED,
    isReverse: false,
    indexOnly: true,
    applyForCheckout: false,
    promptMode: prompts("Apply", " to index", "Apply this hunk"),
    editHunkHint: hint("applying"),
    helpPatchText: help("apply", " to index", ""),
  },
  checkout_index: {
    name: "checkout_index",
    diff: "files",
    diffReverse: false,
    applyArgs: REVERSE,
    applyCheckArgs: REVERSE,
    isReverse: true,
    indexOnly: false,
    applyForCheckout: false,
    promptMode: prompts("Discard", " from worktree", "Discard this hunk"),
    editHunkHint: hint("discarding"),
    helpPatchText: help("discard", " from worktree", ""),
  },
  checkout_head: {
    name: "checkout_head",
    diff: "index",
    diffReverse: false,
    applyCheckArgs: REVERSE,
    isReverse: true,
    indexOnly: false,
    applyForCheckout: true,
    promptMode: prompts("Discard", " from index and worktree", "Discard this hunk"),
    editHunkHint: hint("discarding"),
    helpPatchText: help("discard", " from index and worktree", ""),
  },
  checkout_nothead: {
    name: "checkout_nothead",
    diff: "index",
    diffReverse: true,
    applyCheckArgs: NONE,
    isReverse: false,
    indexOnly: false,
    applyForCheckout: true,
    promptMode: prompts("Apply", " to index and worktree", "Apply this hunk"),
    editHunkHint: hint("applying"),
    helpPatchText: help("apply", " to index and worktree", ""),
  },
  worktree_head: {
    name: "worktree_head",
    diff: "index",
    diffReverse: false,
    applyArgs: REVERSE,
    applyCheckArgs: REVERSE,
    isReverse: true,
    indexOnly: false,
    applyForCheckout: false,
    promptMode: prompts("Discard", " from worktree", "Discard this hunk"),
    editHunkHint: hint("discarding"),
    helpPatchText: help("discard", " from worktree", ""),
  },
  worktree_nothead: {
    name: "worktree_nothead",
    diff: "index",
    diffReverse: true,
    applyArgs: NONE,
    applyCheckArgs: NONE,
    isReverse: false,
    indexOnly: false,
    applyForCheckout: false,
    promptMode: prompts("Apply", " to worktree", "Apply this hunk"),
    editHunkHint: hint("applying"),
    helpPatchText: help("apply", " to worktree", ""),
  },
};

/**
 * The mode `run_add_p` picks: `stage` for add, `stash` for stash, and for reset, checkout
 * and restore by the revision (none: from the index; `HEAD`; another one).
 */
export function patchModeFor(
  command: "add" | "stash" | "reset" | "checkout" | "worktree",
  revision?: string,
): PatchMode {
  const head = revision === "HEAD";
  switch (command) {
    case "add":
      return PATCH_MODES.stage;
    case "stash":
      return PATCH_MODES.stash;
    case "reset":
      return revision === undefined || head ? PATCH_MODES.reset_head : PATCH_MODES.reset_nothead;
    case "checkout":
      return revision === undefined
        ? PATCH_MODES.checkout_index
        : head
          ? PATCH_MODES.checkout_head
          : PATCH_MODES.checkout_nothead;
    case "worktree":
      return revision === undefined
        ? PATCH_MODES.checkout_index
        : head
          ? PATCH_MODES.worktree_head
          : PATCH_MODES.worktree_nothead;
  }
}
