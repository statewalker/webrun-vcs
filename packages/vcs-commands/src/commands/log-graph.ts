/**
 * `git log --graph`: a port of git's graph.c (2.5x), without colors. The graph is fed one
 * commit at a time, in the order `git log` shows them, and draws the lines before, at and
 * after each commit: columns of `|`, merges (`|\`, octopus `*-.`), collapsing (`/`, `_`),
 * and (git 2.5x) the indentation of a "visual root", a commit without visible parents
 * followed by an unrelated one.
 *
 * @example
 * ```typescript
 * const graph = new LogGraph({ parents: (id) => shown.get(id)!.parents, interesting });
 * graph.update(id, lookahead);
 * const first = graph.showCommit(); // the lines before the commit and its own line's graph
 * ```
 *
 * @module
 */

import type { ObjectId } from "@statewalker/vcs-core";

/** What the graph reads of the walk. */
export interface LogGraphOptions {
  /** A commit's parents as shown (rewritten when the walk rewrites them) */
  parents(id: ObjectId): readonly ObjectId[];
  /** Whether a commit will be shown (graph.c's graph_is_interesting / get_commit_action) */
  interesting(id: ObjectId): boolean;
  /** `--first-parent`: only the first parent is drawn */
  firstParentOnly?: boolean;
  /**
   * `--graph-indent` (git 2.5x's default, `log.graphIndent`): visual roots are indented;
   * false draws them as git before 2.5x does
   */
  indent?: boolean;
  /** `--graph-lane-limit=<n>`: lanes past it are truncated with `~` (default none) */
  maxLanes?: number;
}

type State =
  | "padding"
  | "skip"
  | "pre-commit"
  | "pre-root"
  | "commit"
  | "post-merge"
  | "collapsing";

interface Column {
  commit: ObjectId | undefined;
  isMergeParent: boolean;
}

interface Line {
  buf: string;
  width: number;
}

const MERGE_CHARS = ["/", "|", "\\"];

/** git's struct git_graph. */
export class LogGraph {
  private commit: ObjectId | undefined;
  private numParents = 0;
  private width = 0;
  private expansionRow = 0;
  private state: State = "padding";
  private prevState: State = "padding";
  private commitIndex = 0;
  private prevCommitIndex = 0;
  private mergeLayout = 0;
  private edgesAdded = 0;
  private prevEdgesAdded = 0;
  private numColumns = 0;
  private numNewColumns = 0;
  private mappingSize = 0;
  private columns: Column[] = [];
  private newColumns: Column[] = [];
  private mapping: number[] = [];
  private oldMapping: number[] = [];
  private lookahead: ObjectId[] = [];
  private isVisualRoot = false;
  private visualRootDepth = 0;
  private visualRootCascade = false;
  private commitInColumns = false;

  constructor(private readonly options: LogGraphOptions) {}

  private get noIndent(): boolean {
    return this.options.indent === false;
  }

  private needsTruncation(lane: number): boolean {
    const max = this.options.maxLanes ?? 0;
    return max > 0 && lane >= max;
  }

  private isInteresting(id: ObjectId): boolean {
    if (this.lookahead.includes(id)) return true;
    return this.options.interesting(id);
  }

  /** The commit's interesting parents (first_interesting_parent / next_interesting_parent) */
  private interestingParents(): ObjectId[] {
    const parents = this.commit ? this.options.parents(this.commit) : [];
    const out: ObjectId[] = [];
    for (let i = 0; i < parents.length; i++) {
      // with --first-parent, only the first parent can be interesting
      if (i > 0 && this.options.firstParentOnly) break;
      const p = parents[i] as ObjectId;
      if (this.isInteresting(p)) {
        out.push(p);
        if (this.options.firstParentOnly) break;
      }
    }
    // next_interesting_parent returns nothing after the first with --first-parent
    return out;
  }

  private findNewColumnByCommit(id: ObjectId): number {
    for (let i = 0; i < this.numNewColumns; i++) {
      if (this.newColumns[i]?.commit === id) return i;
    }
    return -1;
  }

  private col(arr: Column[], i: number): Column {
    let c = arr[i];
    if (!c) {
      c = { commit: undefined, isMergeParent: false };
      arr[i] = c;
    }
    return c;
  }

