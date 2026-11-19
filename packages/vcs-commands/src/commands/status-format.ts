/**
 * The text forms of `git status` (wt-status.c's `wt_status_print`): the long format with its
 * headers, hints and sections, the short format, porcelain v1 and v2, each with `-z` and
 * `--branch`, and the commented long format git writes into the commit message template.
 *
 * @example
 * ```typescript
 * const header = await readStatusHeader(...); // the branch, HEAD, operations in progress
 * const { text, committable } = formatStatusText(status, header, { format: "long" });
 * // "On branch main\nChanges to be committed:\n  (use \"git restore --staged <file>...\" ..."
 * ```
 */

import { compareGitPaths } from "@statewalker/vcs-utils/encoding";

import { quoteCStyleBody } from "../results/quote-path.js";
import type { Status, StatusFileEntry } from "../results/status-result.js";
import { formatStatusPorcelain, submoduleToken } from "../results/status-result.js";
import type { IgnoredMode, UntrackedFilesMode } from "./status-command.js";
import type { TrackingStat } from "./tracking-info.js";

/** What wt_status_get_state finds of operations in progress (`struct wt_status_state`). */
export interface StatusState {
  mergeInProgress?: boolean;
  amInProgress?: boolean;
  amEmptyPatch?: boolean;
  rebaseInProgress?: boolean;
  rebaseInteractiveInProgress?: boolean;
  /** The branch being rebased (or bisected from), as get_branch reads it */
  branch?: string;
  /** What the rebase is onto, as get_branch reads it */
  onto?: string;
  cherryPickInProgress?: boolean;
  /** CHERRY_PICK_HEAD abbreviated; undefined in a sequence without it (null oid) */
  cherryPickHead?: string;
  revertInProgress?: boolean;
  /** REVERT_HEAD abbreviated; undefined in a sequence without it (null oid) */
  revertHead?: string;
  bisectInProgress?: boolean;
  bisectingFrom?: string;
  /** wt_status_get_detached_from: where a detached HEAD came from */
  detachedFrom?: string;
  /** The detached HEAD is still at the commit it was detached at */
  detachedAt?: boolean;
  /** The percentage of tracked files present in a sparse checkout */
  sparseCheckoutPercentage?: number;
  /** An interactive rebase's done and todo commands, as status shows them */
  rebaseDone?: string[];
  /** undefined: `git-rebase-todo` is missing */
  rebaseTodo?: string[];
  /** `$GIT_DIR/rebase-merge/done` as git names it ("see more in file ...") */
  rebaseDonePath?: string;
  /** `MERGE_MSG` exists (a rebase stopped with a message prepared) */
  mergeMsgExists?: boolean;
  /** split_commit_in_progress */
  splitCommitInProgress?: boolean;
}

/** What the status headers show besides the paths. */
export interface StatusHeader {
  /** `s->branch`: the ref HEAD points to (`refs/heads/x`), "HEAD" when detached */
  branch?: string;
  /** No commit to compare with (`s->is_initial`) */
  isInitial: boolean;
  /** The commit compared with (`s->oid_commit`) */
  oid?: string;
  state: StatusState;
  /** format_tracking_info's report for the long format ("" when nothing to report) */
  trackingText?: string;
  /** stat_tracking_info for the short and v2 headers, with the upstream shortened */
  tracking?: TrackingStat & { short?: string };
  /** The entries of the stash */
  stashCount?: number;
}

/** Where the commit comes from (`enum commit_whence`): the hints of the headers depend on it. */
export type CommitWhence = "commit" | "merge" | "cherry-pick" | "rebase-pick";

