/**
 * The assignment solver of range-diff against git's linear-assignment.c: the expected
 * pairings were computed by git's own `compute_assignment` (compiled from git 2.56.1's
 * source) on matrices full of ties, where any other tie-breaking pairs differently.
 */
import { describe, expect, it } from "vitest";

import {
  computeAssignment,
  humaniseBytes,
  parseRangeDiffMaxMemory,
  RANGE_DIFF_MAX_MEMORY_DEFAULT,
} from "../src/commands/range-diff/index.js";

/** [n, the n*n cost matrix (column + n * row), git's column-to-row result] */
const GIT_PAIRINGS: [number, number[], number[]][] = [
  [
    5,
    [14, 24, 20, 3, 21, 12, 38, 4, 3, 2, 1, 0, 0, 11, 1, 5, 3, 29, 37, 3, 12, 5, 2, 3, 1],
    [2, 3, 4, 0, 1],
  ],
  [
    6,
    [
      9, 1, 22, 11, 34, 65536, 28, 32, 22, 24, 24, 4, 7, 25, 6, 33, 5, 0, 16, 16, 65536, 1, 26, 0,
      0, 2, 21, 2, 65536, 65536, 0, 9, 27, 3, 2, 1,
    ],
    [4, 0, 2, 3, 5, 1],
  ],
  [3, [0, 38, 28, 65536, 9, 5, 3, 1, 37], [0, 2, 1]],
  [
    5,
    [
      29, 2, 23, 0, 2, 65536, 11, 32, 38, 33, 30, 35, 37, 16, 0, 3, 31, 39, 15, 2, 0, 0, 2, 5,
      65536,
    ],
    [3, 1, 4, 0, 2],
  ],
  [
    6,
    [
      65536, 65536, 28, 18, 1, 29, 65536, 5, 16, 33, 2, 5, 30, 10, 38, 5, 8, 0, 33, 34, 25, 16, 16,
      3, 4, 11, 10, 31, 1, 0, 19, 18, 39, 3, 6, 65536,
    ],
    [4, 2, 1, 5, 0, 3],
  ],
  [4, [5, 9, 18, 16, 30, 7, 1, 1, 1, 0, 6, 65536, 0, 17, 1, 33], [0, 2, 3, 1]],
  [4, [17, 5, 0, 7, 36, 3, 3, 23, 0, 65536, 29, 28, 30, 20, 37, 65536], [2, 3, 1, 0]],
  [
    6,
    [
      2, 23, 0, 1, 5, 39, 5, 22, 8, 39, 30, 1, 28, 2, 18, 29, 26, 9, 34, 2, 29, 36, 5, 1, 38, 31,
      28, 0, 0, 1, 5, 27, 3, 65536, 2, 5,
    ],
    [1, 2, 0, 4, 5, 3],
  ],
  [3, [0, 2, 2, 14, 20, 15, 1, 17, 21], [2, 0, 1]],
  [
    5,
    [65536, 3, 5, 36, 38, 3, 0, 37, 0, 65536, 34, 3, 5, 20, 65536, 2, 0, 35, 2, 1, 35, 5, 6, 3, 30],
    [1, 0, 2, 4, 3],
  ],
  [
    5,
    [3, 20, 65536, 18, 2, 0, 6, 25, 6, 24, 39, 2, 1, 10, 10, 6, 5, 5, 5, 3, 65536, 22, 26, 30, 36],
    [1, 4, 2, 3, 0],
  ],
  [
    5,
    [2, 2, 1, 13, 5, 2, 21, 65536, 26, 17, 2, 0, 2, 5, 5, 0, 2, 15, 5, 2, 0, 15, 0, 26, 5],
    [1, 0, 4, 2, 3],
  ],
  [
    6,
    [
      31, 8, 3, 6, 2, 2, 1, 65536, 5, 5, 18, 9, 29, 2, 0, 20, 1, 0, 5, 3, 65536, 16, 0, 0, 1, 9, 29,
      7, 36, 0, 3, 1, 0, 1, 6, 10,
    ],
    [1, -1, 0, 5, 3, 2],
  ],
  [
    5,
    [1, 5, 3, 28, 0, 32, 2, 33, 65536, 5, 3, 16, 3, 65536, 30, 3, 1, 5, 5, 0, 13, 65536, 5, 21, 5],
    [2, 1, 4, 3, 0],
  ],
  [3, [8, 1, 35, 2, 5, 16, 5, 0, 14], [1, 0, 2]],
  [3, [8, 2, 3, 1, 5, 2, 0, 17, 30], [2, 0, 1]],
  [
    6,
    [
      21, 5, 27, 2, 0, 0, 13, 0, 65536, 29, 5, 5, 2, 3, 23, 21, 0, 65536, 12, 5, 19, 11, 17, 0, 0,
      0, 1, 0, 65536, 11, 65536, 65536, 34, 33, 38, 28,
    ],
    [4, 1, 5, 0, 2, 3],
  ],
  [
    5,
    [27, 29, 35, 18, 6, 1, 1, 3, 3, 1, 5, 16, 16, 1, 37, 19, 3, 33, 14, 65536, 6, 8, 29, 5, 3],
    [4, 3, 1, 2, 0],
  ],
  [3, [37, 3, 3, 2, 65536, 7, 17, 65536, 0], [1, 0, 2]],
  [3, [0, 7, 2, 65536, 3, 2, 14, 8, 1], [0, 1, 2]],
  [
    5,
    [3, 65536, 2, 22, 23, 5, 1, 65536, 28, 25, 4, 0, 3, 0, 26, 1, 1, 1, 1, 4, 1, 5, 0, 8, 17],
    [0, 1, 4, 2, 3],
  ],
  [3, [5, 5, 37, 36, 19, 16, 21, 13, 3], [0, 1, 2]],
  [4, [12, 5, 0, 5, 0, 33, 12, 1, 2, 2, 65536, 5, 35, 24, 25, 36], [2, 3, 0, 1]],
  [4, [18, 5, 21, 10, 14, 0, 22, 35, 37, 5, 17, 2, 3, 65536, 3, 5], [0, 1, 3, 2]],
];