  private insertIntoNewColumns(id: ObjectId, idx: number): void {
    const initialMergeLayout = this.mergeLayout;
    let i = this.findNewColumnByCommit(id);
    let mappingIdx: number;
    if (i < 0) {
      i = this.numNewColumns++;
      const c = this.col(this.newColumns, i);
      c.commit = id;
      c.isMergeParent = false;
    }
    if (this.numParents > 1 && idx > -1 && this.mergeLayout === -1) {
      const dist = idx - i;
      const shift = dist > 1 ? 2 * dist - 3 : 1;
      this.mergeLayout = dist > 0 ? 0 : 1;
      this.edgesAdded = this.numParents + this.mergeLayout - 2;
      mappingIdx = this.width + (this.mergeLayout - 1) * shift;
      this.width += 2 * this.mergeLayout;
    } else if (this.edgesAdded > 0 && i === this.mapping[this.width - 2]) {
      mappingIdx = this.width - 2;
      this.edgesAdded = -1;
    } else {
      mappingIdx = this.width;
      this.width += 2;
    }
    this.mapping[mappingIdx] = i;
    if (this.numParents > 1 && initialMergeLayout >= 0 && idx > -1) {
      this.col(this.newColumns, i).isMergeParent = true;
    }
  }

  private updateColumns(): void {
    [this.columns, this.newColumns] = [this.newColumns, this.columns];
    this.numColumns = this.numNewColumns;
    this.numNewColumns = 0;
    const maxNewColumns = this.numColumns + this.numParents;
    this.mappingSize = 2 * maxNewColumns;
    for (let i = 0; i < this.mappingSize; i++) this.mapping[i] = -1;
    this.width = 0;
    this.prevEdgesAdded = this.edgesAdded;
    this.edgesAdded = 0;
    let seenThis = false;
    let isCommitInColumns = true;
    for (let i = 0; i <= this.numColumns; i++) {
      let colCommit: ObjectId | undefined;
      if (i === this.numColumns) {
        if (seenThis) break;
        isCommitInColumns = false;
        colCommit = this.commit;
      } else colCommit = this.columns[i]?.commit;
      if (colCommit === this.commit) {
        seenThis = true;
        this.commitIndex = i;
        this.mergeLayout = -1;
        for (const parent of this.interestingParents()) {
          this.insertIntoNewColumns(parent, i);
        }
        if (this.numParents === 0) this.width += 2;
      } else {
        this.insertIntoNewColumns(colCommit as ObjectId, -1);
        const j = this.findNewColumnByCommit(colCommit as ObjectId);
        if (j >= 0 && this.columns[i]?.isMergeParent)
          this.col(this.newColumns, j).isMergeParent = true;
      }
    }
    this.commitInColumns = isCommitInColumns;
    const maxLanes = this.options.maxLanes ?? 0;
    if (maxLanes > 0) {
      const maxWidth = maxLanes * 2 + 2;
      if (this.width > maxWidth) this.width = maxWidth;
    }
    while (this.mappingSize > 1 && (this.mapping[this.mappingSize - 1] as number) < 0) {
      this.mappingSize--;
    }
  }

  private numDashedParents(): number {
    return this.numParents + this.mergeLayout - 3;
  }

  private numExpansionRows(): number {
    return this.numDashedParents() * 2;
  }

  private needsPreCommitLine(): boolean {
    return (
      this.numParents >= 3 &&
      this.commitIndex < this.numColumns - 1 &&
      this.expansionRow < this.numExpansionRows()
    );
  }

  private isVisualRootCandidate(id: ObjectId): boolean {
    for (const p of this.options.parents(id)) if (this.isInteresting(p)) return false;
    return true;
  }

  /**
   * The next commit: `id`, with the commits shown after it that the walk has already read
   * (git's lookahead of two, for visual roots).
   */
  update(id: ObjectId, lookahead: readonly ObjectId[] = []): void {
    this.lookahead = lookahead.slice(0, 2);
    this.commit = id;
    this.numParents = this.interestingParents().length;
    this.prevCommitIndex = this.commitIndex;
    this.updateColumns();
    // graph_peek_next_visible
    let isNextVisible = false;
    let isNextVisualRoot = false;
    let nextHasColumn = false;
    const next = this.lookahead[0];
    if (next !== undefined) {
      isNextVisible = true;
      nextHasColumn = this.findNewColumnByCommit(next) >= 0;
      if (this.isVisualRootCandidate(next) && this.lookahead.length >= 2) isNextVisualRoot = true;
    }
    this.isVisualRoot =
      this.isVisualRootCandidate(id) &&
      !(this.commitInColumns && this.columns[this.commitIndex]?.isMergeParent) &&
      isNextVisible &&
      (!nextHasColumn || this.visualRootDepth > 0);
    if (this.isVisualRoot) {
      if (!this.visualRootDepth && isNextVisualRoot) this.visualRootCascade = true;
      if (!isNextVisualRoot && this.visualRootDepth && !(this.visualRootDepth % 4)) {
        this.visualRootCascade = false;
      }
      this.visualRootDepth++;
    } else {
      this.visualRootDepth = 0;
      this.visualRootCascade = false;
    }
    this.expansionRow = 0;
    if (this.state !== "padding") this.state = "skip";
    else if (this.needsPreRootLine()) this.state = "pre-root";
    else if (this.needsPreCommitLine()) this.state = "pre-commit";
    else this.state = "commit";
  }

