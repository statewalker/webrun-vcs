import { Edit, type EditList } from "./edit.js";
import {
  type HashedSequence,
  type HashedSequenceComparator,
  HashedSequencePair,
} from "./hashed-sequence.js";
import type { Sequence, SequenceComparator } from "./sequence.js";

/**
 * Diff algorithm based on "An O(ND) Difference Algorithm and its Variations"
 * by Eugene W. Myers.
 *
 * This implementation follows JGit's bidirectional search approach for O(N) space complexity.
 *
 * The basic idea is to put the line numbers of text A as columns ("x") and the
 * lines of text B as rows ("y"). Now you try to find the shortest "edit path"
 * from the upper left corner to the lower right corner, where you can always go
 * horizontally or vertically, but diagonally from (x,y) to (x+1,y+1) only if
 * line x in text A is identical to line y in text B.
 *
 * Myers' fundamental concept is the "furthest reaching D-path on diagonal k": a
 * D-path is an edit path starting at the upper left corner and containing
 * exactly D non-diagonal elements ("differences"). The furthest reaching D-path
 * on diagonal k is the one that contains the most (diagonal) elements which
 * ends on diagonal k (where k = y - x).
 *
 * @template S The sequence type
 */
export class MyersDiff<S extends Sequence> {
  /**
   * Compute the differences between two sequences.
   *
   * @param cmp The comparator for sequence elements
   * @param a The first sequence (old)
   * @param b The second sequence (new)
   * @returns List of edits
   */
  static diff<S extends Sequence>(cmp: SequenceComparator<S>, a: S, b: S): EditList {
    const pair = new HashedSequencePair(cmp, a, b);
    const hc = pair.getComparator();
    const ha = pair.getA();
    const hb = pair.getB();

    const edits: EditList = [];
    const region = new Edit(0, a.size(), 0, b.size());

    new MyersDiff(edits, hc, ha, hb, region);

    // Normalize edits to shift them to consistent locations
    return MyersDiff.normalize(cmp, edits, a, b);
  }

  /**
   * Normalize an EditList to shift {@link Edit.Type#INSERT} and
   * {@link Edit.Type#DELETE} edits that can be "shifted". For example, an inserted section
   * can be shifted forward if the same content appears later.
   *
   * To avoid later merge issues, we shift such edits to a consistent location.
   * This implementation uses a simple strategy of shifting such edits to their
   * latest possible location.
   *
   * @param cmp The comparator supplying the element equivalence function
   * @param e A modifiable edit list comparing the provided sequences
   * @param a The first (old) sequence
   * @param b The second (new) sequence
   * @returns A modifiable edit list with edit regions shifted to their latest possible location
   */
  private static normalize<S extends Sequence>(
    cmp: SequenceComparator<S>,
    e: EditList,
    a: S,
    b: S,
  ): EditList {
    let prev: Edit | null = null;
    for (let i = e.length - 1; i >= 0; i--) {
      const cur = e[i];
      const curType = cur.getType();

      const maxA = prev === null ? a.size() : prev.beginA;
      const maxB = prev === null ? b.size() : prev.beginB;

      if (curType === "INSERT") {
        // Shift INSERT edits forward as much as possible
        while (cur.endA < maxA && cur.endB < maxB && cmp.equals(b, cur.beginB, b, cur.endB)) {
          cur.shift(1);
        }
      } else if (curType === "DELETE") {
        // Shift DELETE edits forward as much as possible
        while (cur.endA < maxA && cur.endB < maxB && cmp.equals(a, cur.beginA, a, cur.endA)) {
          cur.shift(1);
        }
      }
      prev = cur;
    }
    return e;
  }

  /** The list of edits found */
  protected edits: EditList;

  /** Comparison function for sequences */
  protected cmp: HashedSequenceComparator<S>;

  /** The first text to be compared (Text A) */
  protected a: HashedSequence<S>;

  /** The second text to be compared (Text B) */
  protected b: HashedSequence<S>;

