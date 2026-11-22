/**
 * git's repository safety checks with a simulated storage and host: owners come from a fake
 * `lstat`, the user from `effectiveUid`, `safe.directory` / `safe.bareRepository` from the
 * protected configuration (system, global, command line; never the repository's config).
 */
import {
  createInMemoryFilesApi,
  type FilesApi,
  type LinkStats,
} from "@statewalker/vcs-utils/files";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";
import {
  allowedBareRepository,
  DubiousOwnershipError,
  discoverRepository,
  ensureValidOwnership,
  isImplicitBareRepository,
  isOwnedByCurrentUser,
  NotAGitRepositoryError,
  ProtectedConfigError,
  readProtectedConfig,
  sqQuotePretty,
  sudoUidOf,
  UnsafeBareRepositoryError,
} from "../src/index.js";

const enc = (text: string) => new TextEncoder().encode(text);

/** A memory FilesApi rooted at `/host` whose `lstat` reports `owner(path)` as the uid. */
function ownedFiles(owner: (path: string) => number | undefined): FilesApi {
  const mem = createInMemoryFilesApi();
  const files = Object.create(mem) as FilesApi & {
    lstat(path: string): Promise<LinkStats | undefined>;
    rootDirectory: string;
  };
  files.lstat = async (path: string) => {
    const stats = await mem.stats(path);
    if (!stats) return undefined;
    const uid = owner(path);
    return {
      kind: stats.kind,
      size: stats.size ?? 0,
      lastModified: stats.lastModified ?? 0,
      ...(uid !== undefined ? { uid } : {}),
    };
  };
  files.rootDirectory = "/host";
  return files;
}

async function makeRepository(files: FilesApi, gitDir: string): Promise<void> {
  await files.write(`${gitDir}/HEAD`, [enc("ref: refs/heads/main\n")]);
  await files.mkdir(`${gitDir}/objects`);
  await files.mkdir(`${gitDir}/refs`);
}

/** A host whose files are the given texts (system and global config files). */
function host(
  options: Partial<GitHostEnvironment> & { texts?: Record<string, string> } = {},
): GitHostEnvironment {
  const { texts = {}, ...rest } = options;
  return {
    readFile: async (path) => (texts[path] !== undefined ? enc(texts[path]) : undefined),
    realPath: async (path) => {
      const out: string[] = [];
      for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
      }
      return `/${out.join("/")}`;
    },
    ...rest,
  };
}