describe("computeAssignment (linear-assignment.c)", () => {
  it("pairs as git does on ties", () => {
    for (const [n, cost, expected] of GIT_PAIRINGS) {
      const { columnToRow, rowToColumn } = computeAssignment(n, n, cost);
      expect([n, cost, [...columnToRow]]).toEqual([n, cost, expected]);
      // (git's early return can leave columns unassigned: -1)
      for (let j = 0; j < n; j++) {
        const row = columnToRow[j] as number;
        if (row >= 0) expect(rowToColumn[row]).toBe(j);
      }
    }
  });

  it("takes the first of equal choices: all costs equal", () => {
    // git's column reduction assigns from the last column, the augmentation the rest
    expect([...computeAssignment(3, 3, new Array(9).fill(1)).columnToRow]).toEqual([2, 1, 0]);
  });

  it("finds the cheapest pairing", () => {
    // column 0 is cheap in row 1, column 1 in row 0
    expect([...computeAssignment(2, 2, [5, 1, 1, 5]).columnToRow]).toEqual([1, 0]);
  });

  it("pairs everything with 0 below two columns, as git leaves them", () => {
    const { columnToRow, rowToColumn } = computeAssignment(1, 1, [7]);
    expect([...columnToRow, ...rowToColumn]).toEqual([0, 0]);
  });
});

describe("range-diff's --max-memory sizes", () => {
  it("parses as git_parse_unsigned and prints as humanise_bytes", () => {
    expect(parseRangeDiffMaxMemory("4g")).toBe(4n << 30n);
    expect(parseRangeDiffMaxMemory("0x10K")).toBe(16n << 10n);
    expect(parseRangeDiffMaxMemory("017")).toBe(15n);
    for (const bad of ["", "12x", "-1", "08", "1kb"])
      expect([bad, parseRangeDiffMaxMemory(bad)]).toEqual([bad, undefined]);
    expect(humaniseBytes(RANGE_DIFF_MAX_MEMORY_DEFAULT)).toBe("4.00 GiB");
    expect(humaniseBytes(1536n)).toBe("1.50 KiB");
    expect(humaniseBytes(3n << 20n)).toBe("3.00 MiB");
    expect(humaniseBytes(1n)).toBe("1 byte");
    expect(humaniseBytes(256n)).toBe("256 bytes");
  });
});
