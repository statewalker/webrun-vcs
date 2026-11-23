/**
 * `git sparse-checkout`: the subcommands of git's builtin/sparse-checkout.c (`init`, `set`,
 * `add`, `list`, `reapply`, `disable`, `check-rules`) over the same files git keeps
 * (`$GIT_DIR/info/sparse-checkout`, `core.sparseCheckout` and `core.sparseCheckoutCone` in
 * `config.worktree`), so native git and this command continue each other's work.
 *
 * @example
 * ```typescript
 * // git sparse-checkout set k s/t
 * await git.sparseCheckout().setArguments(["set", "k", "s/t"]).call();
 * // the same, typed
 * await git.sparseCheckout().setSubcommand("set").addPattern("k").addPattern("s/t").call();
 * const listed = await git.sparseCheckout().setSubcommand("list").call();
 * console.log(listed.stdout); // "k\ns/t\n"
 * ```
 */

import { FileMode, joinPath, type PosixFilesApi } from "@statewalker/vcs-core";
import { GitWorkingCopyConfig } from "@statewalker/vcs-store-files";
import { parseGitBool } from "@statewalker/vcs-utils";
import {
  decodeGitPath,
  encodeGitPath,
  foldAsciiCase,
  unquoteGitPath,
} from "@statewalker/vcs-utils/encoding";
import {
  type SparseCheckoutPatterns,
  type SparseConeSets,
  type Staging,
  sparsePatternsFromCone,
  sparsePatternsFromLines,
  splitPatternLines,
  type WorkingCopyConfig,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { GitCommand } from "../git-command.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { quotePath } from "../results/quote-path.js";
import {
  cleanTrackedSparseDirectories,
  entryList,
  readSparseCheckoutFile,
  sparseCheckoutConfig,
  sparseDirectoriesOf,
  sparseWarningText,
  updateSparsity,
} from "./sparse-checkout-support.js";

/** What a `git sparse-checkout` command did. */
export interface SparseCheckoutResult {
  /** git's exit status: 0, 128 when it dies, 129 for a usage error */
  exitCode: number;
  /** What git prints on stdout (`list`, `check-rules`) */
  stdout: string;
  /** What git prints on stderr: its `warning:`, `error:` and `fatal:` lines */
  stderr: string;
  /**
   * The warnings among them, without `warning: `: the patterns' own (`unrecognized pattern:
   * '<p>'`, `disabling cone pattern matching`), the paths left despite the patterns, ...
   */
  warnings: string[];
}

/** The subcommands this command runs. */
export type SparseCheckoutSubcommand =
  | "init"
  | "set"
  | "add"
  | "list"
  | "reapply"
  | "disable"
  | "check-rules"
  | "clean";

const SUBCOMMANDS = new Set<string>([
  "list",
  "init",
  "set",
  "add",
  "reapply",
  "disable",
  "check-rules",
  "clean",
]);

const CONE_HELP = "    --[no-]cone           initialize the sparse-checkout in cone mode";
const SPARSE_INDEX_HELP = "    --[no-]sparse-index   toggle the use of a sparse index";
const SKIP_CHECKS_HELP =
  "    --skip-checks         skip some sanity checks on the given paths that might give false positives";

/** Each subcommand's usage line and option help, as parse_options prints them. */
const USAGE: Record<string, { line: string; options: string[] }> = {
  list: { line: "git sparse-checkout list", options: [] },
  init: {
    line: "git sparse-checkout init [--cone] [--[no-]sparse-index]",
    options: [CONE_HELP, SPARSE_INDEX_HELP],
  },
  set: {
    line: "git sparse-checkout set [--[no-]cone] [--[no-]sparse-index] [--skip-checks] (--stdin | <patterns>)",
    options: [
      CONE_HELP,
      SPARSE_INDEX_HELP,
      SKIP_CHECKS_HELP,
      "    --stdin               read patterns from standard in",
    ],
  },
  add: {
    line: "git sparse-checkout add [--skip-checks] (--stdin | <patterns>)",
    options: [SKIP_CHECKS_HELP, "    --[no-]stdin          read patterns from standard in"],
  },
  reapply: {
    line: "git sparse-checkout reapply [--[no-]cone] [--[no-]sparse-index]",
    options: [CONE_HELP, SPARSE_INDEX_HELP],
  },
  disable: { line: "git sparse-checkout disable", options: [] },
  "check-rules": {
    line: "git sparse-checkout check-rules [-z] [--skip-checks][--[no-]cone] [--rules-file <file>]",
    options: [
      "    -z                    terminate input and output files by a NUL character",
      "    --[no-]cone           when used with --rules-file interpret patterns as cone mode patterns",
      "    --[no-]rules-file <file>",
      "                          use patterns in <file> instead of the current ones.",
    ],
  },
};

/** The git version whose behaviour is reproduced where versions differ. */
export type SparseCheckoutCompatibility = "2.43" | "2.56";

/** git dying: `fatal: <message>`, exit 128 (or a usage error, exit 129). */
class SparseDie extends Error {
  constructor(
    message: string,
    readonly exitCode = 128,
    readonly raw = false,
  ) {
    super(message);
  }
}

/** The options of a subcommand, as its parse_options leaves them. */
interface SubOptions {
  cone: number;
  sparseIndex: number;
  skipChecks: boolean;
  stdin: boolean;
  nul: boolean;
  rulesFile?: string;
  args: string[];
}

/** A pattern list being built (git's `struct pattern_list`). */
interface PatternList {
  /** `use_cone_patterns` */
  cone: boolean;
  /** The patterns in order (non-cone mode, and the cone file's lines) */
  lines: string[];
  /** The recursive directories (cone mode; a multiset) */
  recursive: string[];
  /** The parent directories (cone mode; each once) */
  parent: string[];
}

/** The repository's settings as git holds them in its globals while the command runs. */
interface RunState {
  apply: boolean;
  cone: boolean;
  ignoreCase: boolean;
}

/**
 * `git sparse-checkout <subcommand> <options>` as git 2.5x runs it. Arguments are given as
 * on git's command line ({@link setArguments}) or with the typed setters; `--stdin` reads
 * {@link setStdin}, `--rules-file` the file named (relative to the worktree's root) or the
 * text given to {@link setRulesFile}. `--sparse-index` records `index.sparse=true` and the
 * index is written as a sparse index where cone mode allows it; `--no-sparse-index` records
 * `index.sparse=false` and writes it whole (both in `config.worktree` once the worktree
 * config is on, else in the repository's config, as git).
 */
export class SparseCheckoutCommand extends GitCommand<SparseCheckoutResult> {
  private args?: string[];
  private subcommand?: SparseCheckoutSubcommand;
  private patterns: string[] = [];
  private cone?: boolean;
  private sparseIndex?: boolean;
  private skipChecks = false;
  private useStdin = false;
  private nulTerminated = false;
  private stdin: Uint8Array = new Uint8Array();
  private rulesFileText?: string;
  private compatibility: SparseCheckoutCompatibility = "2.56";
  private dryRun = false;
  private force = false;
  private verbose = false;

  private out = "";
  private err = "";
  /**
   * Whether expanding the index still gives git 2.5x's `advice.sparseIndexExpanded` hint
   * (`give_advice_on_expansion`): the index read sparse and not expanded yet
   */
  private adviseOnExpansion = false;
  private warningList: string[] = [];

  /** The arguments after `git sparse-checkout` (the typed setters are then ignored). */
  setArguments(args: string[]): this {
    this.checkCallable();
    this.args = [...args];
    return this;
  }

  /** The subcommand to run. */
  setSubcommand(subcommand: SparseCheckoutSubcommand): this {
    this.checkCallable();
    this.subcommand = subcommand;
    return this;
  }

  /** A directory (cone mode) or pattern (non-cone mode) for `set` and `add`. */
  addPattern(pattern: string): this {
    this.checkCallable();
    this.patterns.push(pattern);
    return this;
  }

  /** `--cone` (true) or `--no-cone` (false) for `init`, `set`, `reapply` and `check-rules`. */
  setCone(cone: boolean): this {
    this.checkCallable();
    this.cone = cone;
    return this;
  }

  /** `--sparse-index` or `--no-sparse-index`. */
  setSparseIndex(sparseIndex: boolean): this {
    this.checkCallable();
    this.sparseIndex = sparseIndex;
    return this;
  }

  /** `--skip-checks` for `set` and `add`. */
  setSkipChecks(skip: boolean): this {
    this.checkCallable();
    this.skipChecks = skip;
    return this;
  }

  /** What `--stdin` (`set`, `add`) and `check-rules` read; with `useStdin` the typed `--stdin`. */
  setStdin(input: string | Uint8Array, useStdin = true): this {
    this.checkCallable();
    this.stdin = typeof input === "string" ? encodeGitPath(input) : input;
    this.useStdin = useStdin;
    return this;
  }

  /** `clean --dry-run` (`-n`): print what would be removed, remove nothing. */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** `clean --force` (`-f`), needed unless `--dry-run` or `clean.requireForce=false`. */
  setForce(force: boolean): this {
    this.checkCallable();
    this.force = force;
    return this;
  }

  /** `clean --verbose` (`-v`): each file removed, not only its directory. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this.verbose = verbose;
    return this;
  }

  /** `check-rules -z`: input and output terminated by NUL. */
  setNulTerminated(nul: boolean): this {
    this.checkCallable();
    this.nulTerminated = nul;
    return this;
  }

  /** `check-rules --rules-file`: the rules' text instead of a file. */
  setRulesFile(text: string): this {
    this.checkCallable();
    this.rulesFileText = text;
    return this;
  }

  /**
   * The git version reproduced (default 2.56): 2.43 takes an unknown option of `set`, `add`
   * and `check-rules` as an argument (`PARSE_OPT_KEEP_UNKNOWN_OPT`) and knows no `clean`.
   */
  setCompatibility(version: SparseCheckoutCompatibility): this {
    this.checkCallable();
    this.compatibility = version;
    return this;
  }

  async call(): Promise<SparseCheckoutResult> {
    this.checkCallable();
    this.setCallable(false);
    let exitCode = 0;
    try {
      exitCode = await this.dispatch(this.args ?? this.typedArguments());
    } catch (error) {
      if (!(error instanceof SparseDie)) throw error;
      exitCode = error.exitCode;
      this.err += error.raw ? error.message : `fatal: ${error.message}\n`;
    }
    return { exitCode, stdout: this.out, stderr: this.err, warnings: this.warningList };
  }

  /** The command line the typed setters stand for. */
  private typedArguments(): string[] {
    const args: string[] = [this.subcommand ?? "list"];
    if (this.cone !== undefined) args.push(this.cone ? "--cone" : "--no-cone");
    if (this.sparseIndex !== undefined) {
      args.push(this.sparseIndex ? "--sparse-index" : "--no-sparse-index");
    }
    if (this.skipChecks) args.push("--skip-checks");
    if (this.useStdin && (this.subcommand === "set" || this.subcommand === "add")) {
      args.push("--stdin");
    }
    if (this.nulTerminated) args.push("-z");
    if (this.subcommand === "clean") {
      if (this.dryRun) args.push("--dry-run");
      if (this.force) args.push("--force");
      if (this.verbose) args.push("--verbose");
    }
    if (this.patterns.length > 0) args.push("--", ...this.patterns);
    return args;
  }

  private warn(message: string): void {
    this.warningList.push(message);
    this.err += `warning: ${message}\n`;
  }

  /** git's `warning:` lines for the patterns read, in the order git prints them. */
  private warnPatterns(patterns: SparseCheckoutPatterns): void {
    for (const w of patterns.warnings) this.warn(w);
  }

  /** cmd_sparse_checkout: OPT_SUBCOMMANDs */
  private async dispatch(argv: string[]): Promise<number> {
    const [sub, ...rest] = argv;
    const known = (name: string) =>
      SUBCOMMANDS.has(name) && (name !== "clean" || this.compatibility !== "2.43");
    if (sub === undefined) throw this.usage("", "need a subcommand");
    if (!known(sub)) {
      if (sub.startsWith("-") && sub !== "-") throw this.usage("", unknownOption(sub));
      throw this.usage("", `unknown subcommand: \`${sub}'`);
    }
    if (sub === "clean") return this.clean(rest);
    const opts = this.parseOptions(sub, rest);
    const state = this.runState();
    // disable expands the index on purpose: no hint
    this.adviseOnExpansion =
      sub !== "disable" &&
      this.compatibility !== "2.43" &&
      this.staging.indexLayout?.().sparse === true;
    switch (sub) {
      case "list":
        return this.list(state);
      case "init":
        return this.init(state, opts);
      case "set":
        return this.set(state, opts);
      case "add":
        return this.add(state, opts);
      case "reapply":
        return this.reapply(state, opts);
      case "disable":
        return this.disable(state);
      default:
        return this.checkRules(state, opts);
    }
  }

  /** parse_options' usage error: `error: <message>`, the usage and option help, exit 129. */
  private usage(sub: string, message: string): SparseDie {
    if (sub === "") {
      const subs = `init | list | set | add | reapply | disable | check-rules${
        this.compatibility === "2.43" ? "" : " | clean"
      }`;
      return new SparseDie(
        `error: ${message}\nusage: git sparse-checkout (${subs}) [<options>]\n\n`,
        129,
        true,
      );
    }
    const usage = USAGE[sub] as { line: string; options: string[] };
    const options = usage.options.length > 0 ? `${usage.options.join("\n")}\n\n` : "";
    return new SparseDie(`error: ${message}\nusage: ${usage.line}\n\n${options}`, 129, true);
  }

  /** Each subcommand's parse_options: its options, anywhere before `--`. */
  private parseOptions(sub: string, rest: string[]): SubOptions {
    const opts: SubOptions = {
      cone: -1,
      sparseIndex: -1,
      skipChecks: false,
      stdin: false,
      nul: false,
      args: [],
    };
    const accepts = (name: string) => {
      switch (sub) {
        case "init":
          return name === "cone" || name === "sparse-index";
        case "set":
          return ["cone", "sparse-index", "skip-checks", "stdin"].includes(name);
        case "add":
          return name === "skip-checks" || name === "stdin";
        case "reapply":
          return name === "cone" || name === "sparse-index";
        case "check-rules":
          return name === "cone" || name === "rules-file" || name === "z";
        default:
          return false;
      }
    };
    // OPT_BOOL_F(..., PARSE_OPT_NONEG): no `--no-` form
    const noNegation = (name: string) =>
      name === "skip-checks" || (name === "stdin" && sub === "set");
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] as string;
      if (arg === "--") {
        opts.args.push(...rest.slice(i + 1));
        break;
      }
      if (arg === "-z" && accepts("z")) {
        opts.nul = true;
        continue;
      }
      if (!arg.startsWith("-") || arg === "-") {
        opts.args.push(arg);
        continue;
      }
      if (!arg.startsWith("--")) {
        if (this.keepsUnknown(sub)) opts.args.push(arg);
        else throw this.usage(sub, unknownOption(arg));
        continue;
      }
      let name = arg.slice(2);
      let value: string | undefined;
      const eq = name.indexOf("=");
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      let negated = false;
      if (name.startsWith("no-") && accepts(name.slice(3)) && !noNegation(name.slice(3))) {
        negated = true;
        name = name.slice(3);
      }
      if (!accepts(name)) {
        if (this.keepsUnknown(sub)) opts.args.push(arg);
        else throw this.usage(sub, unknownOption(arg));
        continue;
      }
      if (name === "rules-file") {
        if (negated) {
          opts.rulesFile = undefined;
          continue;
        }
        if (value === undefined) {
          value = rest[++i];
          if (value === undefined) {
            throw new SparseDie("error: option `rules-file' requires a value\n", 129, true);
          }
        }
        opts.rulesFile = value;
        continue;
      }
      if (value !== undefined) {
        throw new SparseDie(`error: option \`${name}' takes no value\n`, 129, true);
      }
      if (name === "cone") opts.cone = negated ? 0 : 1;
      else if (name === "sparse-index") opts.sparseIndex = negated ? 0 : 1;
      else if (name === "skip-checks") opts.skipChecks = true;
      else if (name === "stdin") opts.stdin = !negated;
    }
    if (this.args === undefined && this.rulesFileText !== undefined && sub === "check-rules") {
      opts.rulesFile = "";
    }
    return opts;
  }

  /** 2.43's PARSE_OPT_KEEP_UNKNOWN_OPT of `set`, `add` and `check-rules` */
  private keepsUnknown(sub: string): boolean {
    return (
      this.compatibility === "2.43" && (sub === "set" || sub === "add" || sub === "check-rules")
    );
  }

  private runState(): RunState {
    const config = sparseCheckoutConfig(this.workingCopy);
    return { apply: config.enabled, cone: config.cone, ignoreCase: config.ignoreCase };
  }

  // ---------------------------------------------------------------- subcommands

  /**
   * sparse_checkout_clean (git 2.5x): every directory the index collapses to a sparse
   * directory (`convert_to_sparse` in memory, whatever `index.sparse` says) is removed with
   * all it holds, untracked and ignored files too; a directory missing from the worktree is
   * passed over. A sparse directory that is a symbolic link in the worktree is passed over
   * too, where git follows it (`remove_dir_recursively` of the path) and empties the
   * directory it points to, which may lie outside the worktree: ours keeps that data, the
   * safer choice.
   */
  private async clean(rest: string[]): Promise<number> {
    const state = this.runState();
    // setup_work_tree, then the mode checks before parse_options
    if (!state.apply) throw new SparseDie("must be in a sparse-checkout to clean directories");
    if (!state.cone) {
      throw new SparseDie("must be in a cone-mode sparse-checkout to clean directories");
    }
    const opts = parseCleanOptions(rest);
    if (opts.help) {
      this.out += CLEAN_USAGE;
      return 0;
    }
    if (opts.error !== undefined) {
      // a value given to a flag is reported alone, as parse_options does
      const usage = opts.error.endsWith("takes no value") ? "" : CLEAN_USAGE;
      throw new SparseDie(`error: ${opts.error}\n${usage}`, 129, true);
    }
    const raw = RemoteConfigStore.from(this.workingCopy).value("clean.requireforce");
    let requireForce = true;
    if (raw !== undefined) {
      const parsed = parseGitBool(raw);
      if (parsed === undefined) {
        throw new SparseDie(`bad boolean config value '${raw}' for 'clean.requireforce'`);
      }
      requireForce = parsed;
    }
    if (requireForce && !opts.force && !opts.dryRun) {
      throw new SparseDie("for safety, refusing to clean without one of --force or --dry-run");
    }
    const content = await readSparseCheckoutFile(this.workingCopy);
    const patterns = sparsePatternsFromLines(
      content === undefined ? [] : splitPatternLines(content),
      state.cone,
      state.ignoreCase,
    );
    const dirs = sparseDirectoriesOf(await entryList(this.staging), patterns);
    if (!dirs) {
      throw new SparseDie(
        "failed to convert index to a sparse index; resolve merge conflicts and try again",
      );
    }
    const worktree = this.worktreeAccess;
    if (!worktree) return 0;
    const message = opts.dryRun ? "Would remove" : "Removing";
    for (const dir of dirs) {
      const path = dir.slice(0, -1);
      const current = await worktree.getEntry(path).catch(() => undefined);
      if (!current?.isDirectory || current.mode === FileMode.SYMLINK) continue;
      if (opts.verbose) {
        for (const file of await this.filesBelow(worktree, dir)) this.out += `${message} ${file}\n`;
      } else {
        this.out += `${message} ${dir}\n`;
      }
      if (opts.dryRun) continue;
      const removed = await worktree.remove(path, { recursive: true }).catch(() => false);
      if (!removed) this.warn(`failed to remove '${dir}'`);
    }
    return 0;
  }

  /**
   * dir.c's for_each_file_in_dir under `dir` (with its trailing slash): the regular files,
   * depth first in readdir order; symbolic links and other kinds are not listed.
   */
  private async filesBelow(worktree: Worktree, dir: string): Promise<string[]> {
    const files = worktree.getFiles?.() as PosixFilesApi | undefined;
    const root = worktree.getRoot?.() ?? "";
    if (!files) return [];
    const full = (path: string) => (root ? joinPath(root, path) : path);
    const out: string[] = [];
    const walk = async (prefix: string): Promise<void> => {
      let entries: { name: string; kind?: string }[] = [];
      try {
        if (files.listKinds) {
          entries = await files.listKinds(full(prefix.slice(0, -1)), { readdirOrder: true });
        } else {
          for await (const e of files.list(full(prefix.slice(0, -1)))) {
            entries.push({ name: e.name, kind: e.kind });
          }
        }
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = `${prefix}${entry.name}`;
        let kind = entry.kind;
        if (kind === undefined)
          kind = (await files.lstat?.(full(path)).catch(() => undefined))?.kind;
        if (kind === "file") out.push(path);
        else if (kind === "directory") await walk(`${path}/`);
      }
    };
    await walk(dir);
    return out;
  }

  /** sparse_checkout_list */
  private async list(state: RunState): Promise<number> {
    if (!state.apply) throw new SparseDie("this worktree is not sparse");
    const content = await readSparseCheckoutFile(this.workingCopy);
    if (content === undefined) {
      this.warn("this worktree is not sparse (sparse-checkout file may not exist)");
      return 0;
    }
    const patterns = sparsePatternsFromLines(
      splitPatternLines(content),
      state.cone,
      state.ignoreCase,
    );
    this.warnPatterns(patterns);
    if (patterns.coneSets) {
      const names = sortUnique(patterns.coneSets.recursive.map((p) => p.slice(1)));
      const quote = this.quotePathFully();
      for (const name of names) this.out += `${quotePath(name, quote)}\n`;
    } else {
      for (const line of patterns.lines) this.out += `${line}\n`;
    }
    return 0;
  }

  /** sparse_checkout_init */
  private async init(state: RunState, opts: SubOptions): Promise<number> {
    await this.readCurrentIndex();
    await this.updateModes(state, opts);
    const content = await readSparseCheckoutFile(this.workingCopy);
    // an existing sparse-checkout file is used as it is
    if (content !== undefined) return this.updateWorkingDirectory(state, undefined);
    const head = await this.refsStore.resolve("HEAD").catch(() => undefined);
    if (!head?.objectId) {
      // a fresh repository: the file written, nothing to update
      await this.writeSparseFile("/*\n!/*/\n");
      return 0;
    }
    const pl: PatternList = {
      cone: opts.cone !== 0,
      lines: ["/*", "!/*/"],
      recursive: [],
      parent: [],
    };
    return this.writePatternsAndUpdate(state, pl);
  }

  /** sparse_checkout_set */
  private async set(state: RunState, opts: SubOptions): Promise<number> {
    await this.readCurrentIndex();
    await this.updateModes(state, opts);
    let patterns: string[];
    if (!state.cone && !opts.stdin && opts.args.length === 0) {
      // non-cone mode without patterns: the top-level directory only, as `init`
      patterns = ["/*", "!/*/"];
    } else {
      patterns = [...opts.args];
      await this.sanitizePaths(state, patterns, opts.skipChecks);
    }
    return this.modifyPatternList(state, patterns, opts.stdin, "replace");
  }

  /** sparse_checkout_add */
  private async add(state: RunState, opts: SubOptions): Promise<number> {
    if (!state.apply) throw new SparseDie("no sparse-checkout to add to");
    await this.readCurrentIndex();
    const patterns = [...opts.args];
    await this.sanitizePaths(state, patterns, opts.skipChecks);
    return this.modifyPatternList(state, patterns, opts.stdin, "add");
  }

  /** sparse_checkout_reapply */
  private async reapply(state: RunState, opts: SubOptions): Promise<number> {
    if (!state.apply) {
      throw new SparseDie("must be in a sparse-checkout to reapply sparsity patterns");
    }
    await this.readCurrentIndex();
    await this.updateModes(state, opts);
    return this.updateWorkingDirectory(state, undefined);
  }

  /** sparse_checkout_disable: back to a full checkout, whatever the state */
  private async disable(state: RunState): Promise<number> {
    await this.readCurrentIndex();
    state.apply = true;
    const pl: PatternList = { cone: false, lines: ["/*"], recursive: [], parent: [] };
    if ((await this.updateWorkingDirectory(state, pl)) !== 0) {
      throw new SparseDie("error while refreshing working directory");
    }
    await this.setConfig("none");
    return 0;
  }

  /** sparse_checkout_check_rules */
  private async checkRules(state: RunState, opts: SubOptions): Promise<number> {
    let cone = opts.cone;
    if (opts.rulesFile !== undefined && cone < 0) cone = 1;
    this.updateConeMode(state, cone);
    let patterns: SparseCheckoutPatterns;
    if (opts.rulesFile !== undefined) {
      const text = this.rulesFileText ?? (await this.readRulesFile(opts.rulesFile));
      const pl = this.patternsFromInput(state, [], linesOf(text));
      patterns = this.matcherOf(pl, state);
    } else {
      const content = await readSparseCheckoutFile(this.workingCopy);
      if (content === undefined)
        throw new SparseDie("unable to load existing sparse-checkout patterns");
      patterns = sparsePatternsFromLines(splitPatternLines(content), state.cone, state.ignoreCase);
      this.warnPatterns(patterns);
    }
    const terminator = opts.nul ? "\0" : "\n";
    const quote = this.quotePathFully();
    for (const raw of inputLines(this.stdin, opts.nul)) {
      let path = decodeGitPath(raw);
      if (!opts.nul && raw[0] === 0x22) {
        const unquoted = unquoteGitPath(raw);
        if (!unquoted) throw new SparseDie(`unable to unquote C-style string '${path}'`);
        path = unquoted.path;
      }
      if (patterns.includes(path)) {
        this.out += `${opts.nul ? path : quotePath(path, quote)}${terminator}`;
      }
    }
    return 0;
  }

  // ---------------------------------------------------------------- git's helpers

  /** update_cone_mode */
  private updateConeMode(state: RunState, coneMode: number): "cone" | "all" {
    let cone = coneMode;
    // if not given, the previous definition of cone mode
    if (cone === -1 && state.apply) cone = state.cone ? 1 : 0;
    state.apply = true;
    if (cone === 1 || cone === -1) {
      state.cone = true;
      return "cone";
    }
    state.cone = false;
    return "all";
  }

  /** update_modes */
  private async updateModes(state: RunState, opts: SubOptions): Promise<void> {
    const recordMode = opts.cone !== -1 || !state.apply;
    const mode = this.updateConeMode(state, opts.cone);
    if (recordMode) await this.setConfig(mode);
    // set_sparse_index_config: the setting recorded, the index written again (sparse when
    // the cone allows it, whole for --no-sparse-index) by update_working_directory's write
    if (opts.sparseIndex >= 0) {
      await this.setWorktreeConfigGently([
        ["index.sparse", opts.sparseIndex === 1 ? "true" : "false"],
      ]);
      // ensure_full_index
      if (opts.sparseIndex === 0) this.expandIndex();
    }
  }

  /** git's `expand_index` to a full index: 2.5x's hint the first time a sparse index expands. */
  private expandIndex(): void {
    if (!this.adviseOnExpansion) return;
    this.adviseOnExpansion = false;
    const config = this.workingCopy.config as { get?(key: string): unknown } | undefined;
    const value = String(config?.get?.("advice.sparseIndexExpanded") ?? "true").toLowerCase();
    if (["false", "no", "off", "0"].includes(value)) return;
    this.err +=
      "hint: The sparse index is expanding to a full index, a slow operation.\n" +
      "hint: Your working directory likely has contents that are outside of\n" +
      "hint: your sparse-checkout patterns. Use 'git sparse-checkout list' to\n" +
      "hint: see your sparse-checkout definition and compare it to your working\n" +
      "hint: directory contents. Cleaning up any merge conflicts or staged\n" +
      "hint: changes before running 'git sparse-checkout clean' or 'git\n" +
      "hint: sparse-checkout reapply' may assist in this cleanup.\n" +
      'hint: Disable this message with "git config set advice.sparseIndexExpanded false"\n';
  }

  /** set_config: the worktree's config (init_worktree_config first) */
  private async setConfig(mode: "none" | "all" | "cone"): Promise<void> {
    const values: [string, string][] = [
      ["core.sparseCheckout", mode === "none" ? "false" : "true"],
      ["core.sparseCheckoutCone", mode === "cone" ? "true" : "false"],
    ];
    if (mode === "none") values.push(["index.sparse", "false"]);
    await this.writeWorktreeConfig(values);
  }

  /**
   * `repo_config_set_worktree_gently` after `init_worktree_config`: `extensions.worktreeConfig`
   * set in the repository's config if it is not, then the values written to this worktree's
   * `config.worktree`. A configuration without files takes the values itself.
   */
  private async writeWorktreeConfig(values: [string, string][]): Promise<void> {
    const config = this.workingCopy.config as
      | (WorkingCopyConfig & {
          get?(key: string): unknown;
          set?(key: string, value: unknown): void;
          save?(): Promise<void>;
          load?(): Promise<void>;
        })
      | undefined;
    if (!config) return;
    const checkout = this.workingCopy.checkout;
    const fileBacked =
      typeof config.load === "function" &&
      typeof config.save === "function" &&
      typeof config.set === "function" &&
      typeof checkout?.readStateFile === "function" &&
      typeof checkout?.writeStateFile === "function";
    if (!fileBacked || !checkout?.readStateFile || !checkout.writeStateFile) {
      for (const [key, value] of values) {
        if (typeof config.set === "function") config.set(key, value);
        else config[key] = value;
      }
      return;
    }
    const enabled = String(config.get?.("extensions.worktreeConfig") ?? "").toLowerCase();
    if (!["true", "yes", "on", "1"].includes(enabled)) {
      config.set?.("extensions.worktreeConfig", "true");
      await config.save?.();
    }
    const read = checkout.readStateFile.bind(checkout);
    const write = checkout.writeStateFile.bind(checkout);
    const worktreeConfig = new GitWorkingCopyConfig(
      { read: (path) => read(path), write: (path, content) => write(path, content) },
      "config.worktree",
      { includes: false },
    );
    await worktreeConfig.load();
    for (const [key, value] of values) worktreeConfig.set(key, value);
    await worktreeConfig.save();
    // the repository's config reads config.worktree again
    await config.load?.();
  }

  /**
   * `repo_config_set_worktree_gently`: the values written to this worktree's
   * `config.worktree` when `extensions.worktreeConfig` is on, else to the repository's config.
   */
  private async setWorktreeConfigGently(values: [string, string][]): Promise<void> {
    const config = this.workingCopy.config as
      | (WorkingCopyConfig & {
          get?(key: string): unknown;
          set?(key: string, value: unknown): void;
          save?(): Promise<void>;
        })
      | undefined;
    const enabled = String(config?.get?.("extensions.worktreeConfig") ?? "").toLowerCase();
    if (["true", "yes", "on", "1"].includes(enabled) || !config?.save || !config.set) {
      await this.writeWorktreeConfig(values);
      return;
    }
    for (const [key, value] of values) config.set(key, value);
    await config.save();
  }

  /** modify_pattern_list */
  private async modifyPatternList(
    state: RunState,
    args: string[],
    useStdin: boolean,
    kind: "replace" | "add",
  ): Promise<number> {
    const stdinLines = useStdin ? linesOf(decodeGitPath(this.stdin)) : undefined;
    let pl: PatternList;
    if (kind === "add") {
      pl = state.cone
        ? await this.addPatternsConeMode(state, args, stdinLines)
        : await this.addPatternsLiteral(state, args, stdinLines);
    } else {
      pl = this.patternsFromInput(state, args, stdinLines);
    }
    let changedConfig = false;
    if (!state.apply) {
      await this.setConfig("all");
      state.apply = true;
      changedConfig = true;
    }
    const result = await this.writePatternsAndUpdate(state, pl);
    if (result && changedConfig) await this.setConfig("none");
    return result;
  }

  /** add_patterns_from_input: cone-mode directories or literal patterns */
  private patternsFromInput(
    state: RunState,
    args: string[],
    stdinLines: string[] | undefined,
  ): PatternList {
    const pl: PatternList = { cone: false, lines: [], recursive: [], parent: [] };
    if (state.cone) {
      pl.cone = true;
      if (stdinLines) {
        for (const raw of stdinLines) {
          let line = raw;
          if (line.startsWith('"')) {
            const unquoted = unquoteGitPath(encodeGitPath(line));
            if (!unquoted) throw new SparseDie(`unable to unquote C-style string '${line}'`);
            line = unquoted.path;
          }
          this.toConePattern(line, pl, state);
        }
      } else {
        for (const arg of args) this.toConePattern(arg, pl, state);
      }
    } else {
      pl.lines.push(...(stdinLines ?? args));
    }
    return pl;
  }

  /** strbuf_to_cone_pattern */
  private toConePattern(input: string, pl: PatternList, state: RunState): void {
    let line = input.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
    while (line.endsWith("/")) line = line.slice(0, -1);
    const normalized = normalizePath(line);
    if (normalized === undefined) throw new SparseDie(`could not normalize path ${line}`);
    if (!normalized) return;
    insertRecursivePattern(pl, normalized.startsWith("/") ? normalized : `/${normalized}`, state);
  }

  /** add_patterns_cone_mode */
  private async addPatternsConeMode(
    state: RunState,
    args: string[],
    stdinLines: string[] | undefined,
  ): Promise<PatternList> {
    const pl = this.patternsFromInput(state, args, stdinLines);
    const content = await readSparseCheckoutFile(this.workingCopy);
    if (content === undefined)
      throw new SparseDie("unable to load existing sparse-checkout patterns");
    const existing = sparsePatternsFromLines(
      splitPatternLines(content),
      state.cone,
      state.ignoreCase,
    );
    this.warnPatterns(existing);
    if (!existing.coneSets)
      throw new SparseDie("existing sparse-checkout patterns do not use cone mode");
    for (const pattern of existing.coneSets.recursive) {
      if (
        !containsParent(pl.recursive, pattern, state) ||
        !containsParent(pl.parent, pattern, state)
      ) {
        insertRecursivePattern(pl, pattern, state);
      }
    }
    return pl;
  }

  /** add_patterns_literal */
  private async addPatternsLiteral(
    state: RunState,
    args: string[],
    stdinLines: string[] | undefined,
  ): Promise<PatternList> {
    const content = await readSparseCheckoutFile(this.workingCopy);
    if (content === undefined)
      throw new SparseDie("unable to load existing sparse-checkout patterns");
    const pl = this.patternsFromInput(state, args, stdinLines);
    pl.lines.unshift(...splitPatternLines(content));
    return pl;
  }

  /** sanitize_paths (from the top-level directory: no prefix) */
  private async sanitizePaths(state: RunState, args: string[], skipChecks: boolean): Promise<void> {
    if (args.length === 0 || skipChecks) return;
    if (state.cone) {
      for (const arg of args) {
        if (arg.startsWith("/")) {
          throw new SparseDie("specify directories rather than patterns (no leading slash)");
        }
        if (arg.startsWith("!")) {
          throw new SparseDie(
            "specify directories rather than patterns.  If your directory starts with a '!', pass --skip-checks",
          );
        }
        if (/[*?[\]]/.test(arg)) {
          throw new SparseDie(
            "specify directories rather than patterns.  If your directory really has any of '*?[]\\' in it, pass --skip-checks",
          );
        }
      }
    }
    const tracked = new Set<string>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0) tracked.add(entry.path);
    }
    for (const arg of args) {
      if (!tracked.has(arg)) continue;
      if (state.cone) {
        throw new SparseDie(
          `'${arg}' is not a directory; to treat it as a directory anyway, rerun with --skip-checks`,
        );
      }
      this.warn(
        `pass a leading slash before paths such as '${arg}' if you want a single file (see NON-CONE PROBLEMS in the git-sparse-checkout manual).`,
      );
    }
  }

  /** write_patterns_and_update */
  private async writePatternsAndUpdate(state: RunState, pl: PatternList): Promise<number> {
    const result = await this.updateWorkingDirectory(state, pl);
    if (result) {
      await this.updateWorkingDirectory(state, undefined);
      return result;
    }
    await this.writeSparseFile(state.cone ? coneFileText(pl, state) : patternsFileText(pl.lines));
    return 0;
  }

  /**
   * The matcher of a pattern list as git's `path_in_sparse_checkout` uses it: a cone-mode
   * list by its hashsets (none for `init`'s, whose patterns were added before cone mode was
   * set), any other by its patterns.
   */
  private matcherOf(pl: PatternList, state: RunState): SparseCheckoutPatterns {
    if (pl.cone) {
      const sets: SparseConeSets = { full: false, recursive: pl.recursive, parent: pl.parent };
      return sparsePatternsFromCone(sets, state.ignoreCase);
    }
    return sparsePatternsFromLines(pl.lines, false, state.ignoreCase);
  }

  /** update_working_directory: git's `update_sparsity` with `pl` (absent: the file's patterns) */
  private async updateWorkingDirectory(
    state: RunState,
    pl: PatternList | undefined,
  ): Promise<number> {
    const staging = this.staging;
    // no branch checked out: nothing to update
    let any = false;
    for await (const _ of staging.entries()) {
      any = true;
      break;
    }
    if (!any) return 0;
    let patterns: SparseCheckoutPatterns;
    if (pl) patterns = this.matcherOf(pl, state);
    else {
      const content = await readSparseCheckoutFile(this.workingCopy);
      patterns = sparsePatternsFromLines(
        content === undefined ? [] : splitPatternLines(content),
        state.cone,
        state.ignoreCase,
      );
      this.warnPatterns(patterns);
    }
    // update_sparsity's expand_index: patterns not of the cone's shape expand it fully
    if (!patterns.cone || patterns.coneSets === undefined) this.expandIndex();
    // write_locked_index converts to a sparse index with the patterns being applied (git sets
    // them on the index for update_sparsity), when index.sparse and cone mode allow it
    const previousHost = staging.getIndexHost?.();
    if (staging.setIndexHost) {
      const allowed = state.apply && state.cone && patterns.cone && patterns.coneSets !== undefined;
      staging.setIndexHost({
        ...(previousHost ?? {}),
        ...(previousHost?.trees ? { trees: previousHost.trees } : {}),
        settings: async () => {
          const settings = { ...((await previousHost?.settings?.()) ?? {}) };
          const config = RemoteConfigStore.from(this.workingCopy);
          const indexSparse = (() => {
            try {
              return parseGitBool(config.value("index.sparse")) === true;
            } catch {
              return false;
            }
          })();
          if (allowed && indexSparse) settings.sparse = patterns;
          else delete settings.sparse;
          return settings;
        },
      });
    }
    try {
      return await this.applySparsity(state, pl, patterns, staging);
    } finally {
      staging.setIndexHost?.(previousHost);
    }
  }

  /** update_working_directory once its patterns are known: update_sparsity, then the write. */
  private async applySparsity(
    state: RunState,
    pl: PatternList | undefined,
    patterns: SparseCheckoutPatterns,
    staging: Staging,
  ): Promise<number> {
    const outcome = await updateSparsity(
      {
        workingCopy: this.workingCopy,
        worktree: this.worktreeAccess,
        staging,
        blobs: this.blobs,
      },
      patterns,
    );
    // check_updates (its unlink warnings) before display_warning_msgs
    for (const line of outcome.unlinkWarnings) {
      this.err += line;
      this.warningList.push(line.slice("warning: ".length, -1));
    }
    const text = sparseWarningText(outcome, true);
    if (text) {
      this.err += text;
      for (const block of text.split("\n\n")) {
        if (block.startsWith("warning: ")) this.warningList.push(block.slice("warning: ".length));
      }
    }
    // write_locked_index: also the flags cleared on reading the index
    if (!outcome.changed) await staging.write();
    // clean_tracked_sparse_directories reads the patterns again (init_sparse_checkout_patterns)
    // when none were given: their warnings are printed twice
    if (!pl && state.apply) this.warnPatterns(patterns);
    const cleaned = await cleanTrackedSparseDirectories(
      { worktree: this.worktreeAccess, staging },
      patterns,
    );
    for (const line of cleaned.split("\n")) {
      if (line) this.warn(line.slice("warning: ".length));
    }
    return 0;
  }

  private async writeSparseFile(text: string): Promise<void> {
    const checkout = this.workingCopy.checkout;
    if (!checkout?.writeStateFile) {
      throw new SparseDie("failed to create directory for sparse-checkout file");
    }
    await checkout.writeStateFile("info/sparse-checkout", encodeGitPath(text));
  }

  /** OPT_FILENAME: the rules file, relative to the worktree's root */
  private async readRulesFile(path: string): Promise<string> {
    const worktree = this.worktreeAccess;
    const fail = () =>
      new SparseDie(`could not open '${path}' for reading: No such file or directory`);
    if (!worktree) throw fail();
    const entry = await worktree.getEntry(path).catch(() => undefined);
    if (!entry || entry.isDirectory) throw fail();
    const chunks: Uint8Array[] = [];
    for await (const chunk of worktree.readContent(path)) chunks.push(chunk);
    let size = 0;
    for (const c of chunks) size += c.length;
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return decodeGitPath(bytes);
  }

  /** `core.quotePath` */
  private quotePathFully(): boolean {
    const config = this.workingCopy.config as { get?(key: string): unknown } | undefined;
    const value = String(config?.get?.("core.quotePath") ?? "true").toLowerCase();
    return !["false", "no", "off", "0"].includes(value);
  }
}