  /** Helper for bidirectional search */
  private middle: MiddleEdit<S>;

  /**
   * Create a new MyersDiff instance and compute the diff.
   *
   * @param edits The list to append edits to
   * @param cmp The comparator
   * @param a Sequence A
   * @param b Sequence B
   * @param region The region to compare
   */
  private constructor(
    edits: EditList,
    cmp: HashedSequenceComparator<S>,
    a: HashedSequence<S>,
    b: HashedSequence<S>,
    region: Edit,
  ) {
    this.edits = edits;
    this.cmp = cmp;
    this.a = a;
    this.b = b;
    this.middle = new MiddleEdit(cmp, a, b);
    this.calculateEdits(region);
  }

  /**
   * Entrypoint into the algorithm. Triggers calculation of differences.
   *
   * @param r Portion of the sequences to examine
   */
  private calculateEdits(r: Edit): void {
    this.middle.initialize(r.beginA, r.endA, r.beginB, r.endB);
    if (this.middle.beginA >= this.middle.endA && this.middle.beginB >= this.middle.endB) {
      return;
    }

    this.calculateEditsInternal(
      this.middle.beginA,
      this.middle.endA,
      this.middle.beginB,
      this.middle.endB,
    );
  }

  /**
   * Calculates the differences between a given part of A against another given part of B.
   *
   * @param beginA Start of the part of A which should be compared
   * @param endA End of the part of A which should be compared
   * @param beginB Start of the part of B which should be compared
   * @param endB End of the part of B which should be compared
   */
  protected calculateEditsInternal(
    beginA: number,
    endA: number,
    beginB: number,
    endB: number,
  ): void {
    const edit = this.middle.calculate(beginA, endA, beginB, endB);

    // Recursively process before middle
    if (beginA < edit.beginA || beginB < edit.beginB) {
      const k = edit.beginB - edit.beginA;
      const x = this.middle.backward.followSnake(k, edit.beginA);
      this.calculateEditsInternal(beginA, x, beginB, k + x);
    }

    // Add the middle edit if it's not empty
    if (edit.getType() !== "EMPTY") {
      this.edits.push(edit);
    }

    // Recursively process after middle
    if (endA > edit.endA || endB > edit.endB) {
      const k = edit.endB - edit.endA;
      const x = this.middle.forward.followSnake(k, edit.endA);
      this.calculateEditsInternal(x, endA, k + x, endB);
    }
  }
}

/**
 * A class to help bisecting the sequences a and b to find minimal edit paths.
 *
 * The entry function is the calculate() method.
 */
class MiddleEdit<S extends Sequence> {
  beginA = 0;
  endA = 0;
  beginB = 0;
  endB = 0;
  edit: Edit | null = null;

  forward: ForwardEditPaths<S>;
  backward: BackwardEditPaths<S>;

  constructor(cmp: HashedSequenceComparator<S>, a: HashedSequence<S>, b: HashedSequence<S>) {
    this.forward = new ForwardEditPaths(this, cmp, a, b);
    this.backward = new BackwardEditPaths(this, cmp, a, b);
  }

  /**
   * Initialize and strip common parts on either end.
   */
  initialize(beginA: number, endA: number, beginB: number, endB: number): void {
    this.beginA = beginA;
    this.endA = endA;
    this.beginB = beginB;
    this.endB = endB;

    // Strip common prefix
    let k = beginB - beginA;
    this.beginA = this.forward.followSnake(k, beginA);
    this.beginB = k + this.beginA;

    // Strip common suffix
    k = endB - endA;
    this.endA = this.backward.followSnake(k, endA);
    this.endB = k + this.endA;
  }

