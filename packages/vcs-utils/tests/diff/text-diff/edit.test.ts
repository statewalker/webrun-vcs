import { describe, expect, it } from "vitest";
import { Edit, EditType } from "../../../src/diff/text-diff/edit.js";

describe("Edit", () => {
  it("should create an empty edit", () => {
    const edit = new Edit(0, 0, 0, 0);
    expect(edit.isEmpty()).toBe(true);
    expect(edit.getType()).toBe(EditType.EMPTY);
  });

  it("should create an insert edit", () => {
    const edit = new Edit(0, 0, 0, 2);
    expect(edit.getType()).toBe(EditType.INSERT);
    expect(edit.getLengthA()).toBe(0);
    expect(edit.getLengthB()).toBe(2);
  });

  it("should create a delete edit", () => {
    const edit = new Edit(0, 2, 0, 0);
    expect(edit.getType()).toBe(EditType.DELETE);
    expect(edit.getLengthA()).toBe(2);
    expect(edit.getLengthB()).toBe(0);
  });

  it("should create a replace edit", () => {
    const edit = new Edit(0, 2, 0, 3);
    expect(edit.getType()).toBe(EditType.REPLACE);
    expect(edit.getLengthA()).toBe(2);
    expect(edit.getLengthB()).toBe(3);
  });

  it("should shift edit correctly", () => {
    const edit = new Edit(1, 3, 2, 4);
    edit.shift(5);
    expect(edit.beginA).toBe(6);
    expect(edit.endA).toBe(8);
    expect(edit.beginB).toBe(7);
    expect(edit.endB).toBe(9);
  });

  it("should create before edit correctly", () => {
    const edit1 = new Edit(0, 10, 0, 15);
    const edit2 = new Edit(5, 10, 7, 15);
    const before = edit1.before(edit2);
    expect(before.beginA).toBe(0);
    expect(before.endA).toBe(5);
    expect(before.beginB).toBe(0);
    expect(before.endB).toBe(7);
  });

  it("should create after edit correctly", () => {
    const edit1 = new Edit(0, 10, 0, 15);
    const edit2 = new Edit(0, 5, 0, 7);
    const after = edit1.after(edit2);
    expect(after.beginA).toBe(5);
    expect(after.endA).toBe(10);
    expect(after.beginB).toBe(7);
    expect(after.endB).toBe(15);
  });

  it("should swap edit correctly", () => {
    const edit = new Edit(1, 3, 2, 5);
    edit.swap();
    expect(edit.beginA).toBe(2);
    expect(edit.endA).toBe(5);
    expect(edit.beginB).toBe(1);
    expect(edit.endB).toBe(3);
  });

  it("should test equality correctly", () => {
    const edit1 = new Edit(1, 3, 2, 4);
    const edit2 = new Edit(1, 3, 2, 4);
    const edit3 = new Edit(1, 3, 2, 5);
    expect(edit1.equals(edit2)).toBe(true);
    expect(edit1.equals(edit3)).toBe(false);
  });

  it("should format toString correctly", () => {
    const edit = new Edit(1, 3, 2, 4);
    const str = edit.toString();
    expect(str).toContain("REPLACE");
    expect(str).toContain("1-3");
    expect(str).toContain("2-4");
  });

  /**
   * JGit parity tests ported from EditTest.java
   */
  describe("JGit parity", () => {
    /**
     * JGit: testCreate
     */
    it("should create edit with all four coordinates", () => {
      const e = new Edit(1, 2, 3, 4);
      expect(e.getBeginA()).toBe(1);
      expect(e.getEndA()).toBe(2);
      expect(e.getBeginB()).toBe(3);
      expect(e.getEndB()).toBe(4);
    });

    /**
     * JGit: testType_Insert
     * Verifies insert detection and length calculations
     */
    it("should detect insert type with correct lengths", () => {
      const e = new Edit(1, 1, 1, 2);
      expect(e.getType()).toBe(EditType.INSERT);
      expect(e.isEmpty()).toBe(false);
      expect(e.getLengthA()).toBe(0);
      expect(e.getLengthB()).toBe(1);
    });

    /**
     * JGit: testType_Delete
     * Verifies delete detection and length calculations
     */
    it("should detect delete type with correct lengths", () => {
      const e = new Edit(1, 2, 1, 1);
      expect(e.getType()).toBe(EditType.DELETE);
      expect(e.isEmpty()).toBe(false);
      expect(e.getLengthA()).toBe(1);
      expect(e.getLengthB()).toBe(0);
    });

    /**
     * JGit: testType_Replace
     * Verifies replace detection and length calculations
     */
    it("should detect replace type with correct lengths", () => {
      const e = new Edit(1, 2, 1, 4);
      expect(e.getType()).toBe(EditType.REPLACE);
      expect(e.isEmpty()).toBe(false);
      expect(e.getLengthA()).toBe(1);
      expect(e.getLengthB()).toBe(3);
    });

    /**
     * JGit: testType_Empty
     * Verifies empty detection with different coordinate patterns
     */
    it("should detect empty type with zero lengths", () => {
      const e = new Edit(1, 1, 2, 2);
      expect(e.getType()).toBe(EditType.EMPTY);
      expect(e.isEmpty()).toBe(true);
      expect(e.getLengthA()).toBe(0);
      expect(e.getLengthB()).toBe(0);
    });

    /**
     * JGit: testToString
     */
    it("should format toString as TYPE(beginA-endA,beginB-endB)", () => {
      const e = new Edit(1, 2, 1, 4);
      expect(e.toString()).toBe("REPLACE(1-2,1-4)");
    });

    /**
     * JGit: testEquals1
     * Tests self-equality and equality of identical edits
     */
    it("should test equality correctly", () => {
      const e1 = new Edit(1, 2, 3, 4);
      const e2 = new Edit(1, 2, 3, 4);

      expect(e1.equals(e1)).toBe(true); // Self-equality
      expect(e1.equals(e2)).toBe(true);
      expect(e2.equals(e1)).toBe(true);
    });

    /**
     * JGit: testNotEquals1
     * Tests inequality when beginA differs
     */
    it("should detect inequality when beginA differs", () => {
      expect(new Edit(1, 2, 3, 4).equals(new Edit(0, 2, 3, 4))).toBe(false);
    });

    /**
     * JGit: testNotEquals2
     * Tests inequality when endA differs
     */
    it("should detect inequality when endA differs", () => {
      expect(new Edit(1, 2, 3, 4).equals(new Edit(1, 0, 3, 4))).toBe(false);
    });

    /**
     * JGit: testNotEquals3
     * Tests inequality when beginB differs
     */
    it("should detect inequality when beginB differs", () => {
      expect(new Edit(1, 2, 3, 4).equals(new Edit(1, 2, 0, 4))).toBe(false);
    });

    /**
     * JGit: testNotEquals4
     * Tests inequality when endB differs
     */
    it("should detect inequality when endB differs", () => {
      expect(new Edit(1, 2, 3, 4).equals(new Edit(1, 2, 3, 0))).toBe(false);
    });

    /**
     * JGit: testExtendA
     * Tests extending region A by incrementing endA
     */
    it("should extend region A correctly", () => {
      const e = new Edit(1, 2, 1, 1);

      e.extendA();
      expect(e.equals(new Edit(1, 3, 1, 1))).toBe(true);

      e.extendA();
      expect(e.equals(new Edit(1, 4, 1, 1))).toBe(true);
    });

    /**
     * JGit: testExtendB
     * Tests extending region B by incrementing endB
     */
    it("should extend region B correctly", () => {
      const e = new Edit(1, 2, 1, 1);

      e.extendB();
      expect(e.equals(new Edit(1, 2, 1, 2))).toBe(true);

      e.extendB();
      expect(e.equals(new Edit(1, 2, 1, 3))).toBe(true);
    });

    /**
     * JGit: testBeforeAfterCuts
     * Tests creating sub-regions using before() and after()
     */
    it("should create correct before and after cuts", () => {
      const whole = new Edit(1, 8, 2, 9);
      const mid = new Edit(4, 5, 3, 6);

      expect(whole.before(mid).equals(new Edit(1, 4, 2, 3))).toBe(true);
      expect(whole.after(mid).equals(new Edit(5, 8, 6, 9))).toBe(true);
    });

    /**
     * JGit: testSwap
     * Verifies swapping A and B coordinates
     */
    it("should swap A and B regions correctly", () => {
      const e = new Edit(1, 2, 3, 4);
      e.swap();
      expect(e.getBeginA()).toBe(3);
      expect(e.getEndA()).toBe(4);
      expect(e.getBeginB()).toBe(1);
      expect(e.getEndB()).toBe(2);
    });
  });
});