  private needsPreRootLine(): boolean {
    return (
      this.commitInColumns &&
      this.isVisualRoot &&
      this.numColumns > 0 &&
      !this.visualRootCascade &&
      !this.noIndent
    );
  }

  private updateState(s: State): void {
    this.prevState = this.state;
    this.state = s;
  }

  private isMappingCorrect(): boolean {
    for (let i = 0; i < this.mappingSize; i++) {
      const target = this.mapping[i] as number;
      if (target < 0) continue;
      if (target === Math.floor(i / 2)) continue;
      return false;
    }
    return true;
  }

  private padHorizontally(line: Line): void {
    if (line.width < this.width) {
      line.buf += " ".repeat(this.width - line.width);
      line.width = this.width;
    }
  }

  private static add(line: Line, s: string): void {
    line.buf += s;
    line.width += s.length;
  }

  private outputPaddingLine(line: Line): void {
    for (let i = 0; i < this.numNewColumns; i++) {
      if (this.needsTruncation(i)) {
        LogGraph.add(line, "~ ");
        break;
      }
      LogGraph.add(line, "| ");
    }
  }

  /** The graph's width for this commit (graph_width) */
  getWidth(): number {
    return this.width;
  }

  private outputSkipLine(line: Line): void {
    LogGraph.add(line, "...");
    if (this.needsPreCommitLine()) this.updateState("pre-commit");
    else this.updateState("commit");
  }

  private outputPreCommitLine(line: Line): void {
    let seenThis = false;
    for (let i = 0; i < this.numColumns; i++) {
      const col = this.columns[i] as Column;
      if (col.commit === this.commit) {
        seenThis = true;
        LogGraph.add(line, "|");
        LogGraph.add(line, " ".repeat(this.expansionRow));
      } else if (seenThis && this.needsTruncation(i)) {
        LogGraph.add(line, "~ ");
        break;
      } else if (seenThis && this.expansionRow === 0) {
        if (this.prevState === "post-merge" && this.prevCommitIndex < i) LogGraph.add(line, "\\");
        else LogGraph.add(line, "|");
      } else if (seenThis && this.expansionRow > 0) {
        LogGraph.add(line, "\\");
      } else {
        LogGraph.add(line, "|");
      }
      LogGraph.add(line, " ");
    }
    this.expansionRow++;
    if (!this.needsPreCommitLine()) this.updateState("commit");
  }

  private drawOctopusMerge(line: Line): void {
    const dashed = this.numDashedParents();
    for (let i = 0; i < dashed; i++) {
      LogGraph.add(line, "-");
      if (this.needsTruncation(this.commitIndex + 1 + i)) {
        LogGraph.add(line, "~ ");
        break;
      }
      LogGraph.add(line, i === dashed - 1 ? "." : "-");
    }
  }

  private outputCommitLine(line: Line): void {
    let seenThis = false;
    for (let i = 0; i <= this.numColumns; i++) {
      const col = this.columns[i];
      let colCommit: ObjectId | undefined;
      if (i === this.numColumns) {
        if (seenThis) break;
        colCommit = this.commit;
      } else colCommit = col?.commit;
      if (colCommit === this.commit) {
        seenThis = true;
        if (this.isVisualRoot && !this.noIndent) {
          const depth = this.visualRootDepth;
          const padding = ((depth - (this.visualRootCascade ? 1 : 0)) % 4) * 2;
          LogGraph.add(line, " ".repeat(padding));
          this.width += padding;
        }
        LogGraph.add(line, "*");
        if (this.needsTruncation(i)) {
          LogGraph.add(line, " ");
          break;
        }
        if (this.numParents > 2) this.drawOctopusMerge(line);
      } else if (this.needsTruncation(i)) {
        LogGraph.add(line, "~ ");
        seenThis = true;
        break;
      } else if (seenThis && this.edgesAdded > 1) {
        LogGraph.add(line, "\\");
      } else if (seenThis && this.edgesAdded === 1) {
        if (
          this.prevState === "post-merge" &&
          this.prevEdgesAdded > 0 &&
          this.prevCommitIndex < i
        ) {
          LogGraph.add(line, "\\");
        } else LogGraph.add(line, "|");
      } else if (
        this.prevState === "collapsing" &&
        this.oldMapping[2 * i + 1] === i &&
        (this.mapping[2 * i] as number) < i
      ) {
        LogGraph.add(line, "/");
      } else {
        LogGraph.add(line, "|");
      }
      LogGraph.add(line, " ");
    }
    if (this.numParents > 1) {
      if (!this.needsTruncation(this.commitIndex)) this.updateState("post-merge");
      else {
        const p = this.interestingParents()[0] as ObjectId;
        const lane = this.findNewColumnByCommit(p);
        if (!this.needsTruncation(lane)) this.updateState("post-merge");
        else if (this.isMappingCorrect()) this.updateState("padding");
        else this.updateState("collapsing");
      }
    } else if (this.isMappingCorrect()) {
      this.updateState("padding");
    } else {
      this.updateState("collapsing");
    }
  }