// ------------------------------------------------------------------ helpers

const CLEAN_USAGE =
  "usage: git sparse-checkout clean [-n|--dry-run]\n\n" +
  "    -n, --[no-]dry-run    dry run\n" +
  "    -f, --[no-]force      force\n" +
  "    -v, --[no-]verbose    report each affected file, not just directories\n\n";

/**
 * parse_options of `sparse-checkout clean`: `-n`/`--dry-run`, `-f`/`--force` and
 * `-v`/`--verbose` (bundled short options, unique prefixes, `--no-` forms), anywhere before
 * `--`; other arguments are ignored, as git ignores them.
 */
function parseCleanOptions(rest: string[]): {
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
  help?: boolean;
  error?: string;
} {
  const opts = { dryRun: false, force: false, verbose: false };
  const longs = ["dry-run", "force", "verbose"] as const;
  const set = (name: (typeof longs)[number], value: boolean) => {
    if (name === "dry-run") opts.dryRun = value;
    else if (name === "force") opts.force = value;
    else opts.verbose = value;
  };
  for (const arg of rest) {
    if (arg === "--") break;
    if (arg === "-h") return { ...opts, help: true };
    if (!arg.startsWith("-") || arg === "-") continue;
    if (!arg.startsWith("--")) {
      for (const c of arg.slice(1)) {
        if (c === "n") opts.dryRun = true;
        else if (c === "f") opts.force = true;
        else if (c === "v") opts.verbose = true;
        else if (c === "h") return { ...opts, help: true };
        else return { ...opts, error: `unknown switch \`${c}'` };
      }
      continue;
    }
    let name = arg.slice(2);
    const eq = name.indexOf("=");
    const hasValue = eq >= 0;
    if (hasValue) name = name.slice(0, eq);
    let negated = false;
    let candidates: string[] = longs.filter((l) => l === name);
    if (candidates.length === 0 && name.startsWith("no-")) {
      candidates = longs.filter((l) => l === name.slice(3));
      negated = candidates.length > 0;
    }
    if (candidates.length === 0) {
      const all = [
        ...longs.map((l) => [l, false] as const),
        ...longs.map((l) => [l, true] as const),
      ];
      const found = all.filter(([l, neg]) => (neg ? `no-${l}` : l).startsWith(name));
      if (found.length > 1) {
        const names = found.slice(0, 2).map(([l, neg]) => `--${neg ? "no-" : ""}${l}`);
        return { ...opts, error: `ambiguous option: ${name} (could be ${names.join(" or ")})` };
      }
      if (found.length === 1) {
        candidates = [(found[0] as readonly [string, boolean])[0]];
        negated = (found[0] as readonly [string, boolean])[1];
      }
    }
    const match = candidates[0] as (typeof longs)[number] | undefined;
    if (!match) return { ...opts, error: `unknown option \`${name}'` };
    if (hasValue) return { ...opts, error: `option \`${match}' takes no value` };
    set(match, !negated);
  }
  return opts;
}

