/**
 * The reftable writer (`writeReftable`) against tables git writes, and read back by our
 * reader (`openReftable`), including the multi-block layouts: padded ref blocks, a ref
 * index of several levels, obj blocks, deflated log blocks and their index.
 */
import { describe, expect, it } from "vitest";

import {
  openReftable,
  type ReftableLogWrite,
  type ReftableRefWrite,
  suggestCompactionSegment,
  writeReftable,
} from "../../src/refs/reftable/index.js";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const id = (n: number) => n.toString(16).padStart(40, "0").replace(/^0/, "a");

describe("writeReftable", () => {
  it("writes git init's table byte for byte (HEAD -> refs/heads/main at update index 1)", () => {
    const bytes = writeReftable({
      minUpdateIndex: 1,
      maxUpdateIndex: 1,
      refs: [
        { name: "HEAD", updateIndex: 1, value: { type: "symref", target: "refs/heads/main" } },
      ],
    });
    // `git init` with a git 3.0 build (reftable by default), .git/reftable/0x...01-0x...01-*.ref
    expect(hex(bytes as Uint8Array)).toBe(
      "52454654010010000000000000000001000000000000000172000038002348454144000f" +
        "726566732f68656164732f6d61696e00001c0001" +
        "524546540100100000000000000000010000000000000001" +
        "0".repeat(80) +
        "b6bff78a",
    );
  });

  it("writes nothing for a table without records", () => {
    expect(writeReftable({ minUpdateIndex: 1, maxUpdateIndex: 1 })).toBeUndefined();
  });

  it("writes many refs and logs over several blocks that read back", () => {
    const refs: ReftableRefWrite[] = [];
    const logs: ReftableLogWrite[] = [];
    for (let i = 0; i < 3000; i++) {
      const name = `refs/heads/branch-${String(i).padStart(5, "0")}`;
      refs.push({ name, updateIndex: 5, value: { type: "id", id: id(i + 1) } });
      logs.push({
        refName: name,
        updateIndex: 5,
        update: {
          oldId: "0".repeat(40),
          newId: id(i + 1),
          name: "A U Thor",
          email: "author@example.com",
          time: 1700000000 + i,
          tzOffset: -480,
          message: `branch: Created from ${i}`,
        },
      });
    }
    refs.push({
      name: "refs/tags/v1",
      updateIndex: 4,
      value: { type: "peeled", id: id(9001), peeled: id(1) },
    });
    refs.push({ name: "refs/zzz", updateIndex: 3, value: { type: "deletion" } });
    const bytes = writeReftable({ minUpdateIndex: 3, maxUpdateIndex: 5, refs, logs }) as Uint8Array;
    const table = openReftable(bytes, "big.ref");
    expect(table.verify().blocks.ref).toBeGreaterThan(3);
    expect(table.verify().blocks.obj).toBeGreaterThan(0);
    expect(table.objectIdLength).toBeGreaterThanOrEqual(2);
    expect(table.getRef("refs/heads/branch-01234")?.value).toEqual({ type: "id", id: id(1235) });
    expect(table.getRef("refs/tags/v1")?.value).toEqual({
      type: "peeled",
      id: id(9001),
      peeled: id(1),
    });
    expect(table.getRef("refs/zzz")?.value).toEqual({ type: "deletion" });
    expect([...table.refs("refs/heads/")].length).toBe(3000);
    const log = [...table.logs("refs/heads/branch-02999")];
    expect(log.length).toBe(1);
    expect(log[0]?.update?.message).toBe("branch: Created from 2999\n");
    expect(log[0]?.update?.tzOffset).toBe(-480);
    expect([...table.logs()].length).toBe(3000);
  });

  it("refuses records outside the update index range and multi-line messages", () => {
    expect(() =>
      writeReftable({
        minUpdateIndex: 2,
        maxUpdateIndex: 2,
        refs: [{ name: "refs/heads/a", updateIndex: 1, value: { type: "id", id: id(1) } }],
      }),
    ).toThrow(/outside/);
    expect(() =>
      writeReftable({
        minUpdateIndex: 1,
        maxUpdateIndex: 1,
        logs: [
          {
            refName: "HEAD",
            updateIndex: 1,
            update: {
              oldId: id(1),
              newId: id(2),
              name: "a",
              email: "b",
              time: 0,
              tzOffset: 0,
              message: "a\nb",
            },
          },
        ],
      }),
    ).toThrow(/several lines/);
  });
});

describe("suggestCompactionSegment", () => {
  // reftable/stack.c's suggest_compaction_segment, cases of t/unit-tests/t-reftable-stack.c
  it("finds the segment that restores a geometric sequence", () => {
    expect(suggestCompactionSegment([512, 64, 17, 16, 9, 9, 9, 16, 2, 16], 2)).toEqual({
      start: 1,
      end: 10,
    });
    expect(suggestCompactionSegment([64, 32, 16, 8, 4, 2], 2)).toEqual({ start: 0, end: 0 });
    expect(suggestCompactionSegment([128, 32, 16, 8, 4, 3, 1], 2)).toMatchObject({
      start: 1,
      end: 6,
    });
  });
});