/** The format and options of {@link formatStatusText}. */
export interface StatusTextOptions {
  format: "long" | "short" | "porcelain" | "porcelain-v2";
  /** `-b`/`--branch`: the branch header of the short and porcelain formats */
  branch?: boolean;
  /** `-z`: NUL-terminated entries, paths unquoted */
  z?: boolean;
  /** `--show-stash` */
  showStash?: boolean;
  /** `core.quotePath` (default true) */
  quotePath?: boolean;
  /** `advice.statusHints` (default true) */
  hints?: boolean;
  /**
   * The comment-line string when lines are commented (`status.displayCommentPrefix`, the
   * commit template); undefined: not commented
   */
  commentPrefix?: string;
  /** The untracked mode the status was made in (`no`: "Untracked files not listed") */
  untracked?: UntrackedFilesMode;
  /** The ignored mode the status was made in */
  ignored?: IgnoredMode;
  /** The commit template (`s->commit_template`): "Initial commit" */
  commitTemplate?: boolean;
  /** `git commit --amend` (`s->amend`): "No changes" when nothing to commit */
  amend?: boolean;
  /** `s->nowarn`: no closing line when nothing is committable */
  nowarn?: boolean;
  whence?: CommitWhence;
  /** What the index is compared with (`s->reference`): "HEAD", or "HEAD^1" for `--amend` */
  reference?: string;
  /** AHEAD_BEHIND_QUICK for the short header */
  aheadBehindQuick?: boolean;
  /** The verbose part (`-v`): printed after the sections, before the closing line */
  verbose?: string;
  /**
   * `status.submoduleSummary`: the output of `git submodule summary --cached --for-status`
   * (`staged`) and `--files --for-status` (`unstaged`), printed after the unstaged changes
   * under their headers (wt_longstatus_print_submodule_summary)
   */
  submoduleSummary?: { staged: string; unstaged: string };
}

/** The text and whether the status has something to commit (`s->committable`). */
export interface StatusText {
  text: string;
  committable: boolean;
}

/** `s->committable` and `s->workdir_dirty` of a status (wt_status_collect). */
export function statusCommitInfo(
  status: Status,
  header: Pick<StatusHeader, "isInitial" | "state">,
): { committable: boolean; workdirDirty: boolean; worktreeChanges: boolean } {
  let committable = false;
  let workdirDirty = false;
  // wt_status_check_worktree_changes: a worktree change of a path not unmerged
  let worktreeChanges = false;
  let unmerged = false;
  for (const f of status.files) {
    if (f.index === "?" || f.index === "!") continue;
    if (f.stages) {
      unmerged = true;
      workdirDirty = true;
      // wt_status_collect_changes_initial counts an unmerged entry as committable
      if (header.isInitial) committable = true;
      continue;
    }
    if (f.index !== " ") committable = true;
    if (f.worktree !== " ") {
      workdirDirty = true;
      worktreeChanges = true;
    }
  }
  if (header.state.mergeInProgress && !unmerged) committable = true;
  return { committable, workdirDirty, worktreeChanges };
}

/** git's quote_path of a status path (QUOTE_PATH_QUOTE_SP for the short format). */
function quotePath(path: string, quoteSpace: boolean, fully: boolean): string {
  const body = quoteCStyleBody(path, fully);
  if (body !== undefined) return `"${body}"`;
  return quoteSpace && path.includes(" ") ? `"${path}"` : path;
}

const UNMERGED_KEYS: Record<number, string> = {
  1: "DD",
  2: "AU",
  3: "UD",
  4: "UA",
  5: "DU",
  6: "AA",
  7: "UU",
};

const UNMERGED_LABELS: Record<number, string> = {
  1: "both deleted:",
  2: "added by us:",
  3: "deleted by them:",
  4: "added by them:",
  5: "deleted by us:",
  6: "both added:",
  7: "both modified:",
};

const DIFF_LABELS: Record<string, string> = {
  A: "new file:",
  C: "copied:",
  D: "deleted:",
  M: "modified:",
  R: "renamed:",
  T: "typechange:",
  X: "unknown:",
  U: "unmerged:",
};

/** maxwidth(wt_status_diff_status_string) + 1 and maxwidth(unmerged) + 1. */
const DIFF_LABEL_WIDTH = 12;
const UNMERGED_LABEL_WIDTH = 17;

const stagemask = (e: StatusFileEntry) =>
  e.stages ? (e.stages[0] ? 1 : 0) | (e.stages[1] ? 2 : 0) | (e.stages[2] ? 4 : 0) : 0;

/** The changed entries (`s->change`), the untracked and the ignored paths, each sorted. */
function lists(status: Status) {
  const change = status.files
    .filter((e) => e.index !== "?" && e.index !== "!")
    .sort((a, b) => compareGitPaths(a.path, b.path));
  const untracked = status.files
    .filter((e) => e.index === "?")
    .map((e) => e.path)
    .sort(compareGitPaths);
  const ignored = status.files
    .filter((e) => e.index === "!")
    .map((e) => e.path)
    .sort(compareGitPaths);
  return { change, untracked, ignored };
}