function unknownOption(arg: string): string {
  return arg.startsWith("--") ? `unknown option \`${arg.slice(2)}'` : `unknown switch \`${arg[1]}'`;
}

/** strbuf_getline over text: lines without `\n` (and a CR before it); a last unterminated one counts. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** The input lines of check-rules as bytes (strbuf_getline or strbuf_getline_nul). */
function inputLines(bytes: Uint8Array, nul: boolean): Uint8Array[] {
  const out: Uint8Array[] = [];
  const sep = nul ? 0 : 0x0a;
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== sep) continue;
    if (i === bytes.length && start === i) break;
    let end = i;
    if (!nul && end > start && bytes[end - 1] === 0x0d) end--;
    out.push(bytes.subarray(start, end));
    start = i + 1;
  }
  return out;
}

/** strcmp order of the names' bytes, duplicates dropped (string_list_sort_u). */
function sortUnique(names: string[]): string[] {
  const sorted = [...names].sort((a, b) => compareBytes(a, b));
  return sorted.filter((name, i) => i === 0 || sorted[i - 1] !== name);
}

function compareBytes(a: string, b: string): number {
  const x = encodeGitPath(a);
  const y = encodeGitPath(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  }
  return x.length - y.length;
}

const foldOf = (state: RunState) => (state.ignoreCase ? foldAsciiCase : (s: string) => s);

