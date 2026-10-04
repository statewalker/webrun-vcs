/**
 * Tests for conflict detection and resolution utilities
 */

import type { ObjectId } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import {
  type ConflictInfo,
  ConflictType,
  countConflictMarkers,
  generateConflictMarkers,
  getResolutionObjectId,
  hasConflictMarkers,
  parseConflictMarkers,
  ResolutionStrategy,
  resolveMarkersByStrategy,
  strategyToStage,
} from "../../src/staging/conflict-utils.js";
import { MergeStage, type StagingEntry } from "../../src/staging/types.js";

const sampleObjectId = "0".repeat(40) as ObjectId;
const anotherObjectId = "a".repeat(40) as ObjectId;
const thirdObjectId = "b".repeat(40) as ObjectId;

/**
 * Create a test staging entry
 */
function createEntry(
  path: string,
  options: {
    objectId?: ObjectId;
    stage?: number;
    mode?: number;
  } = {},
): StagingEntry {
  return {
    path,
    objectId: options.objectId ?? sampleObjectId,
    mode: options.mode ?? FileMode.REGULAR_FILE,
    stage: (options.stage ?? MergeStage.MERGED) as 0 | 1 | 2 | 3,
    size: 100,
    mtime: Date.now(),
  };
}

describe("conflict-utils", () => {
  describe("strategyToStage", () => {
    it("maps OURS to stage 2", () => {
      expect(strategyToStage(ResolutionStrategy.OURS)).toBe(MergeStage.OURS);
    });

    it("maps THEIRS to stage 3", () => {
      expect(strategyToStage(ResolutionStrategy.THEIRS)).toBe(MergeStage.THEIRS);
    });

    it("maps BASE to stage 1", () => {
      expect(strategyToStage(ResolutionStrategy.BASE)).toBe(MergeStage.BASE);
    });

    it("maps DELETE to undefined", () => {
      expect(strategyToStage(ResolutionStrategy.DELETE)).toBeUndefined();
    });
  });

  describe("getResolutionObjectId", () => {
    it("returns ours objectId for OURS strategy", () => {
      const conflict: ConflictInfo = {
        path: "file.txt",
        base: createEntry("file.txt", { objectId: sampleObjectId, stage: MergeStage.BASE }),
        ours: createEntry("file.txt", { objectId: anotherObjectId, stage: MergeStage.OURS }),
        theirs: createEntry("file.txt", { objectId: thirdObjectId, stage: MergeStage.THEIRS }),
        type: ConflictType.BOTH_MODIFIED,
      };

      expect(getResolutionObjectId(conflict, ResolutionStrategy.OURS)).toBe(anotherObjectId);
    });

    it("returns theirs objectId for THEIRS strategy", () => {
      const conflict: ConflictInfo = {
        path: "file.txt",
        ours: createEntry("file.txt", { objectId: anotherObjectId, stage: MergeStage.OURS }),
        theirs: createEntry("file.txt", { objectId: thirdObjectId, stage: MergeStage.THEIRS }),
        type: ConflictType.BOTH_ADDED,
      };

      expect(getResolutionObjectId(conflict, ResolutionStrategy.THEIRS)).toBe(thirdObjectId);
    });

    it("returns base objectId for BASE strategy", () => {
      const conflict: ConflictInfo = {
        path: "file.txt",
        base: createEntry("file.txt", { objectId: sampleObjectId, stage: MergeStage.BASE }),
        ours: createEntry("file.txt", { objectId: anotherObjectId, stage: MergeStage.OURS }),
        type: ConflictType.MODIFY_DELETE,
      };

      expect(getResolutionObjectId(conflict, ResolutionStrategy.BASE)).toBe(sampleObjectId);
    });

    it("returns undefined for DELETE strategy", () => {
      const conflict: ConflictInfo = {
        path: "file.txt",
        ours: createEntry("file.txt", { objectId: anotherObjectId, stage: MergeStage.OURS }),
        theirs: createEntry("file.txt", { objectId: thirdObjectId, stage: MergeStage.THEIRS }),
        type: ConflictType.BOTH_ADDED,
      };

      expect(getResolutionObjectId(conflict, ResolutionStrategy.DELETE)).toBeUndefined();
    });

    it("returns undefined when requested version doesn't exist", () => {
      const conflict: ConflictInfo = {
        path: "file.txt",
        ours: createEntry("file.txt", { objectId: anotherObjectId, stage: MergeStage.OURS }),
        type: ConflictType.MODIFY_DELETE,
      };

      expect(getResolutionObjectId(conflict, ResolutionStrategy.BASE)).toBeUndefined();
      expect(getResolutionObjectId(conflict, ResolutionStrategy.THEIRS)).toBeUndefined();
    });
  });

  describe("generateConflictMarkers", () => {
    it("generates standard conflict markers", () => {
      const oursContent = ["line 1 ours", "line 2 ours"];
      const theirsContent = ["line 1 theirs", "line 2 theirs"];

      const result = generateConflictMarkers(oursContent, theirsContent);

      expect(result).toContain("<<<<<<< HEAD");
      expect(result).toContain("line 1 ours");
      expect(result).toContain("line 2 ours");
      expect(result).toContain("=======");
      expect(result).toContain("line 1 theirs");
      expect(result).toContain("line 2 theirs");
      expect(result).toContain(">>>>>>> merged");
    });

    it("uses custom labels", () => {
      const oursContent = ["our change"];
      const theirsContent = ["their change"];

      const result = generateConflictMarkers(oursContent, theirsContent, undefined, {
        oursLabel: "main",
        theirsLabel: "feature-branch",
      });

      expect(result).toContain("<<<<<<< main");
      expect(result).toContain(">>>>>>> feature-branch");
    });

    it("includes base section when requested", () => {
      const oursContent = ["our change"];
      const theirsContent = ["their change"];
      const baseContent = ["original"];

      const result = generateConflictMarkers(oursContent, theirsContent, baseContent, {
        includeBase: true,
      });

      expect(result).toContain("<<<<<<< HEAD");
      expect(result).toContain("our change");
      expect(result).toContain("||||||| base");
      expect(result).toContain("original");
      expect(result).toContain("=======");
      expect(result).toContain("their change");
      expect(result).toContain(">>>>>>> merged");
    });

    it("handles empty content", () => {
      const oursContent: string[] = [];
      const theirsContent = ["their content"];

      const result = generateConflictMarkers(oursContent, theirsContent);

      expect(result).toContain("<<<<<<< HEAD");
      expect(result).toContain("=======");
      expect(result).toContain("their content");
      expect(result).toContain(">>>>>>> merged");
    });
  });

  describe("hasConflictMarkers", () => {
    it("returns true for content with conflict markers", () => {
      const content = `normal line
<<<<<<< HEAD
our change
=======
their change
>>>>>>> merged
another line`;

      expect(hasConflictMarkers(content)).toBe(true);
    });

    it("returns false for content without conflict markers", () => {
      const content = "just some normal content\nno conflicts here";

      expect(hasConflictMarkers(content)).toBe(false);
    });

    it("returns false for partial markers", () => {
      const content = "<<<<<<< HEAD\nbut no separator or end marker";

      expect(hasConflictMarkers(content)).toBe(false);
    });
  });

  describe("parseConflictMarkers", () => {
    it("parses single conflict section", () => {
      const content = `before
<<<<<<< HEAD
our line 1
our line 2
=======
their line 1
>>>>>>> merged
after`;

      const sections = parseConflictMarkers(content);

      expect(sections).toHaveLength(1);
      expect(sections[0].ours).toEqual(["our line 1", "our line 2"]);
      expect(sections[0].theirs).toEqual(["their line 1"]);
      expect(sections[0].base).toBeUndefined();
    });

    it("parses multiple conflict sections", () => {
      const content = `file start
<<<<<<< HEAD
ours 1
=======
theirs 1
>>>>>>> merged
middle
<<<<<<< HEAD
ours 2
=======
theirs 2
>>>>>>> merged
end`;

      const sections = parseConflictMarkers(content);

      expect(sections).toHaveLength(2);
      expect(sections[0].ours).toEqual(["ours 1"]);
      expect(sections[0].theirs).toEqual(["theirs 1"]);
      expect(sections[1].ours).toEqual(["ours 2"]);
      expect(sections[1].theirs).toEqual(["theirs 2"]);
    });

    it("parses diff3-style markers with base section", () => {
      const content = `<<<<<<< HEAD
our change
||||||| base
original
=======
their change
>>>>>>> merged`;

      const sections = parseConflictMarkers(content);

      expect(sections).toHaveLength(1);
      expect(sections[0].ours).toEqual(["our change"]);
      expect(sections[0].base).toEqual(["original"]);
      expect(sections[0].theirs).toEqual(["their change"]);
    });

    it("returns empty array for content without conflicts", () => {
      const content = "no conflicts here";

      const sections = parseConflictMarkers(content);

      expect(sections).toHaveLength(0);
    });

    it("tracks line numbers", () => {
      const content = `line 0
line 1
<<<<<<< HEAD
ours
=======
theirs
>>>>>>> merged
line 7`;

      const sections = parseConflictMarkers(content);

      expect(sections).toHaveLength(1);
      expect(sections[0].startLine).toBe(2);
      expect(sections[0].endLine).toBe(6);
    });
  });

  describe("resolveMarkersByStrategy", () => {
    it("keeps ours content for ours strategy", () => {
      const content = `before
<<<<<<< HEAD
our line
=======
their line
>>>>>>> merged
after`;

      const result = resolveMarkersByStrategy(content, "ours");

      expect(result).toBe("before\nour line\nafter");
    });

    it("keeps theirs content for theirs strategy", () => {
      const content = `before
<<<<<<< HEAD
our line
=======
their line
>>>>>>> merged
after`;

      const result = resolveMarkersByStrategy(content, "theirs");

      expect(result).toBe("before\ntheir line\nafter");
    });

    it("keeps base content for base strategy with diff3 markers", () => {
      const content = `before
<<<<<<< HEAD
our line
||||||| base
original line
=======
their line
>>>>>>> merged
after`;

      const result = resolveMarkersByStrategy(content, "base");

      expect(result).toBe("before\noriginal line\nafter");
    });

    it("handles multiple conflicts", () => {
      const content = `start
<<<<<<< HEAD
ours 1
=======
theirs 1
>>>>>>> merged
middle
<<<<<<< HEAD
ours 2
=======
theirs 2
>>>>>>> merged
end`;

      const result = resolveMarkersByStrategy(content, "ours");

      expect(result).toBe("start\nours 1\nmiddle\nours 2\nend");
    });

    it("preserves content with no conflicts", () => {
      const content = "no conflicts\njust text";

      const result = resolveMarkersByStrategy(content, "ours");

      expect(result).toBe(content);
    });
  });

  describe("countConflictMarkers", () => {
    it("counts zero for no conflicts", () => {
      expect(countConflictMarkers("no conflicts")).toBe(0);
    });

    it("counts single conflict", () => {
      const content = `<<<<<<< HEAD
ours
=======
theirs
>>>>>>> merged`;

      expect(countConflictMarkers(content)).toBe(1);
    });

    it("counts multiple conflicts", () => {
      const content = `<<<<<<< HEAD
ours 1
=======
theirs 1
>>>>>>> merged
text
<<<<<<< HEAD
ours 2
=======
theirs 2
>>>>>>> merged
more text
<<<<<<< HEAD
ours 3
=======
theirs 3
>>>>>>> merged`;

      expect(countConflictMarkers(content)).toBe(3);
    });
  });

  describe("ConflictType values", () => {
    it("has expected conflict types", () => {
      expect(ConflictType.BOTH_MODIFIED).toBe("both_modified");
      expect(ConflictType.DELETE_MODIFY).toBe("delete_modify");
      expect(ConflictType.MODIFY_DELETE).toBe("modify_delete");
      expect(ConflictType.BOTH_ADDED).toBe("both_added");
      expect(ConflictType.MODE_CONFLICT).toBe("mode_conflict");
    });
  });

  describe("ResolutionStrategy values", () => {
    it("has expected strategy values", () => {
      expect(ResolutionStrategy.OURS).toBe("ours");
      expect(ResolutionStrategy.THEIRS).toBe("theirs");
      expect(ResolutionStrategy.BASE).toBe("base");
      expect(ResolutionStrategy.DELETE).toBe("delete");
    });
  });
});