/**
 * The status as `git status` (or `git commit --dry-run`, or the commit template) prints
 * it in the format asked.
 */
export function formatStatusText(
  status: Status,
  header: StatusHeader,
  options: StatusTextOptions,
): StatusText {
  const info = statusCommitInfo(status, header);
  switch (options.format) {
    case "long":
      return { text: longStatus(status, header, options, info), committable: info.committable };
    case "porcelain-v2":
      return { text: porcelainV2(status, header, options), committable: info.committable };
    default:
      return { text: shortStatus(status, header, options), committable: info.committable };
  }
}

/** wt_shortstatus_print (and wt_porcelain_print: no color, untranslated). */
function shortStatus(status: Status, header: StatusHeader, options: StatusTextOptions): string {
  const z = options.z === true;
  const fully = options.quotePath ?? true;
  const short = options.format === "short";
  const eol = z ? "\0" : "\n";
  let out = "";
  if (options.branch) out += shortTracking(header, options) + eol;
  const { change, untracked, ignored } = lists(status);
  const q = (p: string) => (z ? p : quotePath(p, true, fully));
  for (const e of change) {
    const mask = stagemask(e);
    if (mask) {
      out += `${UNMERGED_KEYS[mask]} ${q(e.path)}${eol}`;
      continue;
    }
    let y: string = e.worktree;
    // short_submodule_status (the short format only)
    if (short && y !== " " && isSubmodule(e)) {
      if (e.submoduleCommitChanged) y = "M";
      else if (e.submoduleModified) y = "m";
      else if (e.submoduleUntracked) y = "?";
    }
    const x = e.index;
    if (z) {
      out += `${x}${y} ${e.path}\0`;
      if (e.renamedFrom !== undefined) out += `${e.renamedFrom}\0`;
    } else {
      const from = e.renamedFrom !== undefined ? `${q(e.renamedFrom)} -> ` : "";
      out += `${x}${y} ${from}${q(e.path)}\n`;
    }
  }
  for (const p of untracked) out += `?? ${q(p)}${eol}`;
  for (const p of ignored) out += `!! ${q(p)}${eol}`;
  return out;
}

const isSubmodule = (e: StatusFileEntry) => submoduleToken(e)[0] === "S";

