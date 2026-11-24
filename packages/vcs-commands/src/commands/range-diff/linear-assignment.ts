/**
 * git's linear-assignment.c: the Jonker-Volgenant shortest augmenting path solver of the
 * linear assignment problem (Jonker, R., & Volgenant, A. (1987). A shortest augmenting path
 * algorithm for dense and sparse linear assignment problems. Computing, 38(4), 325-340),
 * step for step as git runs it, so that ties end in git's pairing.
 *
 * @example
 * ```typescript
 * // two columns, two rows: column 0 costs 1 in row 0 and 2 in row 1
 * const { columnToRow } = computeAssignment(2, 2, [1, 5, 2, 1]);
 * // columnToRow: [0, 1]
 * ```
 */

/** git's `INT_MAX` */
const INT_MAX = 2147483647;

/** The pairing found: the row of each column and the column of each row. */
export interface Assignment {
  columnToRow: Int32Array;
  rowToColumn: Int32Array;
}

/**
 * `compute_assignment`: the assignment of columns to rows of least total cost. `cost` is the
 * cost matrix, the cost of assigning column `j` to row `i` at `cost[j + columnCount * i]`.
 * With fewer than two columns every column and row is paired with 0, as git leaves them.
 *
 * @throws Error where git hits its `BUG("negative j")`
 */
export function computeAssignment(
  columnCount: number,
  rowCount: number,
  cost: ArrayLike<number>,
): Assignment {
  const column2row = new Int32Array(columnCount);
  const row2column = new Int32Array(rowCount);
  if (columnCount < 2) return { columnToRow: column2row, rowToColumn: row2column };
  const COST = (column: number, row: number) => cost[column + columnCount * row] as number;

  column2row.fill(-1);
  row2column.fill(-1);
  const v = new Int32Array(columnCount);

  // column reduction
  for (let j = columnCount - 1; j >= 0; j--) {
    let i1 = 0;
    for (let i = 1; i < rowCount; i++) if (COST(j, i1) > COST(j, i)) i1 = i;
    v[j] = COST(j, i1);
    if (row2column[i1] === -1) {
      // row i1 unassigned
      row2column[i1] = j;
      column2row[j] = i1;
    } else {
      if ((row2column[i1] as number) >= 0) row2column[i1] = -2 - (row2column[i1] as number);
      column2row[j] = -1;
    }
  }

  // reduction transfer
  const freeRow = new Int32Array(rowCount);
  let freeCount = 0;
  for (let i = 0; i < rowCount; i++) {
    const j1 = row2column[i] as number;
    if (j1 === -1) freeRow[freeCount++] = i;
    else if (j1 < -1) row2column[i] = -2 - j1;
    else {
      const other = j1 === 0 ? 1 : 0;
      let min = COST(other, i) - (v[other] as number);
      for (let j = 1; j < columnCount; j++)
        if (j !== j1 && min > COST(j, i) - (v[j] as number)) min = COST(j, i) - (v[j] as number);
      v[j1] = (v[j1] as number) - min;
    }
  }

  if (freeCount === (columnCount < rowCount ? rowCount - columnCount : 0)) {
    return { columnToRow: column2row, rowToColumn: row2column };
  }

  // augmenting row reduction
  for (let phase = 0; phase < 2; phase++) {
    let k = 0;
    const savedFreeCount = freeCount;
    freeCount = 0;
    while (k < savedFreeCount) {
      let j1 = 0;
      const i = freeRow[k++] as number;
      let u1 = COST(j1, i) - (v[j1] as number);
      let j2 = -1;
      let u2 = INT_MAX;
      for (let j = 1; j < columnCount; j++) {
        const c = COST(j, i) - (v[j] as number);
        if (u2 > c) {
          if (u1 < c) {
            u2 = c;
            j2 = j;
          } else {
            u2 = u1;
            u1 = c;
            j2 = j1;
            j1 = j;
          }
        }
      }
      if (j2 < 0) {
        j2 = j1;
        u2 = u1;
      }

      let i0 = column2row[j1] as number;
      if (u1 < u2) v[j1] = (v[j1] as number) - (u2 - u1);
      else if (i0 >= 0) {
        j1 = j2;
        i0 = column2row[j1] as number;
      }

      if (i0 >= 0) {
        if (u1 < u2) freeRow[--k] = i0;
        else freeRow[freeCount++] = i0;
      }
      row2column[i] = j1;
      column2row[j1] = i;
    }
  }

  // augmentation
  const savedFreeCount = freeCount;
  const d = new Int32Array(columnCount);
  const pred = new Int32Array(columnCount);
  const col = new Int32Array(columnCount);
  for (freeCount = 0; freeCount < savedFreeCount; freeCount++) {
    const i1 = freeRow[freeCount] as number;
    let low = 0;
    let up = 0;
    let last = 0;
    let min = 0;
    let i = 0;

    for (let j = 0; j < columnCount; j++) {
      d[j] = COST(j, i1) - (v[j] as number);
      pred[j] = i1;
      col[j] = j;
    }

    let j = -1;
    update: do {
      last = low;
      min = d[col[up++] as number] as number;
      for (let k = up; k < columnCount; k++) {
        j = col[k] as number;
        const c = d[j] as number;
        if (c <= min) {
          if (c < min) {
            up = low;
            min = c;
          }
          col[k] = col[up] as number;
          col[up++] = j;
        }
      }
      // (git leaves j at the last column scanned when it finds a free one here)
      for (let k = low; k < up; k++) if (column2row[col[k] as number] === -1) break update;

      // scan a row
      do {
        const j1 = col[low++] as number;
        i = column2row[j1] as number;
        const u1 = COST(j1, i) - (v[j1] as number) - min;
        for (let k = up; k < columnCount; k++) {
          j = col[k] as number;
          const c = COST(j, i) - (v[j] as number) - u1;
          if (c < (d[j] as number)) {
            d[j] = c;
            pred[j] = i;
            if (c === min) {
              if (column2row[j] === -1) break update;
              col[k] = col[up] as number;
              col[up++] = j;
            }
          }
        }
      } while (low !== up);
    } while (low === up);

    // updating of the column pieces
    for (let k = 0; k < last; k++) {
      const j1 = col[k] as number;
      v[j1] = (v[j1] as number) + (d[j1] as number) - min;
    }

    // augmentation
    do {
      if (j < 0) throw new Error(`BUG: negative j: ${j}`);
      i = pred[j] as number;
      column2row[j] = i;
      const swap = row2column[i] as number;
      row2column[i] = j;
      j = swap;
    } while (i1 !== i);
  }

  return { columnToRow: column2row, rowToColumn: row2column };
}