describe("ownership", () => {
  it("passes when the owner or the user cannot be told", async () => {
    const files = ownedFiles(() => 1000);
    await makeRepository(files, "/repo/.git");
    // no effective uid (a browser, Windows)
    expect(await isOwnedByCurrentUser(files, "/repo", host())).toBeUndefined();
    expect(
      (await ensureValidOwnership({ files, environment: host(), worktree: "/repo" })).safe,
    ).toBe(true);
    // no owners in the storage's stats
    const ownerless = ownedFiles(() => undefined);
    await makeRepository(ownerless, "/repo/.git");
    const env = host({ effectiveUid: 1 });
    expect(
      (await ensureValidOwnership({ files: ownerless, environment: env, worktree: "/repo" })).safe,
    ).toBe(true);
    // a storage without lstat
    const plain = createInMemoryFilesApi();
    expect(await isOwnedByCurrentUser(plain, "/", env)).toBeUndefined();
  });

  it("compares owners with the effective uid and root's SUDO_UID", async () => {
    const files = ownedFiles((path) => (path.startsWith("/mine") ? 1000 : 0));
    await files.mkdir("/mine");
    await files.mkdir("/root-owned");
    expect(await isOwnedByCurrentUser(files, "/mine", host({ effectiveUid: 1000 }))).toBe(true);
    expect(await isOwnedByCurrentUser(files, "/root-owned", host({ effectiveUid: 1000 }))).toBe(
      false,
    );
    // root owns root's, and through sudo the invoking user's
    expect(await isOwnedByCurrentUser(files, "/root-owned", host({ effectiveUid: 0 }))).toBe(true);
    expect(await isOwnedByCurrentUser(files, "/mine", host({ effectiveUid: 0 }))).toBe(false);
    expect(
      await isOwnedByCurrentUser(files, "/mine", host({ effectiveUid: 0, sudoUid: "1000" })),
    ).toBe(true);
    // SUDO_UID only counts for root
    expect(
      await isOwnedByCurrentUser(files, "/mine", host({ effectiveUid: 5, sudoUid: "1000" })),
    ).toBe(false);
    // a missing path is not owned
    expect(await isOwnedByCurrentUser(files, "/missing", host({ effectiveUid: 1000 }))).toBe(false);
  });

  it("reads SUDO_UID as strtoul", () => {
    expect(sudoUidOf("1000")).toBe(1000);
    expect(sudoUidOf(" +7")).toBe(7);
    expect(sudoUidOf("-1")).toBe(4294967295);
    expect(sudoUidOf("")).toBeUndefined();
    expect(sudoUidOf("12x")).toBeUndefined();
    expect(sudoUidOf("99999999999999999999999")).toBeUndefined();
  });

  it("quotes the hint's path as sq_quote_buf_pretty", () => {
    expect(sqQuotePretty("/srv/repo.git")).toBe("/srv/repo.git");
    expect(sqQuotePretty("/srv/my repo")).toBe("'/srv/my repo'");
    expect(sqQuotePretty("/it's!")).toBe("'/it'\\''s'\\!''");
    expect(new DubiousOwnershipError("/srv/a b").message).toBe(
      "fatal: detected dubious ownership in repository at '/srv/a b'\n" +
        "To add an exception for this directory, call:\n\n" +
        "\tgit config --global --add safe.directory '/srv/a b'",
    );
  });
});