/** insert_recursive_pattern: the directory and each of its parents */
function insertRecursivePattern(pl: PatternList, path: string, state: RunState): void {
  const fold = foldOf(state);
  pl.recursive.push(path);
  let pattern = path;
  while (pattern.length > 0) {
    const slash = pattern.lastIndexOf("/");
    if (slash <= 0) break;
    pattern = pattern.slice(0, slash);
    const folded = fold(pattern);
    if (!pl.parent.some((p) => fold(p) === folded)) pl.parent.push(pattern);
  }
}

/** hashmap_contains_parent: whether a proper parent directory of `path` is in `set` */
function containsParent(set: string[], path: string, state: RunState): boolean {
  const fold = foldOf(state);
  const keys = new Set(set.map(fold));
  let buffer = path.startsWith("/") ? path : `/${path}`;
  for (let slash = buffer.lastIndexOf("/"); slash > 0; slash = buffer.lastIndexOf("/")) {
    buffer = buffer.slice(0, slash);
    if (keys.has(fold(buffer))) return true;
  }
  return false;
}

/** escaped_pattern: each glob character escaped */
function escapedPattern(pattern: string): string {
  return pattern.replace(/[*?[\\]/g, (c) => `\\${c}`);
}

/** write_cone_to_file */
function coneFileText(pl: PatternList, state: RunState): string {
  const fold = foldOf(state);
  const recursiveKeys = new Set(pl.recursive.map(fold));
  const parents = pl.parent.filter(
    (p) => !recursiveKeys.has(fold(p)) && !containsParent(pl.recursive, p, state),
  );
  let text = "/*\n!/*/\n";
  for (const parent of sortUnique(parents)) {
    const pattern = escapedPattern(parent);
    if (pattern.length > 0) text += `${pattern}/\n!${pattern}/*/\n`;
  }
  const recursive = pl.recursive.filter((p) => !containsParent(pl.recursive, p, state));
  for (const dir of sortUnique(recursive)) text += `${escapedPattern(dir)}/\n`;
  return text;
}

/** write_patterns_to_file */
function patternsFileText(lines: string[]): string {
  return lines.map((l) => `${l}\n`).join("");
}

/** normalize_path_copy_len (POSIX): undefined when the path climbs above its start. */
function normalizePath(src: string): string | undefined {
  let dst = "";
  let i = 0;
  if (src.startsWith("/")) {
    dst = "/";
    i = 1;
  }
  const dst0 = dst.length;
  while (src[i] === "/") i++;
  for (;;) {
    if (src[i] === ".") {
      const next = src[i + 1];
      if (next === undefined) {
        i++;
      } else if (next === "/") {
        i += 2;
        while (src[i] === "/") i++;
        continue;
      } else if (next === ".") {
        const after = src[i + 2];
        if (after === undefined || after === "/") {
          i += after === undefined ? 2 : 3;
          while (src[i] === "/") i++;
          // up one: dst ends with '/'
          let end = dst.length - 1;
          if (end <= dst0) return undefined;
          while (end > dst0 && dst[end - 1] !== "/") end--;
          dst = dst.slice(0, end);
          continue;
        }
      }
    }
    // copy up to the next '/', and eat all '/'
    let c = src[i++];
    while (c !== undefined && c !== "/") {
      dst += c;
      c = src[i++];
    }
    if (c === "/") {
      dst += "/";
      while (src[i] === "/") i++;
    } else break;
  }
  return dst;
}