  private outputPostMergeLine(line: Line): void {
    let seenThis = false;
    const parents = this.interestingParents();
    const firstParent = parents[0];
    let parentCol: Column | undefined;
    for (let i = 0; i <= this.numColumns; i++) {
      const col = this.columns[i];
      let colCommit: ObjectId | undefined;
      if (i === this.numColumns) {
        if (seenThis) break;
        colCommit = this.commit;
      } else colCommit = col?.commit;
      if (colCommit === this.commit) {
        let idx = this.mergeLayout;
        let truncated = false;
        seenThis = true;
        for (let j = 0; j < this.numParents; j++) {
          LogGraph.add(line, MERGE_CHARS[idx] as string);
          if (
            this.needsTruncation(Math.floor(j / 2) + i) &&
            Math.floor(j / 2) + i <= this.numColumns
          ) {
            if ((j + i * 2) % 2 !== 0) LogGraph.add(line, " ");
            LogGraph.add(line, "~ ");
            truncated = true;
            break;
          }
          if (idx === 2) {
            if (this.needsTruncation(Math.floor((j + 1) / 2) + i) && j < this.numParents - 1) {
              LogGraph.add(line, "~ ");
              truncated = true;
              break;
            } else if (this.edgesAdded > 0 || j < this.numParents - 1) LogGraph.add(line, " ");
          } else idx++;
        }
        if (truncated) break;
        if (this.edgesAdded === 0) LogGraph.add(line, " ");
      } else if (this.needsTruncation(i)) {
        LogGraph.add(line, "~ ");
        break;
      } else if (seenThis) {
        LogGraph.add(line, this.edgesAdded > 0 ? "\\" : "|");
        if (!this.needsTruncation(i + 1)) LogGraph.add(line, " ");
      } else {
        LogGraph.add(line, "|");
        if (this.mergeLayout !== 0 || i !== this.commitIndex - 1) {
          LogGraph.add(line, parentCol ? "_" : " ");
        }
      }
      if (colCommit === firstParent) parentCol = col;
    }
    if (this.isMappingCorrect()) this.updateState("padding");
    else this.updateState("collapsing");
  }

  private outputCollapsingLine(line: Line): void {
    let usedHorizontal = false;
    let horizontalEdge = -1;
    let horizontalEdgeTarget = -1;
    let truncated = false;
    [this.mapping, this.oldMapping] = [this.oldMapping, this.mapping];
    for (let i = 0; i < this.mappingSize; i++) this.mapping[i] = -1;
    for (let i = 0; i < this.mappingSize; i++) {
      const target = this.oldMapping[i] as number;
      if (target < 0) continue;
      if (target * 2 === i) {
        this.mapping[i] = target;
      } else if ((this.mapping[i - 1] as number) < 0) {
        this.mapping[i - 1] = target;
        if (horizontalEdge === -1) {
          horizontalEdge = i;
          horizontalEdgeTarget = target;
          for (let j = target * 2 + 3; j < i - 2; j += 2) this.mapping[j] = target;
        }
      } else if (this.mapping[i - 1] === target) {
        // joins the line to its left
      } else {
        this.mapping[i - 2] = target;
        if (horizontalEdge === -1) {
          horizontalEdgeTarget = target;
          horizontalEdge = i - 1;
          for (let j = target * 2 + 3; j < i - 2; j += 2) this.mapping[j] = target;
        }
      }
    }
    for (let i = 0; i < this.mappingSize; i++) this.oldMapping[i] = this.mapping[i] as number;
    if ((this.mapping[this.mappingSize - 1] as number) < 0) this.mappingSize--;
    for (let i = 0; i < this.mappingSize; i++) {
      const target = this.mapping[i] as number;
      if (!truncated && this.needsTruncation(Math.floor(i / 2))) {
        LogGraph.add(line, "~ ");
        truncated = true;
      }
      if (target < 0) {
        if (!truncated) LogGraph.add(line, " ");
      } else if (target * 2 === i) {
        if (!truncated) LogGraph.add(line, "|");
      } else if (target === horizontalEdgeTarget && i !== horizontalEdge - 1) {
        if (i !== target * 2 + 3) this.mapping[i] = -1;
        usedHorizontal = true;
        if (!truncated) LogGraph.add(line, "_");
      } else {
        if (usedHorizontal && i < horizontalEdge) this.mapping[i] = -1;
        if (!truncated) LogGraph.add(line, "/");
      }
    }
    if (this.isMappingCorrect()) this.updateState("padding");
  }