describe("safe.directory", () => {
  const files = ownedFiles(() => 0);
  const check = async (
    values: Array<string | undefined>,
    extra: Partial<GitHostEnvironment> = {},
    compatibility?: "2.43" | "2.56",
  ) => {
    await makeRepository(files, "/srv/repo/.git");
    const environment = host({
      effectiveUid: 1000,
      commandLineConfig: values.map((value) => ({ key: "safe.directory", value })),
      ...extra,
    });
    return ensureValidOwnership({
      files,
      environment,
      worktree: "/srv/repo",
      gitDir: "/srv/repo/.git",
      cwd: "/host/srv/repo",
      ...(compatibility ? { compatibility } : {}),
    });
  };

  it("matches as git 2.5x", async () => {
    expect((await check([])).safe).toBe(false);
    expect((await check(["/host/srv/repo"])).safe).toBe(true);
    expect((await check(["/host/srv/repo/"])).safe).toBe(true);
    expect((await check(["/host/srv/./repo"])).safe).toBe(true);
    expect((await check(["*"])).safe).toBe(true);
    expect((await check(["/host/srv/*"])).safe).toBe(true);
    expect((await check(["/host/srv/repo/*"])).safe).toBe(false);
    expect((await check(["/host/other"])).safe).toBe(false);
    expect((await check(["."])).safe).toBe(true);
    expect((await check(["*", ""])).safe).toBe(false);
    expect((await check(["*", undefined])).safe).toBe(false);
    expect((await check(["", "/host/srv/repo"])).safe).toBe(true);
    expect((await check(["~/repo"], { home: "/host/srv" })).safe).toBe(true);
    expect((await check(["%(prefix)//host/srv/repo"])).safe).toBe(true);
    expect((await check(["%(prefix)/srv/repo"], { prefix: "/host" })).safe).toBe(true);
    const relative = await check(["srv/repo"]);
    expect(relative).toEqual({
      safe: false,
      warnings: ["warning: safe.directory 'srv/repo' not absolute"],
    });
  });

  it("matches as git 2.43: literal paths, no trailing /*, no '.'", async () => {
    expect((await check(["/host/srv/repo"], {}, "2.43")).safe).toBe(true);
    expect((await check(["/host/srv/repo/"], {}, "2.43")).safe).toBe(false);
    expect((await check(["/host/srv/*"], {}, "2.43")).safe).toBe(false);
    expect((await check(["."], {}, "2.43")).safe).toBe(false);
    expect((await check(["*"], {}, "2.43")).safe).toBe(true);
    expect((await check(["srv/repo"], {}, "2.43")).warnings).toEqual([]);
  });

  it("reads only the protected configuration", async () => {
    const environment = host({
      systemConfig: "/etc/gitconfig",
      globalConfig: "/home/u/.gitconfig",
      texts: {
        "/etc/gitconfig": "[safe]\n\tdirectory = /a\n",
        "/home/u/.gitconfig":
          "[include]\n\tpath = /home/u/more\n[safe]\n\tbareRepository = explicit\n",
        "/home/u/more": "[safe]\n\tdirectory = /b\n",
      },
      commandLineConfig: [{ key: "safe.directory", value: "/c" }],
    });
    const entries = await readProtectedConfig(environment);
    const safe = entries.filter((e) => e.key.startsWith("safe."));
    expect(safe.map((e) => [e.scope, e.key, e.value])).toEqual([
      ["system", "safe.directory", "/a"],
      ["global", "safe.directory", "/b"],
      ["global", "safe.barerepository", "explicit"],
      ["command", "safe.directory", "/c"],
    ]);
    expect(await readProtectedConfig(undefined)).toEqual([]);
  });

  it("ignores safe.directory in the repository's own config", async () => {
    const owned = ownedFiles(() => 0);
    await makeRepository(owned, "/srv/repo/.git");
    await owned.write("/srv/repo/.git/config", [enc("[safe]\n\tdirectory = *\n")]);
    await expect(
      discoverRepository({
        files: owned,
        cwd: "/srv/repo",
        environment: host({ effectiveUid: 1000 }),
      }),
    ).rejects.toThrow(DubiousOwnershipError);
  });

  it("forces a refusal with GIT_TEST_ASSUME_DIFFERENT_OWNER", async () => {
    const owned = ownedFiles(() => 1000);
    await makeRepository(owned, "/srv/repo/.git");
    const result = await ensureValidOwnership({
      files: owned,
      environment: host({ effectiveUid: 1000, assumeDifferentOwner: true }),
      worktree: "/srv/repo",
    });
    expect(result.safe).toBe(false);
  });
});

describe("safe.bareRepository", () => {
  it("reads explicit or all, the last value winning", () => {
    expect(allowedBareRepository([])).toBe("all");
    expect(
      allowedBareRepository([
        { key: "safe.barerepository", value: "explicit", scope: "global" },
        { key: "safe.barerepository", value: "all", scope: "command" },
      ]),
    ).toBe("all");
    expect(() =>
      allowedBareRepository([{ key: "safe.barerepository", value: "bogus", scope: "command" }]),
    ).toThrow("fatal: unable to parse 'safe.barerepository' from command-line config");
    expect(() =>
      allowedBareRepository([
        { key: "safe.barerepository", value: "x", scope: "global", file: "/g", line: 3 },
      ]),
    ).toThrow(ProtectedConfigError);
  });

  it("allows .git, worktree and module git directories from 2.44 on", () => {
    expect(isImplicitBareRepository("/r/.git")).toBe(true);
    expect(isImplicitBareRepository("/r/.git/worktrees/w")).toBe(true);
    expect(isImplicitBareRepository("/r/.git/modules/m")).toBe(true);
    expect(isImplicitBareRepository("/r/bare.git")).toBe(false);
    expect(isImplicitBareRepository("/r/.git", "2.43")).toBe(false);
  });
});