/** wt_shortstatus_print_tracking: `## branch...upstream [ahead N, behind M]` (no eol). */
function shortTracking(header: StatusHeader, options: StatusTextOptions): string {
  let out = "## ";
  if (!header.branch) return out;
  if (header.isInitial) out += "No commits yet on ";
  if (header.branch === "HEAD") return `${out}HEAD (no branch)`;
  out += header.branch.replace(/^refs\/heads\//, "");
  const t = header.tracking;
  if (!t || (t.result < 0 && !t.base)) return out;
  const gone = t.result < 0;
  out += `...${t.short ?? t.base}`;
  if (!gone && t.result === 0) return out;
  out += " [";
  if (gone) out += "gone";
  else if (options.aheadBehindQuick) out += "different";
  else if (!t.ahead) out += `behind ${t.behind}`;
  else if (!t.behind) out += `ahead ${t.ahead}`;
  else out += `ahead ${t.ahead}, behind ${t.behind}`;
  return `${out}]`;
}

/** wt_porcelain_v2_print. */
function porcelainV2(status: Status, header: StatusHeader, options: StatusTextOptions): string {
  const z = options.z === true;
  const eol = z ? "\0" : "\n";
  let out = "";
  if (options.branch) {
    out += `# branch.oid ${header.isInitial ? "(initial)" : header.oid}${eol}`;
    if (!header.branch) out += `# branch.head (unknown)${eol}`;
    else {
      if (header.branch === "HEAD") out += `# branch.head (detached)${eol}`;
      else out += `# branch.head ${header.branch.replace(/^refs\/heads\//, "")}${eol}`;
      const t = header.branch === "HEAD" ? undefined : header.tracking;
      if (t?.base) {
        out += `# branch.upstream ${t.short ?? t.base}${eol}`;
        if (t.result > 0) {
          out +=
            t.ahead || t.behind
              ? `# branch.ab +${t.ahead} -${t.behind}${eol}`
              : `# branch.ab +? -?${eol}`;
        } else if (t.result === 0) out += `# branch.ab +0 -0${eol}`;
      }
    }
  }
  if (options.showStash && (header.stashCount ?? 0) > 0) {
    out += `# stash ${header.stashCount}${eol}`;
  }
  return out + formatStatusPorcelain(status, 2, { quotePath: options.quotePath ?? true, z });
}

/**
 * strbuf_add_commented_lines: each line after the prefix, and a space unless the line is
 * empty or starts with a tab.
 */
function commentedLines(text: string, prefix: string): string {
  if (text === "") return "";
  let out = "";
  for (const line of text.split(/(?<=\n)/)) {
    out += prefix;
    if (line[0] !== "\n" && line[0] !== "\t") out += " ";
    out += line;
  }
  return out.endsWith("\n") ? out : `${out}\n`;
}

/**
 * status_printf_ln / status_printf / status_printf_more over one buffer: with a comment
 * prefix each line starts with it (and a space, unless the line is empty or starts with a
 * tab), as wt-status.c's status_vprintf writes the commit template.
 *
 * @example
 * ```typescript
 * const p = new StatusPrinter("#");
 * p.ln("\nIt looks like you may be committing a merge.");
 * p.out; // "#\n# It looks like you may be committing a merge.\n"
 * ```
 */
export class StatusPrinter {
  out = "";
  constructor(private readonly prefix: string | undefined) {}

  private vprintf(atBol: boolean, text: string, trail: string | undefined) {
    if (text === "") {
      if (this.prefix !== undefined) {
        this.out += this.prefix;
        if (trail === undefined) this.out += " ";
      }
      if (trail !== undefined) this.out += trail;
      return;
    }
    let line = 0;
    let bol = atBol;
    while (line < text.length) {
      const eol = text.indexOf("\n", line);
      let buf = "";
      if (bol && this.prefix !== undefined) {
        buf += this.prefix;
        if (text[line] !== "\n" && text[line] !== "\t") buf += " ";
      }
      buf += eol >= 0 ? text.slice(line, eol) : text.slice(line);
      this.out += buf;
      if (eol < 0) break;
      this.out += "\n";
      line = eol + 1;
      bol = true;
    }
    if (trail !== undefined) this.out += trail;
  }

  ln(text: string) {
    this.vprintf(true, text, "\n");
  }
  printf(text: string) {
    this.vprintf(true, text, undefined);
  }
  more(text: string) {
    this.vprintf(false, text, undefined);
  }
  raw(text: string) {
    this.out += text;
  }
}

/** wt_longstatus_print. */
function longStatus(
  status: Status,
  header: StatusHeader,
  options: StatusTextOptions,
  info: { committable: boolean; workdirDirty: boolean },
): string {
  const p = new StatusPrinter(options.commentPrefix);
  const hints = options.hints ?? true;
  const fully = options.quotePath ?? true;
  const q = (path: string) => quotePath(path, false, fully);
  const state = header.state;
  const whence = options.whence ?? "commit";
  const reference = options.reference ?? "HEAD";
  const { change, untracked, ignored } = lists(status);
  const hasUnmerged = change.some((e) => e.stages);
  const trailer = () => p.ln("");

  if (header.branch) {
    let onWhat = "On branch ";
    let branchName = header.branch;
    if (branchName === "HEAD") {
      if (state.rebaseInProgress || state.rebaseInteractiveInProgress) {
        onWhat = state.rebaseInteractiveInProgress
          ? "interactive rebase in progress; onto "
          : "rebase in progress; onto ";
        branchName = state.onto ?? "";
      } else if (state.detachedFrom !== undefined) {
        branchName = state.detachedFrom;
        onWhat = state.detachedAt ? "HEAD detached at " : "HEAD detached from ";
      } else {
        branchName = "";
        onWhat = "Not currently on any branch.";
      }
    } else branchName = branchName.replace(/^refs\/heads\//, "");
    p.printf("");
    p.more(onWhat);
    p.more(`${branchName}\n`);
    if (!header.isInitial && header.trackingText) {
      // wt_longstatus_print_tracking
      for (const line of header.trackingText.split("\n").slice(0, -1)) {
        p.raw(`${options.commentPrefix !== undefined ? `${options.commentPrefix} ` : ""}${line}\n`);
      }
      p.raw(options.commentPrefix !== undefined ? `${options.commentPrefix}\n` : "\n");
    }
  }

  // wt_longstatus_print_state
  if (state.mergeInProgress) {
    if (state.rebaseInteractiveInProgress) {
      rebaseInformation(p, state, hints);
      p.raw("\n");
    }
    if (hasUnmerged) {
      p.ln("You have unmerged paths.");
      if (hints) {
        p.ln('  (fix conflicts and run "git commit")');
        p.ln('  (use "git merge --abort" to abort the merge)');
      }
    } else {
      p.ln("All conflicts fixed but you are still merging.");
      if (hints) p.ln('  (use "git commit" to conclude merge)');
    }
    trailer();
  } else if (state.amInProgress) {
    p.ln("You are in the middle of an am session.");
    if (state.amEmptyPatch) p.ln("The current patch is empty.");
    if (hints) {
      if (!state.amEmptyPatch) p.ln('  (fix conflicts and then run "git am --continue")');
      p.ln('  (use "git am --skip" to skip this patch)');
      if (state.amEmptyPatch) {
        p.ln('  (use "git am --allow-empty" to record this patch as an empty commit)');
      }
      p.ln('  (use "git am --abort" to restore the original branch)');
    }
    trailer();
  } else if (state.rebaseInProgress || state.rebaseInteractiveInProgress) {
    rebaseInProgress(p, state, hints, hasUnmerged, options.amend === true);
    trailer();
  } else if (state.cherryPickInProgress) {
    if (state.cherryPickHead === undefined) p.ln("Cherry-pick currently in progress.");
    else p.ln(`You are currently cherry-picking commit ${state.cherryPickHead}.`);
    if (hints) {
      if (hasUnmerged) p.ln('  (fix conflicts and run "git cherry-pick --continue")');
      else if (state.cherryPickHead === undefined) {
        p.ln('  (run "git cherry-pick --continue" to continue)');
      } else p.ln('  (all conflicts fixed: run "git cherry-pick --continue")');
      p.ln('  (use "git cherry-pick --skip" to skip this patch)');
      p.ln('  (use "git cherry-pick --abort" to cancel the cherry-pick operation)');
    }
    trailer();
  } else if (state.revertInProgress) {
    if (state.revertHead === undefined) p.ln("Revert currently in progress.");
    else p.ln(`You are currently reverting commit ${state.revertHead}.`);
    if (hints) {
      if (hasUnmerged) p.ln('  (fix conflicts and run "git revert --continue")');
      else if (state.revertHead === undefined) p.ln('  (run "git revert --continue" to continue)');
      else p.ln('  (all conflicts fixed: run "git revert --continue")');
      p.ln('  (use "git revert --skip" to skip this patch)');
      p.ln('  (use "git revert --abort" to cancel the revert operation)');
    }
    trailer();
  }
  if (state.bisectInProgress) {
    if (state.bisectingFrom !== undefined) {
      p.ln(`You are currently bisecting, started from branch '${state.bisectingFrom}'.`);
    } else p.ln("You are currently bisecting.");
    if (hints) p.ln('  (use "git bisect reset" to get back to the original branch)');
    trailer();
  }
  if (state.sparseCheckoutPercentage !== undefined) {
    p.ln(
      `You are in a sparse checkout with ${state.sparseCheckoutPercentage}% of tracked files present.`,
    );
    trailer();
  }

  if (header.isInitial) {
    p.ln("");
    p.ln(options.commitTemplate ? "Initial commit" : "No commits yet");
    p.ln("");
  }

  // the "to unstage" hint of the staged and unmerged headers
  const unstageHint = () => {
    if (whence !== "commit") return;
    if (!header.isInitial) {
      if (reference === "HEAD") p.ln('  (use "git restore --staged <file>..." to unstage)');
      else p.ln(`  (use "git restore --source=${reference} --staged <file>..." to unstage)`);
    } else p.ln('  (use "git rm --cached <file>..." to unstage)');
  };

  // wt_longstatus_print_updated
  const updated = change.filter((e) => !e.stages && e.index !== " ");
  if (updated.length > 0) {
    p.ln("Changes to be committed:");
    if (hints) unstageHint();
    for (const e of updated) changeLine(p, e, "updated", q);
    trailer();
  }

  // wt_longstatus_print_unmerged
  const unmerged = change.filter((e) => e.stages);
  if (unmerged.length > 0) {
    p.ln("Unmerged paths:");
    let bothDeleted = false;
    let delMod = false;
    let notDeleted = false;
    for (const e of change) {
      const mask = stagemask(e);
      if (mask === 0) continue;
      if (mask === 1) bothDeleted = true;
      else if (mask === 3 || mask === 5) delMod = true;
      else notDeleted = true;
    }
    if (hints) {
      unstageHint();
      if (!bothDeleted) {
        p.ln(
          delMod
            ? '  (use "git add/rm <file>..." as appropriate to mark resolution)'
            : '  (use "git add <file>..." to mark resolution)',
        );
      } else if (!delMod && !notDeleted) p.ln('  (use "git rm <file>..." to mark resolution)');
      else p.ln('  (use "git add/rm <file>..." as appropriate to mark resolution)');
    }
    for (const e of unmerged) {
      const how = UNMERGED_LABELS[stagemask(e)] as string;
      p.printf("\t");
      p.more(`${how}${" ".repeat(UNMERGED_LABEL_WIDTH - how.length)}${q(e.path)}\n`);
    }
    trailer();
  }

  // wt_longstatus_print_changed
  const changed = change.filter((e) => !e.stages && e.worktree !== " ");
  if (changed.length > 0) {
    const hasDeleted = changed.some((e) => e.worktree === "D");
    const dirtySubmodules = changed.some((e) => e.submoduleModified || e.submoduleUntracked);
    p.ln("Changes not staged for commit:");
    if (hints) {
      p.ln(
        hasDeleted
          ? '  (use "git add/rm <file>..." to update what will be committed)'
          : '  (use "git add <file>..." to update what will be committed)',
      );
      p.ln('  (use "git restore <file>..." to discard changes in working directory)');
      if (dirtySubmodules) {
        p.ln("  (commit or discard the untracked or modified content in submodules)");
      }
    }
    for (const e of changed) changeLine(p, e, "changed", q);
    trailer();
  }

  if (options.submoduleSummary) {
    const section = (output: string, title: string) => {
      const text = output ? `${title}\n\n${output}` : "";
      p.raw(
        options.commentPrefix !== undefined ? commentedLines(text, options.commentPrefix) : text,
      );
    };
    section(options.submoduleSummary.staged, "Submodule changes to be committed:");
    section(options.submoduleSummary.unstaged, "Submodules changed but not updated:");
  }

  const untrackedMode = options.untracked ?? "normal";
  if (untrackedMode !== "no") {
    otherSection(p, untracked, "Untracked files", "add", hints, q);
    if ((options.ignored ?? "no") !== "no") {
      otherSection(p, ignored, "Ignored files", "add -f", hints, q);
    }
  } else if (info.committable) {
    p.ln(`Untracked files not listed${hints ? " (use -u option to show untracked files)" : ""}`);
  }

  if (options.verbose !== undefined) p.raw(options.verbose);

  if (!info.committable) {
    if (options.amend) p.ln("No changes");
    else if (options.nowarn) {
      // nothing
    } else if (info.workdirDirty) {
      p.raw(
        hints
          ? 'no changes added to commit (use "git add" and/or "git commit -a")\n'
          : "no changes added to commit\n",
      );
    } else if (untracked.length > 0) {
      p.raw(
        hints
          ? 'nothing added to commit but untracked files present (use "git add" to track)\n'
          : "nothing added to commit but untracked files present\n",
      );
    } else if (header.isInitial) {
      p.raw(
        hints
          ? 'nothing to commit (create/copy files and use "git add" to track)\n'
          : "nothing to commit\n",
      );
    } else if (untrackedMode === "no") {
      p.raw(hints ? "nothing to commit (use -u to show untracked files)\n" : "nothing to commit\n");
    } else p.raw("nothing to commit, working tree clean\n");
  }
  if (options.showStash && (header.stashCount ?? 0) > 0) {
    const n = header.stashCount as number;
    p.ln(`Your stash currently has ${n} ${n === 1 ? "entry" : "entries"}`);
  }
  return p.out;
}

/** wt_longstatus_print_change_data. */
function changeLine(
  p: StatusPrinter,
  e: StatusFileEntry,
  kind: "updated" | "changed",
  q: (path: string) => string,
) {
  const status = kind === "updated" ? e.index : e.worktree;
  let extra = "";
  if (kind === "changed" && isSubmodule(e)) {
    const parts: string[] = [];
    if (e.submoduleCommitChanged) parts.push("new commits");
    if (e.submoduleModified) parts.push("modified content");
    if (e.submoduleUntracked) parts.push("untracked content");
    if (parts.length > 0) extra = ` (${parts.join(", ")})`;
  }
  const what = DIFF_LABELS[status] ?? `${status}:`;
  const pad = " ".repeat(DIFF_LABEL_WIDTH - what.length);
  const renamed = e.renamedFrom !== undefined && status === "R";
  p.printf("\t");
  p.more(
    renamed
      ? `${what}${pad}${q(e.renamedFrom as string)} -> ${q(e.path)}`
      : `${what}${pad}${q(e.path)}`,
  );
  if (extra) p.more(extra);
  p.more("\n");
}

/** wt_longstatus_print_other (no columns). */
function otherSection(
  p: StatusPrinter,
  paths: string[],
  what: string,
  how: string,
  hints: boolean,
  q: (path: string) => string,
) {
  if (paths.length === 0) return;
  p.ln(`${what}:`);
  if (hints) p.ln(`  (use "git ${how} <file>..." to include in what will be committed)`);
  for (const path of paths) {
    p.printf("\t");
    p.more(`${q(path)}\n`);
  }
  p.ln("");
}

/** show_rebase_information: an interactive rebase's done and remaining commands. */
function rebaseInformation(p: StatusPrinter, state: StatusState, hints: boolean) {
  if (!state.rebaseInteractiveInProgress) return;
  const shown = 2;
  const done = state.rebaseDone ?? [];
  const todo = state.rebaseTodo;
  if (todo === undefined) p.ln("git-rebase-todo is missing.");
  if (done.length === 0) p.ln("No commands done.");
  else {
    p.ln(
      done.length === 1
        ? `Last command done (${done.length} command done):`
        : `Last commands done (${done.length} commands done):`,
    );
    for (let i = done.length > shown ? done.length - shown : 0; i < done.length; i++) {
      p.ln(`   ${done[i]}`);
    }
    if (done.length > shown && hints) {
      p.ln(`  (see more in file ${state.rebaseDonePath ?? ".git/rebase-merge/done"})`);
    }
  }
  const remaining = todo ?? [];
  if (remaining.length === 0) p.ln("No commands remaining.");
  else {
    p.ln(
      remaining.length === 1
        ? `Next command to do (${remaining.length} remaining command):`
        : `Next commands to do (${remaining.length} remaining commands):`,
    );
    for (let i = 0; i < shown && i < remaining.length; i++) p.ln(`   ${remaining[i]}`);
    if (hints) p.ln('  (use "git rebase --edit-todo" to view and edit)');
  }
}

/** show_rebase_in_progress (without its trailer). */
function rebaseInProgress(
  p: StatusPrinter,
  state: StatusState,
  hints: boolean,
  hasUnmerged: boolean,
  amend: boolean,
) {
  rebaseInformation(p, state, hints);
  const printState = () => {
    if (state.branch !== undefined) {
      p.ln(`You are currently rebasing branch '${state.branch}' on '${state.onto ?? ""}'.`);
    } else p.ln("You are currently rebasing.");
  };
  if (hasUnmerged) {
    printState();
    if (hints) {
      p.ln('  (fix conflicts and then run "git rebase --continue")');
      p.ln('  (use "git rebase --skip" to skip this patch)');
      p.ln('  (use "git rebase --abort" to check out the original branch)');
    }
  } else if (state.rebaseInProgress || state.mergeMsgExists) {
    printState();
    if (hints) p.ln('  (all conflicts fixed: run "git rebase --continue")');
  } else if (state.splitCommitInProgress) {
    if (state.branch !== undefined) {
      p.ln(
        `You are currently splitting a commit while rebasing branch '${state.branch}' on '${state.onto ?? ""}'.`,
      );
    } else p.ln("You are currently splitting a commit during a rebase.");
    if (hints) p.ln('  (Once your working directory is clean, run "git rebase --continue")');
  } else {
    if (state.branch !== undefined) {
      p.ln(
        `You are currently editing a commit while rebasing branch '${state.branch}' on '${state.onto ?? ""}'.`,
      );
    } else p.ln("You are currently editing a commit during a rebase.");
    if (hints && !amend) {
      p.ln('  (use "git commit --amend" to amend the current commit)');
      p.ln('  (use "git rebase --continue" once you are satisfied with your changes)');
    }
  }
}