  /**
   * Calculate the "middle" Edit of the shortest edit path.
   *
   * Once a forward path and a backward path meet, we found the middle part.
   */
  calculate(beginA: number, endA: number, beginB: number, endB: number): Edit {
    if (beginA === endA || beginB === endB) {
      return new Edit(beginA, endA, beginB, endB);
    }

    this.beginA = beginA;
    this.endA = endA;
    this.beginB = beginB;
    this.endB = endB;

    const minK = beginB - endA;
    const maxK = endB - beginA;

    this.forward.initialize(beginB - beginA, beginA, minK, maxK);
    this.backward.initialize(endB - endA, endA, minK, maxK);

    for (let d = 1; ; d++) {
      if (this.forward.calculate(d) || this.backward.calculate(d)) {
        if (!this.edit) {
          throw new Error("Edit should be set when calculate returns true");
        }
        return this.edit;
      }
    }
  }
}

/**
 * Base class for edit paths.
 */
abstract class EditPaths<S extends Sequence> {
  protected x: number[] = [];
  protected snakeEndpoints: bigint[] = [];
  beginK = 0;
  endK = 0;
  middleK = 0;
  protected prevBeginK = 0;
  protected prevEndK = 0;
  protected minK = 0;
  protected maxK = 0;

  constructor(
    protected middle: MiddleEdit<S>,
    protected cmp: HashedSequenceComparator<S>,
    protected a: HashedSequence<S>,
    protected b: HashedSequence<S>,
  ) {}

  protected getIndex(d: number, k: number): number {
    return (d + k - this.middleK) / 2;
  }

  getX(d: number, k: number): number {
    return this.x[this.getIndex(d, k)];
  }

  getSnake(d: number, k: number): bigint {
    return this.snakeEndpoints[this.getIndex(d, k)];
  }

  protected forceKIntoRange(k: number): number {
    // If k is odd, so must be the result
    if (k < this.minK) {
      return this.minK + ((k ^ this.minK) & 1);
    }
    if (k > this.maxK) {
      return this.maxK - ((k ^ this.maxK) & 1);
    }
    return k;
  }

  initialize(k: number, x: number, minK: number, maxK: number): void {
    this.minK = minK;
    this.maxK = maxK;
    this.beginK = this.endK = this.middleK = k;
    this.x = [x];
    this.snakeEndpoints = [this.newSnake(k, x)];
  }

  protected newSnake(k: number, x: number): bigint {
    const y = BigInt(k + x);
    return (BigInt(x) << 32n) | y;
  }

  protected snake2x(snake: bigint): number {
    return Number(snake >> 32n);
  }

  protected snake2y(snake: bigint): number {
    return Number(snake & 0xffffffffn);
  }

  protected makeEdit(snake1: bigint, snake2: bigint): boolean {
    const x1 = this.snake2x(snake1);
    const x2 = this.snake2x(snake2);
    const y1 = this.snake2y(snake1);
    const y2 = this.snake2y(snake2);

    // Check for incompatible partial edit paths
    const finalX1 = x1 > x2 || y1 > y2 ? x2 : x1;
    const finalY1 = x1 > x2 || y1 > y2 ? y2 : y1;

    this.middle.edit = new Edit(finalX1, x2, finalY1, y2);
    return true;
  }

  calculate(d: number): boolean {
    this.prevBeginK = this.beginK;
    this.prevEndK = this.endK;
    this.beginK = this.forceKIntoRange(this.middleK - d);
    this.endK = this.forceKIntoRange(this.middleK + d);

    // Go backwards to avoid temp vars
    for (let k = this.endK; k >= this.beginK; k -= 2) {
      let left = -1;
      let right = -1;
      let leftSnake = -1n;
      let rightSnake = -1n;

      // Calculate from k-1 diagonal (left)
      if (k > this.prevBeginK) {
        const i = this.getIndex(d - 1, k - 1);
        left = this.x[i];
        const end = this.followSnake(k - 1, left);
        leftSnake = left !== end ? this.newSnake(k - 1, end) : this.snakeEndpoints[i];
        if (this.meets(d, k - 1, end, leftSnake)) {
          return true;
        }
        left = this.getLeft(end);
      }

      // Calculate from k+1 diagonal (right)
      if (k < this.prevEndK) {
        const i = this.getIndex(d - 1, k + 1);
        right = this.x[i];
        const end = this.followSnake(k + 1, right);
        rightSnake = right !== end ? this.newSnake(k + 1, end) : this.snakeEndpoints[i];
        if (this.meets(d, k + 1, end, rightSnake)) {
          return true;
        }
        right = this.getRight(end);
      }

      // Choose the better path
      let newX: number;
      let newSnake: bigint;
      if (k >= this.prevEndK || (k > this.prevBeginK && this.isBetter(left, right))) {
        newX = left;
        newSnake = leftSnake;
      } else {
        newX = right;
        newSnake = rightSnake;
      }

      if (this.meets(d, k, newX, newSnake)) {
        return true;
      }

      this.adjustMinMaxK(k, newX);
      const i = this.getIndex(d, k);
      this.x[i] = newX;
      this.snakeEndpoints[i] = newSnake;
    }

    return false;
  }

