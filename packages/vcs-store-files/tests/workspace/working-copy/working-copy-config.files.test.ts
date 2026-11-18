/**
 * GitWorkingCopyConfig unit tests.
 *
 * Focus: the save -> load round-trip must be lossless, both for values this
 * class writes and for a hand-written config it did not write.
 */

import {
  type ConfigFilesApi,
  createWorkingCopyConfig,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { beforeEach, describe, expect, it } from "vitest";

/** In-memory ConfigFilesApi */
function createMemFiles(initial: Record<string, string> = {}): ConfigFilesApi & {
  text(path: string): string | undefined;
  set(path: string, text: string): void;
} {
  const store = new Map<string, Uint8Array>();
  for (const [p, t] of Object.entries(initial)) {
    store.set(p, new TextEncoder().encode(t));
  }
  return {
    async read(path: string) {
      return store.get(path);
    },
    async write(path: string, content: Uint8Array) {
      store.set(path, content);
    },
    text(path: string) {
      const c = store.get(path);
      return c ? new TextDecoder().decode(c) : undefined;
    },
    set(path: string, text: string) {
      store.set(path, new TextEncoder().encode(text));
    },
  };
}

const PATH = "/repo/.git/config";

describe("GitWorkingCopyConfig", () => {
  let files: ReturnType<typeof createMemFiles>;

  beforeEach(() => {
    files = createMemFiles();
  });

  /** Save `config`, then load a fresh instance from the same path. */
  async function reload(config: GitWorkingCopyConfig): Promise<GitWorkingCopyConfig> {
    await config.save();
    const next = new GitWorkingCopyConfig(files, PATH);
    await next.load();
    return next;
  }

  describe("save/load round-trip", () => {
    it("round-trips a subsection key (remote.origin.url)", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("remote.origin.url", "https://github.com/statewalker/vcs.git");

      const reloaded = await reload(config);

      expect(reloaded.get("remote.origin.url")).toBe("https://github.com/statewalker/vcs.git");
    });

    it("writes a subsection key as a quoted git section header", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("remote.origin.url", "https://example.com/x.git");
      await config.save();

      expect(files.text(PATH)).toContain('[remote "origin"]');
      expect(files.text(PATH)).toContain("url = https://example.com/x.git");
    });

    it("round-trips a plain two-part key", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("core.bare", false);
      config.set("core.repositoryformatversion", 0);

      const reloaded = await reload(config);

      expect(reloaded.get("core.bare")).toBe(false);
      expect(reloaded.get("core.repositoryformatversion")).toBe(0);
    });

    it("round-trips several keys of the same subsection", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("remote.origin.url", "https://example.com/x.git");
      config.set("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      config.set("branch.main.remote", "origin");
      config.set("branch.main.merge", "refs/heads/main");

      const reloaded = await reload(config);

      expect(reloaded.get("remote.origin.url")).toBe("https://example.com/x.git");
      expect(reloaded.get("remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
      expect(reloaded.get("branch.main.remote")).toBe("origin");
      expect(reloaded.get("branch.main.merge")).toBe("refs/heads/main");
    });

    it("keeps subsection case (git subsections are case-sensitive)", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("remote.Origin.url", "https://example.com/upper.git");
      config.set("REMOTE.origin.URL", "https://example.com/lower.git");

      const reloaded = await reload(config);

      // section + name are case-insensitive, subsection is not
      expect(reloaded.get("remote.Origin.url")).toBe("https://example.com/upper.git");
      expect(reloaded.get("remote.origin.url")).toBe("https://example.com/lower.git");
    });

    it("round-trips values needing quoting", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("user.name", "Test User");
      config.set("alias.qq", " leading and trailing ");
      config.set("alias.hash", "log #1");
      config.set("alias.semi", "log ;x");
      config.set("alias.quote", 'say "hi"');
      config.set("alias.backslash", "C:\\path\\to");
      config.set("alias.empty", "");

      const reloaded = await reload(config);

      expect(reloaded.get("user.name")).toBe("Test User");
      expect(reloaded.get("alias.qq")).toBe(" leading and trailing ");
      expect(reloaded.get("alias.hash")).toBe("log #1");
      expect(reloaded.get("alias.semi")).toBe("log ;x");
      expect(reloaded.get("alias.quote")).toBe('say "hi"');
      expect(reloaded.get("alias.backslash")).toBe("C:\\path\\to");
      expect(reloaded.get("alias.empty")).toBe("");
    });

    it("re-reads its own output when saved twice", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("remote.origin.url", "https://example.com/x.git");
      const once = await reload(config);
      once.set("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      const twice = await reload(once);

      expect(twice.get("remote.origin.url")).toBe("https://example.com/x.git");
      expect(twice.get("remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
    });
  });

  describe("issue 1: comments and hand-written layout survive a save", () => {
    const HANDWRITTEN = `# top-level comment
[core]
	repositoryformatversion = 0
	; the working copy is not bare
	bare = false
[remote "origin"]
	url = https://example.com/x.git
`;

    it("preserves comments when an unrelated key is added", async () => {
      files.set(PATH, HANDWRITTEN);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.set("user.name", "Test User");
      await config.save();

      const text = files.text(PATH) ?? "";
      expect(text).toContain("# top-level comment");
      expect(text).toContain("; the working copy is not bare");
    });

    it("preserves comments when an existing key is changed", async () => {
      files.set(PATH, HANDWRITTEN);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.set("remote.origin.url", "https://example.com/changed.git");
      await config.save();

      const text = files.text(PATH) ?? "";
      expect(text).toContain("# top-level comment");
      expect(text).toContain("; the working copy is not bare");
      expect(text).toContain("url = https://example.com/changed.git");
      expect(text).not.toContain("https://example.com/x.git");
    });

    // Deliberately non-canonical: 2-space indent, no spaces around "=", an
    // upper-case boolean and a blank line. Re-serializing any of these lines
    // would change the bytes.
    const ODDLY_FORMATTED = `#no space after the hash
[core]
  repositoryformatversion=0
      bare = FALSE

[remote "origin"]
   url   =    https://example.com/x.git
`;

    it("is byte-identical when nothing changed", async () => {
      files.set(PATH, ODDLY_FORMATTED);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      await config.save();

      expect(files.text(PATH)).toBe(ODDLY_FORMATTED);
    });

    it("leaves untouched lines exactly as written when another key changes", async () => {
      files.set(PATH, ODDLY_FORMATTED);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.set("user.name", "Test User");
      await config.save();

      const text = files.text(PATH) ?? "";
      expect(text).toContain("#no space after the hash");
      expect(text).toContain("  repositoryformatversion=0\n");
      expect(text).toContain("      bare = FALSE\n");
      expect(text).toContain("   url   =    https://example.com/x.git\n");
      expect(text).toContain("\n\n[remote"); // the blank line survives
    });

    it("reads the oddly formatted values correctly", async () => {
      files.set(PATH, ODDLY_FORMATTED);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("core.repositoryformatversion")).toBe(0);
      expect(config.get("core.bare")).toBe(false);
      expect(config.get("remote.origin.url")).toBe("https://example.com/x.git");
    });

    it("does not truncate an existing file when saved without an explicit load", async () => {
      files.set(PATH, HANDWRITTEN);
      // no load() — the caller only wants to change one key
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("remote.origin.url", "https://example.com/changed.git");
      await config.save();

      const text = files.text(PATH) ?? "";
      expect(text).toContain("# top-level comment");
      expect(text).toContain("; the working copy is not bare");

      const reloaded = new GitWorkingCopyConfig(files, PATH);
      await reloaded.load();
      expect(reloaded.get("core.repositoryformatversion")).toBe(0);
      expect(reloaded.get("core.bare")).toBe(false);
      expect(reloaded.get("remote.origin.url")).toBe("https://example.com/changed.git");
    });

    it("adds a new key into the existing section rather than duplicating it", async () => {
      files.set(PATH, HANDWRITTEN);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.set("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      await config.save();

      const text = files.text(PATH) ?? "";
      expect(text.match(/\[remote "origin"\]/g)?.length).toBe(1);

      const reloaded = new GitWorkingCopyConfig(files, PATH);
      await reloaded.load();
      expect(reloaded.get("remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
      expect(reloaded.get("remote.origin.url")).toBe("https://example.com/x.git");
    });

    it("strips inline comments from values", async () => {
      files.set(PATH, "[core]\n\tbare = false # not bare\n\tignorecase = true ; mac\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("core.bare")).toBe(false);
      expect(config.get("core.ignorecase")).toBe(true);
    });

    it("keeps a '#' that is inside a quoted value", async () => {
      files.set(PATH, '[alias]\n\tx = "log #1"\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("alias.x")).toBe("log #1");
    });
  });

  describe("issue 2: repeated keys (multivar)", () => {
    const MULTI = `[remote "origin"]
	url = https://example.com/x.git
	fetch = +refs/heads/*:refs/remotes/origin/*
	fetch = +refs/tags/*:refs/tags/*
`;

    it("keeps every value of a repeated key", async () => {
      files.set(PATH, MULTI);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.getAll("remote.origin.fetch")).toEqual([
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
      ]);
      // git's `--get` semantics: last value wins
      expect(config.get("remote.origin.fetch")).toBe("+refs/tags/*:refs/tags/*");
    });

    it("does not drop a repeated key on save", async () => {
      files.set(PATH, MULTI);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.set("remote.origin.url", "https://example.com/changed.git");
      await config.save();

      const reloaded = new GitWorkingCopyConfig(files, PATH);
      await reloaded.load();
      expect(reloaded.getAll("remote.origin.fetch")).toEqual([
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
      ]);
    });

    it("add() appends a value, set() replaces all of them", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      config.add("remote.origin.fetch", "+refs/tags/*:refs/tags/*");

      const reloaded = await reload(config);
      expect(reloaded.getAll("remote.origin.fetch")).toEqual([
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
      ]);

      reloaded.set("remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
      const again = await reload(reloaded);
      expect(again.getAll("remote.origin.fetch")).toEqual([
        "+refs/heads/main:refs/remotes/origin/main",
      ]);
    });

    it("getAll returns [] for an unknown key", () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      expect(config.getAll("remote.origin.fetch")).toEqual([]);
    });
  });

  describe("issue 3: numeric-looking values are not corrupted", () => {
    it("keeps values that are not canonical numbers as strings", async () => {
      files.set(
        PATH,
        "[user]\n\tname = 007\n\thex = 0x10\n\texp = 1e3\n\tver = 1.50\n\tplus = +5\n",
      );
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("user.name")).toBe("007");
      expect(config.get("user.hex")).toBe("0x10");
      expect(config.get("user.exp")).toBe("1e3");
      expect(config.get("user.ver")).toBe("1.50");
      expect(config.get("user.plus")).toBe("+5");
    });

    it("still exposes canonical numbers as numbers", async () => {
      files.set(PATH, "[core]\n\trepositoryformatversion = 0\n\tbigfilethreshold = 512\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("core.repositoryformatversion")).toBe(0);
      expect(config.get("core.bigfilethreshold")).toBe(512);
    });

    it("round-trips a non-canonical numeric string byte-for-byte", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("user.name", "007");
      const reloaded = await reload(config);

      expect(reloaded.get("user.name")).toBe("007");
      expect(files.text(PATH)).toContain("name = 007");
    });

    it("does not coerce Infinity/NaN spellings", async () => {
      files.set(PATH, "[user]\n\ta = Infinity\n\tb = NaN\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("user.a")).toBe("Infinity");
      expect(config.get("user.b")).toBe("NaN");
    });
  });

  describe("issue 4: whitespace inside a section header", () => {
    it("keeps a space in a quoted subsection", async () => {
      files.set(PATH, '[remote "up stream"]\n\turl = https://example.com/u.git\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("remote.up stream.url")).toBe("https://example.com/u.git");
      expect(config.get("remote.up.stream.url")).toBeUndefined();
    });

    it("refuses whitespace after `[` or before `]`, as git does", async () => {
      // git: "fatal: bad config line 1 in file ..." (only blanks between the name and `"`)
      files.set(PATH, '[ remote   "origin" ]\n\turl = https://example.com/x.git\n');
      await expect(new GitWorkingCopyConfig(files, PATH).load()).rejects.toThrow(
        `bad config line 1 in file ${PATH.replace(/^\/+/, "")}`,
      );
      files.set(PATH, '[remote   "origin"]\n\turl = https://example.com/x.git\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("remote.origin.url")).toBe("https://example.com/x.git");
    });

    it("supports the dotted section form [section.subsection]", async () => {
      files.set(PATH, "[remote.origin]\n\turl = https://example.com/x.git\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("remote.origin.url")).toBe("https://example.com/x.git");
    });

    it("round-trips a subsection containing a space", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      config.set("remote.up stream.url", "https://example.com/u.git");

      const reloaded = await reload(config);
      expect(reloaded.get("remote.up stream.url")).toBe("https://example.com/u.git");
      expect(files.text(PATH)).toContain('[remote "up stream"]');
    });
  });

  describe("parsing edge cases", () => {
    it("treats a valueless key as boolean true (git semantics)", async () => {
      files.set(PATH, "[core]\n\tbare\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("core.bare")).toBe(true);
    });

    it("understands git's boolean spellings", async () => {
      files.set(PATH, "[core]\n\ta = yes\n\tb = on\n\tc = no\n\td = off\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get("core.a")).toBe(true);
      expect(config.get("core.b")).toBe(true);
      expect(config.get("core.c")).toBe(false);
      expect(config.get("core.d")).toBe(false);
    });

    it("handles a subsection containing a quote or a backslash", async () => {
      files.set(PATH, '[branch "we\\"ird"]\n\tremote = origin\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.get('branch.we"ird.remote')).toBe("origin");
    });

    it("load() replaces previous state", async () => {
      files.set(PATH, "[core]\n\tbare = false\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      expect(config.get("core.bare")).toBe(false);

      files.set(PATH, "[core]\n\tignorecase = true\n");
      await config.load();

      expect(config.get("core.bare")).toBeUndefined();
      expect(config.get("core.ignorecase")).toBe(true);
    });

    it("rejects a key with no section", () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      expect(() => config.set("bare", true)).toThrow(/section/i);
    });
  });

  describe("unset", () => {
    it("removes a key from the file", async () => {
      files.set(PATH, '[remote "origin"]\n\turl = https://example.com/x.git\n\tfetch = a\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.unset("remote.origin.fetch");

      const reloaded = await reload(config);
      expect(reloaded.get("remote.origin.fetch")).toBeUndefined();
      expect(reloaded.get("remote.origin.url")).toBe("https://example.com/x.git");
    });

    it("removes a whole section", async () => {
      files.set(
        PATH,
        '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.com/x.git\n\tfetch = a\n',
      );
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.unsetSection("remote.origin");

      const reloaded = await reload(config);
      expect(reloaded.get("remote.origin.url")).toBeUndefined();
      expect(reloaded.get("remote.origin.fetch")).toBeUndefined();
      expect(reloaded.get("core.bare")).toBe(false);
      expect(files.text(PATH)).not.toContain('[remote "origin"]');
    });

    // A section reference is half case-sensitive, exactly like a key: the
    // section name is case-insensitive, the subsection is not. Getting this
    // wrong makes unsetSection("remote.Origin") delete the wrong remote.
    const TWO_CASES =
      '[remote "Origin"]\n\turl = https://example.com/upper.git\n' +
      '[remote "origin"]\n\turl = https://example.com/lower.git\n';

    it("unsetSection keeps the case of the subsection", async () => {
      files.set(PATH, TWO_CASES);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.unsetSection("remote.Origin");

      const reloaded = await reload(config);
      expect(reloaded.get("remote.Origin.url")).toBeUndefined();
      expect(reloaded.get("remote.origin.url")).toBe("https://example.com/lower.git");
      expect(files.text(PATH)).not.toContain('[remote "Origin"]');
      expect(files.text(PATH)).toContain('[remote "origin"]');
    });

    it("unsetSection removes only the lower-case section when asked for it", async () => {
      files.set(PATH, TWO_CASES);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.unsetSection("remote.origin");

      const reloaded = await reload(config);
      expect(reloaded.get("remote.origin.url")).toBeUndefined();
      expect(reloaded.get("remote.Origin.url")).toBe("https://example.com/upper.git");
    });

    it("unsetSection matches the section name case-insensitively", async () => {
      files.set(PATH, TWO_CASES);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.unsetSection("REMOTE.Origin");

      const reloaded = await reload(config);
      expect(reloaded.get("remote.Origin.url")).toBeUndefined();
      expect(reloaded.get("remote.origin.url")).toBe("https://example.com/lower.git");
    });

    it("renameSection renames the header in place, keeping lines and comments (git remote rename)", async () => {
      files.set(
        PATH,
        '[core]\n\tbare = false\n[remote "origin"]\n\t# the main one\n\turl = a\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n',
      );
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.renameSection("remote.origin", "remote.upstream");
      config.set("remote.upstream.fetch", "+refs/heads/*:refs/remotes/upstream/*");
      expect(config.get("remote.origin.url")).toBeUndefined();
      expect(config.subsections("remote")).toEqual(["upstream"]);

      await config.save();
      expect(files.text(PATH)).toBe(
        '[core]\n\tbare = false\n[remote "upstream"]\n\t# the main one\n\turl = a\n\tfetch = +refs/heads/*:refs/remotes/upstream/*\n[branch "main"]\n\tremote = origin\n',
      );
    });

    it("renameSection onto a section removed before the save drops the removed one's lines", async () => {
      files.set(PATH, '[remote "a"]\n\turl = one\n[remote "b"]\n\turl = two\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.unsetSection("remote.b");
      config.renameSection("remote.a", "remote.b");
      await config.save();
      expect(files.text(PATH)).toBe('[remote "b"]\n\turl = one\n');
    });

    it("copySection puts a copy of the section's lines right after it (git branch -c)", async () => {
      files.set(
        PATH,
        '[branch "feat"]\n\t# a comment\n\tdescription = feat desc\n\n[branch "cur"]\n\tremote = origin\n[core]\n\tbare = false\n',
      );
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.copySection("branch.feat", "branch.cur");
      config.copySection("branch.core", "branch.none");
      expect(config.get("branch.cur.description")).toBe("feat desc");
      expect(config.get("branch.cur.remote")).toBe("origin");
      expect(config.get("branch.feat.description")).toBe("feat desc");

      await config.save();
      expect(files.text(PATH)).toBe(
        '[branch "feat"]\n\t# a comment\n\tdescription = feat desc\n\n[branch "cur"]\n\t# a comment\n\tdescription = feat desc\n\n[branch "cur"]\n\tremote = origin\n[core]\n\tbare = false\n',
      );
    });

    it("copySection of the last section, and of a value changed before the save", async () => {
      files.set(PATH, '[branch "a"]\n\tmerge = refs/heads/a\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.set("branch.a.merge", "refs/heads/x");
      config.copySection("branch.a", "branch.b");
      await config.save();
      expect(files.text(PATH)).toBe(
        '[branch "a"]\n\tmerge = refs/heads/x\n[branch "b"]\n\tmerge = refs/heads/x\n',
      );
    });

    it("lists subsections of a section", async () => {
      files.set(
        PATH,
        '[remote "origin"]\n\turl = a\n[remote "upstream"]\n\turl = b\n[core]\n\tbare = false\n',
      );
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.subsections("remote").sort()).toEqual(["origin", "upstream"]);
    });

    it("lists subsections verbatim for a section named in any case", async () => {
      files.set(PATH, TWO_CASES);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();

      expect(config.subsections("REMOTE").sort()).toEqual(["Origin", "origin"]);
      expect(config.subsections("Remote").sort()).toEqual(["Origin", "origin"]);
    });
  });

  describe("createWorkingCopyConfig", () => {
    it("loads the main worktree config", async () => {
      files.set("/repo/.git/config", '[remote "origin"]\n\turl = https://example.com/x.git\n');
      const config = await createWorkingCopyConfig(files, "/repo/.git");

      expect(config.get("remote.origin.url")).toBe("https://example.com/x.git");
    });

    it("loads a linked worktree config", async () => {
      files.set("/repo/.git/worktrees/wt1/config", "[core]\n\tbare = false\n");
      const config = await createWorkingCopyConfig(files, "/repo/.git", "wt1");

      expect(config.get("core.bare")).toBe(false);
    });
  });

  describe("a leading BOM", () => {
    it("is skipped when read and kept when the file is rewritten, as git keeps it", async () => {
      const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
      const body = new TextEncoder().encode("[core]\n\tbare = false\n");
      const withBom = new Uint8Array(bom.length + body.length);
      withBom.set(bom);
      withBom.set(body, bom.length);
      await files.write(PATH, withBom);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      expect(config.get("core.bare")).toBe(false);
      config.set("foo.bar", "baz");
      await config.save();
      const saved = (await files.read(PATH)) ?? new Uint8Array();
      expect([...saved.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(saved[3]).toBe(0x5b); // "[": one BOM, not two
      expect(new TextDecoder().decode(saved)).toContain("bar = baz");
      // a file without one gets none
      files.set(PATH, "[core]\n\tbare = false\n");
      const plain = new GitWorkingCopyConfig(files, PATH);
      await plain.load();
      plain.set("foo.bar", "baz");
      await plain.save();
      expect((await files.read(PATH))?.[0]).toBe(0x5b);
    });
  });

  describe("section edits as git's config.c makes them", () => {
    it("renameSection onto an existing section renames in place; values read in file order", async () => {
      files.set(PATH, '[branch "feat"]\n\tremote = a\n[branch "main2"]\n\tremote = b\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.renameSection("branch.feat", "branch.main2");
      expect(config.getAll("branch.main2.remote")).toEqual(["a", "b"]);
      expect(config.get("branch.main2.remote")).toBe("b");
      await config.save();
      expect(files.text(PATH)).toBe(
        '[branch "main2"]\n\tremote = a\n[branch "main2"]\n\tremote = b\n',
      );
    });

    it("copySection leaves a header-line variable behind; renameSection moves it to its own line", async () => {
      files.set(PATH, '[branch "feat"] rebase = true\n\tremote = o\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.copySection("branch.feat", "branch.f2");
      expect(config.get("branch.f2.rebase")).toBeUndefined();
      config.renameSection("branch.feat", "branch.f3");
      await config.save();
      expect(files.text(PATH)).toBe(
        '[branch "f3"]\n\trebase = true\n\tremote = o\n[branch "f2"]\n\tremote = o\n',
      );
    });

    it("unsetSection drops the section's comments and blank lines; headers match as written", async () => {
      files.set(
        PATH,
        '[branch "feat"]\n\tremote = o\n# about feat\n\n[Branch "feat"]\n\trebase = true\n[core]\n\tx = 1\n',
      );
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.unsetSection("branch.feat");
      expect(config.get("branch.feat.remote")).toBeUndefined();
      expect(config.get("branch.feat.rebase")).toBe(true);
      await config.save();
      expect(files.text(PATH)).toBe('[Branch "feat"]\n\trebase = true\n[core]\n\tx = 1\n');
    });

    it("getLastOf: the key set last among several", async () => {
      files.set(PATH, "[core]\n\tcommentString = //\n\tcommentChar = %\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      expect(config.getLastOf(["core.commentChar", "core.commentString"])).toEqual({
        key: "core.commentchar",
        value: "%",
      });
    });
  });

  describe("names git's parser reads back (git_config_parse_key)", () => {
    it("refuses keys git refuses, with git's message, and writes nothing", async () => {
      files.set(PATH, "[core]\n\tbare = false\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      for (const [key, message] of [
        ["bare", "key does not contain a section: bare"],
        [".x", "key does not contain a section: .x"],
        ["core.", "key does not contain variable name: core."],
        ["core.bad_name", "invalid key: core.bad_name"],
        ["core.1x", "invalid key: core.1x"],
        ["a b.c", "invalid key: a b.c"],
        ["a.b\nc.d", "invalid key (newline): a.b\nc.d"],
        ["remote.a\0b.url", "invalid key: remote.a\0b.url"],
      ] as const) {
        expect(() => config.set(key, "v")).toThrow(message);
        expect(() => config.add(key, "v")).toThrow(message);
      }
      expect(() => config.set("t.v", "a\0b")).toThrow("invalid value (NUL): t.v");
      await config.save();
      expect(files.text(PATH)).toBe("[core]\n\tbare = false\n");
    });

    it("accepts what git accepts: dashes, any subsection, an empty one", async () => {
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      config.set("core.x-y", "1");
      config.set("a.b.c-", "2");
      config.set('remote.we "ird\\.url', "3");
      config.set("remote..url", "4");
      await config.save();
      const reloaded = await reload(config);
      expect(reloaded.get("core.x-y")).toBe(1);
      expect(reloaded.get("a.b.c-")).toBe(2);
      expect(reloaded.get('remote.we "ird\\.url')).toBe(3);
      expect(reloaded.get("remote..url")).toBe(4);
      expect(reloaded.get("remote.url")).toBeUndefined();
    });

    it("refuses to rename or copy a section to a name git's parser would refuse", async () => {
      files.set(PATH, '[remote "origin"]\n\turl = u\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      for (const name of ["bad name.x", "remote.a\nb", "", ".x"]) {
        expect(() => config.renameSection("remote.origin", name)).toThrow(
          `invalid section name: ${name}`,
        );
        expect(() => config.copySection("remote.origin", name)).toThrow(
          `invalid section name: ${name}`,
        );
      }
      await config.save();
      expect(files.text(PATH)).toBe('[remote "origin"]\n\turl = u\n');
    });
  });

  describe("reading as git's parser", () => {
    it("\\v and \\f are no blanks: kept in values, refused where a blank may stand", async () => {
      files.set(PATH, "[t]\n\tx = a\vb\f\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      expect(config.get("t.x")).toBe("a\vb\f");
      for (const text of ["\v[t]\n", "[t]\n\f\tx = 1\n", "[t\v]\n"]) {
        files.set(PATH, text);
        await expect(new GitWorkingCopyConfig(files, PATH).load()).rejects.toThrow(
          /bad config line/,
        );
      }
    });

    it("a value ends at a NUL, as git's C string does", async () => {
      files.set(PATH, '[t]\n\tv = a\0b\n\tq = "c\0d"\n');
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      expect(config.get("t.v")).toBe("a");
      expect(config.get("t.q")).toBe("c");
    });

    it("a variable before any section is listed by its bare name and kept", async () => {
      files.set(PATH, "top = 1\n[core]\n\tbare = false\n");
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      expect(config.listWithOrigin().map((e) => [e.key, e.text, e.line])).toEqual([
        ["top", "1", 1],
        ["core.bare", "false", 3],
      ]);
      expect(config.get("top")).toBeUndefined();
      config.set("core.bare", true);
      await config.save();
      expect(files.text(PATH)).toBe("top = 1\n[core]\n\tbare = true\n");
    });

    it("reads a key in constant time: get over many keys is not quadratic", async () => {
      const n = 20000;
      const lines = ["[big]"];
      for (let i = 0; i < n; i++) lines.push(`\tk${i} = ${i}`);
      files.set(PATH, `${lines.join("\n")}\n`);
      const config = new GitWorkingCopyConfig(files, PATH);
      await config.load();
      const start = performance.now();
      for (let i = 0; i < n; i++) expect(config.get(`big.k${i}`)).toBe(i);
      config.set("big.k0", "changed");
      expect(config.get("big.k0")).toBe("changed");
      // linear: well under a second; the quadratic scans took tens of seconds
      expect(performance.now() - start).toBeLessThan(3000);
    });
  });
});
