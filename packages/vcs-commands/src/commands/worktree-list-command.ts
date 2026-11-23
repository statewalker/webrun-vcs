import type { Refs } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { LinkedWorktrees, WorktreeInfo } from "@statewalker/vcs-working-tree";

import { WorktreeError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { quotePath } from "../results/quote-path.js";
import { abbrevLengths } from "./core-config.js";
import { parseExpiry, requireWorktrees, type WorktreeExpiry } from "./worktree-support.js";

/** A worktree as `git worktree list` shows it. */
export interface WorktreeListEntry extends WorktreeInfo {
  /** Why it can be pruned (`should_prune_worktree` with `--expire`), when it can. */
  readonly prunableReason?: string;
}

/** What {@link WorktreeListCommand} found. */
export interface WorktreeListResult {
  /** The main worktree first, then the linked ones sorted by path. */
  worktrees: WorktreeListEntry[];
  /** git's output for the chosen format, byte for byte (as text). */
  output: string;
}

/** The formats of `git worktree list`. */
export type WorktreeListFormat = "default" | "verbose" | "porcelain";

/**
 * List the worktrees.
 *
 * Equivalent to `git worktree list [-v | --porcelain [-z]] [--expire <time>]`.
 *
 * @example
 * ```typescript
 * const { worktrees, output } = await git.worktreeList().setFormat("porcelain").call();
 * // worktree /src/repo\nHEAD 1f2e...\nbranch refs/heads/main\n\n...
 * ```
 *
 * The main worktree comes first, the linked ones sorted by path. The default format is a
 * line per worktree: the path padded to the longest, the abbreviated HEAD, then
 * `[branch]`, `(detached HEAD)`, `(bare)` or `(error)`, and ` locked` / ` prunable`;
 * `verbose` puts the lock and prune reasons on their own lines (`\tlocked: ...`). The
 * porcelain format gives `worktree`, `HEAD`, `branch` / `detached` / `bare`, `locked
 * [<reason>]` (C-quoted unless `-z`) and `prunable <reason>` lines, each record ending
 * with an empty line; `-z` ends every line with NUL instead. The default and verbose
 * formats are git 2.53's (paths quoted when they need it, one space after the widest);
 * `setLegacyColumns(true)` gives older git's (paths as they are, two spaces).
 */
export class WorktreeListCommand extends GitCommand<WorktreeListResult> {
  /** Never writes refs: runs in a repository whose ref store only reads. */
  protected override get writesRefs(): boolean {
    return false;
  }

  private format: WorktreeListFormat = "default";
  private nul = false;
  private expire: WorktreeExpiry = Number.POSITIVE_INFINITY;
  private legacyColumns = false;

  /** `default`, `verbose` (`-v`) or `porcelain` (`--porcelain`). */
  setFormat(format: WorktreeListFormat): this {
    this.checkCallable();
    this.format = format;
    return this;
  }

  /** `-z`: NUL-terminated porcelain lines (requires the porcelain format). */
  setNulTerminated(nul: boolean): this {
    this.checkCallable();
    this.nul = nul;
    return this;
  }

  /** `--expire <time>`: only missing worktrees older than this are prunable (default: all). */
  setExpire(expire: WorktreeExpiry): this {
    this.checkCallable();
    this.expire = expire;
    return this;
  }

  /**
   * The default and verbose formats as git before 2.53 printed them: paths as they are
   * (not quoted) and padded one column wider. Default: as git 2.53 and later.
   */
  setLegacyColumns(legacy: boolean): this {
    this.checkCallable();
    this.legacyColumns = legacy;
    return this;
  }

  async call(): Promise<WorktreeListResult> {
    this.checkCallable();
    this.setCallable(false);
    if (this.nul && this.format !== "porcelain") {
      throw new WorktreeError("the option '-z' requires '--porcelain'");
    }
    const worktrees = requireWorktrees(this.workingCopy, "list");
    const expire = parseExpiry(this.expire);
    const [main, ...linked] = await worktrees.list();
    linked.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const entries: WorktreeListEntry[] = [];
    for (const wt of [main, ...linked])
      entries.push(await this.withPruneReason(worktrees, wt, expire));
    const output =
      this.format === "porcelain"
        ? entries.map((wt) => this.porcelain(wt)).join("")
        : await this.lines(entries);
    return { worktrees: entries, output };
  }

  private async withPruneReason(
    worktrees: LinkedWorktrees,
    wt: WorktreeInfo,
    expire: number,
  ): Promise<WorktreeListEntry> {
    if (wt.id === undefined) return wt;
    const { reason } = await worktrees.pruneCheck(wt.id, expire);
    return reason === undefined ? wt : { ...wt, prunableReason: reason };
  }

  private quotePathFully(): boolean {
    return parseGitBool(RemoteConfigStore.from(this.workingCopy).value("core.quotePath")) ?? true;
  }

  /** git's `show_worktree_porcelain`. */
  private porcelain(wt: WorktreeListEntry): string {
    const lt = this.nul ? "\0" : "\n";
    let out = `worktree ${wt.path}${lt}`;
    if (wt.bare) out += `bare${lt}`;
    else {
      out += `HEAD ${wt.head ?? this.objectFormat.nullId}${lt}`;
      if (wt.detached) out += `detached${lt}`;
      else if (wt.headRef) out += `branch ${wt.headRef}${lt}`;
    }
    if (wt.lockReason !== undefined) {
      out += "locked";
      if (wt.lockReason !== "") {
        // write_name_quoted: C-quoted for a newline-terminated record, as it is with -z
        const reason = this.nul ? wt.lockReason : quotePath(wt.lockReason, this.quotePathFully());
        out += ` ${reason}`;
      }
      out += lt;
    }
    if (wt.prunableReason !== undefined) out += `prunable ${wt.prunableReason}${lt}`;
    return `${out}${lt}`;
  }

  /** git's `measure_widths` and `show_worktree`. */
  private async lines(entries: WorktreeListEntry[]): Promise<string> {
    const verbose = this.format === "verbose";
    const ids = entries.map((wt) => wt.head ?? this.objectFormat.nullId);
    const lengths = await abbrevLengths(this.workingCopy, ids);
    const abbrevLen = Math.max(...ids.map((id) => lengths.get(id) ?? 7));
    const fully = this.quotePathFully();
    // git 2.53+: quote_path, padded to one past the widest; before: as is, `%-*s ` of 1 + widest
    const display = entries.map((wt) => (this.legacyColumns ? wt.path : quotePath(wt.path, fully)));
    const width = (text: string) => [...text].length;
    const maxWidth = Math.max(...display.map(width));
    const pad = this.legacyColumns ? 2 : 1;
    let out = "";
    for (let i = 0; i < entries.length; i++) {
      const wt = entries[i];
      let line = `${display[i]}${" ".repeat(pad + maxWidth - width(display[i]))}`;
      if (wt.bare) line += "(bare)";
      else {
        const id = wt.head ?? this.objectFormat.nullId;
        line += `${id.slice(0, lengths.get(id) ?? 7).padEnd(abbrevLen)} `;
        if (wt.detached) line += "(detached HEAD)";
        else if (wt.headRef) line += `[${await shortenUnambiguousRef(this.refsStore, wt.headRef)}]`;
        else line += "(error)";
      }
      if (verbose && wt.lockReason) line += `\n\tlocked: ${wt.lockReason}`;
      else if (wt.lockReason !== undefined) line += " locked";
      if (verbose && wt.prunableReason !== undefined) line += `\n\tprunable: ${wt.prunableReason}`;
      else if (wt.prunableReason !== undefined) line += " prunable";
      out += `${line}\n`;
    }
    return out;
  }
}

/** git's ref_rev_parse_rules, as `shorten_unambiguous_ref` walks them. */
const RULES = [
  "%s",
  "refs/%s",
  "refs/tags/%s",
  "refs/heads/%s",
  "refs/remotes/%s",
  "refs/remotes/%s/HEAD",
];

/**
 * git's `shorten_unambiguous_ref` (non-strict): the shortest name that a rule maps back to
 * `ref` and that no earlier rule resolves to another ref.
 */
export async function shortenUnambiguousRef(refs: Refs, ref: string): Promise<string> {
  for (let i = RULES.length - 1; i > 0; i--) {
    const [prefix, suffix] = RULES[i].split("%s");
    if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) continue;
    const short = ref.slice(prefix.length, ref.length - suffix.length);
    if (short === "") continue;
    let ambiguous = false;
    for (let j = 0; j < i && !ambiguous; j++) {
      const candidate = RULES[j].replace("%s", short);
      if (candidate !== ref && (await refs.has(candidate).catch(() => false))) ambiguous = true;
    }
    if (!ambiguous) return short;
  }
  return ref;
}