describe("discoverRepository", () => {
  const explicit = [{ key: "safe.bareRepository", value: "explicit" }];

  it("finds a worktree's .git, a gitfile and a bare repository", async () => {
    const files = ownedFiles(() => 1000);
    const environment = host({ effectiveUid: 1000 });
    await makeRepository(files, "/w/.git");
    await files.mkdir("/w/a/b");
    expect(await discoverRepository({ files, cwd: "/w/a/b", environment })).toEqual({
      gitDir: "/w/.git",
      workTree: "/w",
      bare: false,
      warnings: [],
    });
    await makeRepository(files, "/store/modules/x");
    await files.write("/sub/.git", [enc("gitdir: ../store/modules/x\n")]);
    expect(await discoverRepository({ files, cwd: "/sub", environment })).toMatchObject({
      gitDir: "/store/modules/x",
      workTree: "/sub",
      gitfile: "/sub/.git",
    });
    await makeRepository(files, "/b.git");
    await files.mkdir("/b.git/refs/heads");
    expect(
      await discoverRepository({ files, cwd: "/b.git/refs/heads", environment }),
    ).toMatchObject({
      gitDir: "/b.git",
      bare: true,
    });
    await files.mkdir("/none");
    const empty = createInMemoryFilesApi();
    await empty.mkdir("/x");
    await expect(discoverRepository({ files: empty, cwd: "/x", environment })).rejects.toThrow(
      NotAGitRepositoryError,
    );
  });

  it("refuses another user's repository with git's text, naming the directory found", async () => {
    const files = ownedFiles((path) => (path.startsWith("/w") ? 0 : 1000));
    await makeRepository(files, "/w/.git");
    await files.mkdir("/w/a");
    const environment = host({ effectiveUid: 1000 });
    await expect(discoverRepository({ files, cwd: "/w/a", environment })).rejects.toThrow(
      "fatal: detected dubious ownership in repository at '/host/w'\n" +
        "To add an exception for this directory, call:\n\n" +
        "\tgit config --global --add safe.directory /host/w",
    );
    // safe.directory names the worktree
    const allowed = host({
      effectiveUid: 1000,
      commandLineConfig: [{ key: "safe.directory", value: "/host/w" }],
    });
    expect((await discoverRepository({ files, cwd: "/w/a", environment: allowed })).gitDir).toBe(
      "/w/.git",
    );
    // the gitfile's owner counts too
    const mixed = ownedFiles((path) => (path === "/sub/.git" ? 0 : 1000));
    await makeRepository(mixed, "/m");
    await mixed.write("/sub/.git", [enc("gitdir: ../m\n")]);
    await expect(discoverRepository({ files: mixed, cwd: "/sub", environment })).rejects.toThrow(
      DubiousOwnershipError,
    );
    // an explicit git directory and checkOwnership: false skip the check
    expect((await discoverRepository({ files, gitDir: "/w/.git", environment })).gitDir).toBe(
      "/w/.git",
    );
    expect(
      (await discoverRepository({ files, cwd: "/w/a", environment, checkOwnership: false })).gitDir,
    ).toBe("/w/.git");
  });

  it("refuses a discovered bare repository under safe.bareRepository=explicit", async () => {
    const files = ownedFiles(() => 1000);
    await makeRepository(files, "/b.git");
    await makeRepository(files, "/w/.git");
    const environment = host({
      effectiveUid: 1000,
      commandLineConfig: explicit.map((e) => ({ key: "safe.barerepository", value: e.value })),
    });
    await expect(discoverRepository({ files, cwd: "/b.git", environment })).rejects.toThrow(
      new UnsafeBareRepositoryError("/host/b.git").message,
    );
    // the .git directory of a worktree is implicit (2.44+), not in 2.43
    expect((await discoverRepository({ files, cwd: "/w/.git", environment })).bare).toBe(true);
    await expect(
      discoverRepository({ files, cwd: "/w/.git", environment, compatibility: "2.43" }),
    ).rejects.toThrow(UnsafeBareRepositoryError);
    // GIT_DIR is explicit
    expect((await discoverRepository({ files, gitDir: "/b.git", environment })).gitDir).toBe(
      "/b.git",
    );
  });
});
