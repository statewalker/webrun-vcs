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

    it("tolerates extra whitespace around the header parts", async () => {
      files.set(PATH, '[ remote   "origin" ]\n\turl = https://example.com/x.git\n');
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
});