  private outputPreRootLine(line: Line): void {
    for (let i = 0; i < this.numColumns; i++) {
      const col = this.columns[i] as Column;
      if (col.commit === this.commit) {
        LogGraph.add(line, " ");
        LogGraph.add(line, "\\");
      } else LogGraph.add(line, "|");
      LogGraph.add(line, " ");
    }
    this.updateState("commit");
  }

  /** graph_next_line: the next line, and whether it was the commit's line. */
  nextLine(): { text: string; commitLine: boolean } {
    const line: Line = { buf: "", width: 0 };
    if (this.commit === undefined) return { text: "", commitLine: false };
    let commitLine = false;
    switch (this.state) {
      case "padding":
        this.outputPaddingLine(line);
        break;
      case "skip":
        this.outputSkipLine(line);
        break;
      case "pre-commit":
        this.outputPreCommitLine(line);
        break;
      case "pre-root":
        this.outputPreRootLine(line);
        break;
      case "commit":
        this.outputCommitLine(line);
        commitLine = true;
        break;
      case "post-merge":
        this.outputPostMergeLine(line);
        break;
      case "collapsing":
        this.outputCollapsingLine(line);
        break;
    }
    this.padHorizontally(line);
    return { text: line.buf, commitLine };
  }

  /** graph_padding_line: a line that keeps every branch line as it is. */
  paddingLine(): string {
    if (this.state !== "commit") return this.nextLine().text;
    const line: Line = { buf: "", width: 0 };
    for (let i = 0; i < this.numColumns; i++) {
      const col = this.columns[i] as Column;
      if (this.needsTruncation(i)) {
        LogGraph.add(line, "~ ");
        break;
      }
      LogGraph.add(line, "|");
      if (col.commit === this.commit && this.numParents > 2) {
        LogGraph.add(line, " ".repeat((this.numParents - 2) * 2));
      } else LogGraph.add(line, " ");
    }
    this.padHorizontally(line);
    this.prevState = "padding";
    return line.buf;
  }

  /** graph_is_commit_finished */
  isCommitFinished(): boolean {
    return this.state === "padding";
  }

  /**
   * graph_show_commit: the lines up to the commit's line, each but the last ending in a
   * newline; the last is the commit's line's graph, to be followed by the commit.
   */
  showCommit(): string {
    let out = "";
    if (this.isCommitFinished()) return this.paddingLine();
    let shown = false;
    while (!shown && !this.isCommitFinished()) {
      const next = this.nextLine();
      shown = next.commitLine;
      out += next.text;
      if (!shown) out += "\n";
    }
    return out;
  }

  /** graph_show_oneline: the next line's graph, without a newline */
  showOneline(): string {
    return this.nextLine().text;
  }

  /** graph_show_padding */
  showPadding(): string {
    return this.paddingLine();
  }

  /** graph_show_remainder: the lines left of the commit, joined by newlines (no last one) */
  showRemainder(): string {
    if (this.isCommitFinished()) return "";
    let out = "";
    for (;;) {
      out += this.nextLine().text;
      if (!this.isCommitFinished()) out += "\n";
      else break;
    }
    return out;
  }

  /**
   * graph_show_commit_msg: `msg` with the graph before each line but the first, then the
   * rest of the commit's graph lines.
   */
  showCommitMessage(msg: string): string {
    let out = "";
    let p = 0;
    while (p < msg.length || (p === 0 && msg.length === 0)) {
      const nl = msg.indexOf("\n", p);
      const next = nl < 0 ? -1 : nl + 1;
      out += msg.slice(p, next < 0 ? msg.length : next);
      if (next >= 0 && next < msg.length) out += this.showOneline();
      if (next < 0) break;
      p = next;
    }
    const terminated = msg.endsWith("\n");
    if (!this.isCommitFinished()) {
      if (!terminated) out += "\n";
      out += this.showRemainder();
      if (terminated) out += "\n";
    }
    return out;
  }
}
