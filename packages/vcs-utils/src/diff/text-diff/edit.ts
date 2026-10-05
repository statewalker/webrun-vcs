/**
 * Type of edit operation
 */
export enum EditType {
  /** Sequence B has inserted the region. */
  INSERT = "INSERT",

  /** Sequence B has removed the region. */
  DELETE = "DELETE",

  /** Sequence B has replaced the region with different content. */
  REPLACE = "REPLACE",

  /** Sequence A and B have zero length, describing nothing. */
  EMPTY = "EMPTY",
}

/**
 * A modified region detected between two versions of roughly the same content.
 *
 * An edit covers the modified region only. It does not cover a common region.
 *
 * Regions are specified using 0 based notation, so add 1 to the start and
 * end marks for line numbers in a file.
 *
 * An edit where beginA == endA && beginB < endB is an insert edit, that
 * is sequence B inserted the elements in region [beginB, endB) at beginA.
 *
 * An edit where beginA < endA && beginB == endB is a delete edit, that
 * is sequence B has removed the elements between [beginA, endA).
 *
 * An edit where beginA < endA && beginB < endB is a replace edit, that
 * is sequence B has replaced the range of elements between [beginA, endA)
 * with those found in [beginB, endB).
 */
export class Edit {
  /** Start of region in sequence A; 0 based. */
  beginA: number;

  /** End of region in sequence A; 0 based. */
  endA: number;

  /** Start of region in sequence B; 0 based. */
  beginB: number;

  /** End of region in sequence B; 0 based. */
  endB: number;

  /**
   * Create a new edit.
   *
   * @param beginA Start of region in sequence A; 0 based
   * @param endA End of region in sequence A; must be >= beginA
   * @param beginB Start of region in sequence B; 0 based
   * @param endB End of region in sequence B; must be >= beginB
   */
  constructor(beginA: number, endA: number, beginB: number, endB: number) {
    this.beginA = beginA;
    this.endA = endA;
    this.beginB = beginB;
    this.endB = endB;
  }

  /**
   * Get the type of this edit region.
   *
   * @returns The type of edit
   */
  getType(): EditType {
    if (this.beginA < this.endA) {
      if (this.beginB < this.endB) {
        return EditType.REPLACE;
      }
      return EditType.DELETE;
    }
    if (this.beginB < this.endB) {
      return EditType.INSERT;
    }
    return EditType.EMPTY;
  }

  /**
   * Check if the edit is empty (lengths of both a and b is zero).
   *
   * @returns true if the edit is empty
   */
  isEmpty(): boolean {
    return this.beginA === this.endA && this.beginB === this.endB;
  }

  /**
   * Get the start point in sequence A.
   *
   * @returns Start point in sequence A
   */
  getBeginA(): number {
    return this.beginA;
  }

  /**
   * Get the end point in sequence A.
   *
   * @returns End point in sequence A
   */
  getEndA(): number {
    return this.endA;
  }

  /**
   * Get the start point in sequence B.
   *
   * @returns Start point in sequence B
   */
  getBeginB(): number {
    return this.beginB;
  }

  /**
   * Get the end point in sequence B.
   *
   * @returns End point in sequence B
   */
  getEndB(): number {
    return this.endB;
  }

  /**
   * Get the length of the region in A.
   *
   * @returns Length of the region in A
   */
  getLengthA(): number {
    return this.endA - this.beginA;
  }

  /**
   * Get the length of the region in B.
   *
   * @returns Length of the region in B
   */
  getLengthB(): number {
    return this.endB - this.beginB;
  }

  /**
   * Move the edit region by the specified amount.
   *
   * @param amount The region is shifted by this amount, can be positive or negative
   */
  shift(amount: number): void {
    this.beginA += amount;
    this.endA += amount;
    this.beginB += amount;
    this.endB += amount;
  }

  /**
   * Construct a new edit representing the region before cut.
   *
   * @param cut The cut point. The beginning A and B points are used as the end points of the returned edit.
   * @returns An edit representing the slice of this edit that occurs before cut starts
   */
  before(cut: Edit): Edit {
    return new Edit(this.beginA, cut.beginA, this.beginB, cut.beginB);
  }

  /**
   * Construct a new edit representing the region after cut.
   *
   * @param cut The cut point. The ending A and B points are used as the starting points of the returned edit.
   * @returns An edit representing the slice of this edit that occurs after cut ends
   */
  after(cut: Edit): Edit {
    return new Edit(cut.endA, this.endA, cut.endB, this.endB);
  }

  /**
   * Increase endA by 1.
   */
  extendA(): void {
    this.endA++;
  }

  /**
   * Increase endB by 1.
   */
  extendB(): void {
    this.endB++;
  }

  /**
   * Swap A and B, so the edit goes the other direction.
   */
  swap(): void {
    const sBegin = this.beginA;
    const sEnd = this.endA;

    this.beginA = this.beginB;
    this.endA = this.endB;

    this.beginB = sBegin;
    this.endB = sEnd;
  }

  /**
   * Check if this edit is equal to another edit.
   *
   * @param other The other edit to compare
   * @returns true if the edits are equal
   */
  equals(other: Edit): boolean {
    return (
      this.beginA === other.beginA &&
      this.endA === other.endA &&
      this.beginB === other.beginB &&
      this.endB === other.endB
    );
  }

  /**
   * Get a string representation of this edit.
   *
   * @returns String representation
   */
  toString(): string {
    const t = this.getType();
    return `${t}(${this.beginA}-${this.endA},${this.beginB}-${this.endB})`;
  }
}

/**
 * A list of edits.
 */
export type EditList = Edit[];