  abstract followSnake(k: number, x: number): number;
  abstract getLeft(x: number): number;
  abstract getRight(x: number): number;
  abstract isBetter(left: number, right: number): boolean;
  abstract adjustMinMaxK(k: number, x: number): void;
  abstract meets(d: number, k: number, x: number, snake: bigint): boolean;
}

/**
 * Forward edit paths (from top-left to bottom-right).
 */
class ForwardEditPaths<S extends Sequence> extends EditPaths<S> {
  override followSnake(k: number, x: number): number {
    let pos = x;
    while (
      pos < this.middle.endA &&
      k + pos < this.middle.endB &&
      this.cmp.equals(this.a, pos, this.b, k + pos)
    ) {
      pos++;
    }
    return pos;
  }

  override getLeft(x: number): number {
    return x;
  }

  override getRight(x: number): number {
    return x + 1;
  }

  override isBetter(left: number, right: number): boolean {
    return left > right;
  }

  override adjustMinMaxK(k: number, x: number): void {
    if (x >= this.middle.endA || k + x >= this.middle.endB) {
      if (k > this.middle.backward.middleK) {
        this.maxK = k;
      } else {
        this.minK = k;
      }
    }
  }

  override meets(d: number, k: number, x: number, snake: bigint): boolean {
    if (k < this.middle.backward.beginK || k > this.middle.backward.endK) {
      return false;
    }
    if ((d - 1 + k - this.middle.backward.middleK) % 2 !== 0) {
      return false;
    }
    if (x < this.middle.backward.getX(d - 1, k)) {
      return false;
    }
    return this.makeEdit(snake, this.middle.backward.getSnake(d - 1, k));
  }
}

/**
 * Backward edit paths (from bottom-right to top-left).
 */
class BackwardEditPaths<S extends Sequence> extends EditPaths<S> {
  override followSnake(k: number, x: number): number {
    let pos = x;
    while (
      pos > this.middle.beginA &&
      k + pos > this.middle.beginB &&
      this.cmp.equals(this.a, pos - 1, this.b, k + pos - 1)
    ) {
      pos--;
    }
    return pos;
  }

  override getLeft(x: number): number {
    return x - 1;
  }

  override getRight(x: number): number {
    return x;
  }

  override isBetter(left: number, right: number): boolean {
    return left < right;
  }

  override adjustMinMaxK(k: number, x: number): void {
    if (x <= this.middle.beginA || k + x <= this.middle.beginB) {
      if (k > this.middle.forward.middleK) {
        this.maxK = k;
      } else {
        this.minK = k;
      }
    }
  }

  override meets(d: number, k: number, x: number, snake: bigint): boolean {
    if (k < this.middle.forward.beginK || k > this.middle.forward.endK) {
      return false;
    }
    if ((d + k - this.middle.forward.middleK) % 2 !== 0) {
      return false;
    }
    if (x > this.middle.forward.getX(d, k)) {
      return false;
    }
    return this.makeEdit(this.middle.forward.getSnake(d, k), snake);
  }
}
