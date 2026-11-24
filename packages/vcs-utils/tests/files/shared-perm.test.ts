import { describe, expect, it } from "vitest";

import {
  calcSharedPerm,
  createInMemoryFilesApi,
  isReadOnlyObjectFile,
  PERM_EVERYBODY,
  PERM_GROUP,
  parseSharedRepository,
  SharedRepositoryModeError,
  sharedPermOf,
  sharedRepositoryConfigValue,
  withSharedPerm,
} from "../../src/files/index.js";

describe("core.sharedRepository (git_config_perm, calc_shared_perm)", () => {
  it("parses git's spellings", () => {
    expect(parseSharedRepository(undefined)).toBe(0);
    expect(parseSharedRepository("umask")).toBe(0);
    expect(parseSharedRepository("false")).toBe(0);
    expect(parseSharedRepository("")).toBe(0);
    expect(parseSharedRepository("0")).toBe(0);
    expect(parseSharedRepository("group")).toBe(PERM_GROUP);
    expect(parseSharedRepository("true")).toBe(PERM_GROUP);
    expect(parseSharedRepository("1")).toBe(PERM_GROUP);
    expect(parseSharedRepository("all")).toBe(PERM_EVERYBODY);
    expect(parseSharedRepository("world")).toBe(PERM_EVERYBODY);
    expect(parseSharedRepository("everybody")).toBe(PERM_EVERYBODY);
    expect(parseSharedRepository("2")).toBe(PERM_EVERYBODY);
    expect(parseSharedRepository("0640")).toBe(-0o640);
    expect(parseSharedRepository("0777")).toBe(-0o666);
    expect(() => parseSharedRepository("0400")).toThrow(SharedRepositoryModeError);
  });

  it("writes the value init_db writes", () => {
    expect(sharedRepositoryConfigValue(0)).toBeUndefined();
    expect(sharedRepositoryConfigValue(PERM_GROUP)).toBe("1");
    expect(sharedRepositoryConfigValue(PERM_EVERYBODY)).toBe("2");
    expect(sharedRepositoryConfigValue(-0o640)).toBe("0640");
  });

  it("computes the modes adjust_shared_perm gives", () => {
    expect(calcSharedPerm(0o644, PERM_GROUP)).toBe(0o664);
    expect(calcSharedPerm(0o444, PERM_GROUP)).toBe(0o444);
    expect(calcSharedPerm(0o755, PERM_GROUP)).toBe(0o775);
    expect(calcSharedPerm(0o600, -0o640)).toBe(0o640);
    expect(calcSharedPerm(0o400, -0o660)).toBe(0o440);
    expect(sharedPermOf("directory", 0o755, -0o660)).toBe(0o2770);
    expect(sharedPermOf("directory", 0o700, -0o600)).toBe(0o700);
    expect(sharedPermOf("file", 0o755, -0o660)).toBe(0o770);
  });

  it("names the object files git keeps read-only", () => {
    expect(isReadOnlyObjectFile(`/.git/objects/ab/${"c".repeat(38)}`)).toBe(true);
    expect(isReadOnlyObjectFile(`/.git/objects/pack/pack-${"a".repeat(40)}.idx`)).toBe(true);
    expect(isReadOnlyObjectFile("/.git/objects/info/commit-graph")).toBe(true);
    expect(isReadOnlyObjectFile(`/.git/objects/pack/pack-${"a".repeat(40)}.keep`)).toBe(false);
    expect(isReadOnlyObjectFile("/.git/objects/info/alternates")).toBe(false);
  });

  it("leaves a FilesApi without modes as it is", () => {
    const files = createInMemoryFilesApi();
    expect(withSharedPerm(files, () => PERM_GROUP, ".git")).toBe(files);
  });
});
