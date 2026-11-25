/**
 * receive-pack's limits and policies against native git: `receive.maxInputSize` (t5546),
 * `receive.advertiseAtomic`, `receive.keepAlive`, `receive.autogc` (the auto maintenance after
 * a push) and `receive.updateServerInfo`. Each scenario pushes the same source to twin targets
 * (`receiveTwins`): native git to a local path beside native git to our git:// server and our
 * client to a local path, and compares the outcomes and what the targets hold. git master's
 * receive-report hook is in `receive-report-git3-native.test.ts`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  commitFiles,
  describeGit,
  git,
  hook,
  nativeAsync,
  nativeOutcome,
  ourOutcome,
  ours,
  receiveTwins,
  rootDir,
  source,
  stateOf,
} from "./receive-limits-native-support.js";
import { putFile } from "./status-native-support.js";

describeGit("receive-pack's limits and policies, as native git", () => {
  const { twins, pushAll, daemonPort } = receiveTwins();

  describe("t5546-receive-limits.sh: receive.maxInputSize", () => {
    // t5546 pushes a known-size (1024 bytes) commit with receive.unpackLimit 1 (index-pack) and
    // 10000 (unpack-objects); the last two cases take the child by the pack's object count and by
    // receive.unpackLimit over transfer.unpackLimit
    for (const { store, label, files, size, limits, bigger } of [
      {
        store: "index",
        label: "index",
        files: 1,
        size: 1024,
        limits: [["receive.unpackLimit", "1"]],
        bigger: "4k",
      },
      {
        store: "unpack",
        label: "unpack",
        files: 1,
        size: 1024,
        limits: [["receive.unpackLimit", "10000"]],
        bigger: "4k",
      },
      {
        store: "index",
        label: "index, 120 objects",
        files: 120,
        size: 40,
        limits: [],
        bigger: "1m",
      },
      {
        store: "index",
        label: "index, receive.unpackLimit over transfer.unpackLimit",
        files: 1,
        size: 1024,
        limits: [
          ["receive.unpackLimit", "1"],
          ["transfer.unpackLimit", "10000"],
        ],
        bigger: "4k",
      },
    ] as {
      store: string;
      label: string;
      files: number;
      size: number;
      limits: [string, string][];
      bigger: string;
    }[]) {
      it(`t5546-receive-limits.sh: "setting receive.maxInputSize to 512 rejects push" (${label})`, async () => {
        const src = source(files, size);
        const t = twins(src, [...limits, ["receive.maxInputSize", "512"]]);
        const { native, served, ours: mine } = await pushAll(t, "HEAD:refs/heads/main");
        const theirs = nativeOutcome(native);
        expect(theirs.ok).toBe(false);
        expect(theirs.unpack).toEqual([
          `error: remote unpack failed: ${store === "index" ? "index-pack" : "unpack-objects"} abnormal exit`,
        ]);
        expect(theirs.remote).toEqual([
          store === "index"
            ? "fatal: pack exceeds maximum allowed size (512 bytes)"
            : "fatal: pack exceeds maximum allowed size",
        ]);
        expect(nativeOutcome(served)).toEqual(theirs);
        expect(mine.result && ourOutcome(mine.result)).toEqual(theirs);
        const state = stateOf(join(t.n, "dst"));
        expect(state.objects).toEqual([]);
        expect(stateOf(join(t.d, "dst"))).toEqual(state);
        expect(stateOf(join(t.o, "dst"))).toEqual(state);
      });

      for (const [title, limit] of [
        ['"bumping limit to 4k allows push"', bigger],
        ['"lifting the limit allows push"', "0"],
      ] as const) {
        it(`t5546-receive-limits.sh: ${title} (${label})`, async () => {
          const src = source(files, size);
          const t = twins(src, [...limits, ["receive.maxInputSize", limit]]);
          const { native, served, ours: mine } = await pushAll(t, "HEAD:refs/heads/main");
          const theirs = nativeOutcome(native);
          expect(theirs.ok).toBe(true);
          expect(nativeOutcome(served)).toEqual(theirs);
          expect(mine.result && ourOutcome(mine.result)).toEqual(theirs);
          const state = stateOf(join(t.n, "dst"));
          expect(stateOf(join(t.d, "dst")).refs).toEqual(state.refs);
          expect(stateOf(join(t.o, "dst")).objects).toEqual(state.objects);
        });
      }
    }

    // no git t/ test: receive_pack_config's death on a bad number (die_bad_number)
    it("a receive.maxInputSize git cannot read kills receive-pack before the advertisement", async () => {
      const src = source(1, 10);
      const t = twins(src, [["receive.maxInputSize", "lots"]]);
      const { native, ours: mine } = await pushAll(t, "HEAD:refs/heads/main");
      expect(native.status).toBe(128);
      const death = native.stderr.split("\n")[0];
      expect(death).toBe(
        "fatal: bad numeric config value 'lots' for 'receive.maxinputsize' in file config: invalid unit",
      );
      expect(mine.error?.message.split("\n")[0]).toBe(death);
    });
  });

  // receive.advertiseAtomic, receive.keepAlive, receive.updateServerInfo: no git t/ test exercises
  // them (git's own suite only sets them); these twins compare with native receive-pack directly
  describe("receive.advertiseAtomic", () => {
    it("false: native git's `push --atomic` refuses our server as git's receive-pack", async () => {
      const src = source(1, 10);
      const t = twins(src, [["receive.advertiseAtomic", "false"]]);
      const {
        native,
        served,
        ours: mine,
      } = await pushAll(t, "HEAD:refs/heads/main", {
        args: ["--atomic"],
      });
      expect(native.status).not.toBe(0);
      expect(native.stderr).toContain("the receiving end does not support --atomic push");
      expect(served.status).toBe(native.status);
      // a local receive-pack shares the pusher's stderr: its own death on the hang-up is not
      // the server's to show
      const ownLines = (stderr: string) =>
        stderr.split("\n").filter((l) => l && l !== "fatal: the remote end hung up unexpectedly");
      expect(ownLines(served.stderr)).toEqual(ownLines(native.stderr));
      expect(mine.error?.message ?? "").toContain(
        "the receiving end does not support --atomic push",
      );
      for (const name of ["n", "d", "o"] as const) {
        expect(stateOf(join(t[name], "dst")).refs).toBe("");
      }
    });

    it("unset or true: an atomic push is accepted", async () => {
      const src = source(1, 10);
      const t = twins(src, [["receive.advertiseAtomic", "true"]]);
      const {
        native,
        served,
        ours: mine,
      } = await pushAll(t, "HEAD:refs/heads/main", {
        args: ["--atomic"],
      });
      const theirs = nativeOutcome(native);
      expect(theirs.ok).toBe(true);
      expect(nativeOutcome(served)).toEqual(theirs);
      expect(mine.result && ourOutcome(mine.result)).toEqual(theirs);
    });
  });

  describe("receive.keepAlive", () => {
    /** The keep-alive packets (`0005\1`) native git's client traced while pushing. */
    const keepAlives = (trace: string) =>
      trace.split("\n").filter((l) => /sideband< \\1$/.test(l)).length;

    for (const [value, expectSome] of [
      ["1", true],
      ["0", false],
    ] as const) {
      it(`receive.keepAlive=${value}: keep-alives while pre-receive runs ${expectSome ? "come" : "do not come"}`, async () => {
        const src = source(1, 10);
        const t = twins(src, [["receive.keepAlive", value]], (dst) =>
          hook(dst, "pre-receive", "sleep 2.5"),
        );
        const counts: number[] = [];
        for (const [name, url] of [
          ["n", "../dst"],
          ["d", `git://127.0.0.1:${daemonPort()}/${t.k}/d/dst`],
        ] as const) {
          const trace = join(rootDir(), t.k, `${name}.trace`);
          const r = await nativeAsync(
            join(t[name], "src"),
            ["push", "--porcelain", url, "HEAD:refs/heads/main"],
            { env: { GIT_TRACE_PACKET: trace } },
          );
          expect(r.status).toBe(0);
          counts.push(keepAlives(readFileSync(trace, "latin1")));
        }
        const [theirs, mine] = counts as [number, number];
        if (expectSome) {
          expect(theirs).toBeGreaterThan(0);
          expect(mine).toBeGreaterThan(0);
        } else {
          expect(theirs).toBe(0);
          expect(mine).toBe(0);
        }
      }, 30_000);
    }
  });

  describe("receive.autogc: the auto maintenance after a push", () => {
    // two pushes of over 100 objects each leave two packs (both kept as packs): more than
    // gc.autoPackLimit=1, so the push's `gc --auto` repacks them into one
    const config = (autogc: string): [string, string][] => [
      ["receive.autogc", autogc],
      ["maintenance.auto", "true"],
      ["maintenance.strategy", "gc"],
      ["maintenance.autoDetach", "false"],
      ["gc.autoDetach", "false"],
      ["gc.auto", "6700"],
      ["gc.autoPackLimit", "1"],
    ];

    for (const autogc of ["true", "false"]) {
      it(`receive.autogc=${autogc}: the target ends up as native git's`, async () => {
        const src = source(120, 40);
        const t = twins(src, config(autogc));
        await pushAll(t, "HEAD:refs/heads/main");
        for (const name of ["n", "d", "o"] as const) {
          commitFiles(join(t[name], "src"), 120, 40, 1);
        }
        const { native, served, ours: mine } = await pushAll(t, "HEAD:refs/heads/main");
        const theirs = nativeOutcome(native);
        expect(theirs.ok).toBe(true);
        expect(nativeOutcome(served)).toEqual(theirs);
        expect(mine.result && ourOutcome(mine.result)).toEqual(theirs);
        const state = stateOf(join(t.n, "dst"));
        expect(state.packs).toBe(autogc === "true" ? 1 : 2);
        expect(stateOf(join(t.d, "dst"))).toEqual(state);
        expect(stateOf(join(t.o, "dst"))).toEqual(state);
      }, 60_000);
    }
  });

  it('t5400-send-pack.sh: "receive-pack runs auto-gc in remote repo"', async () => {
    const k = `g${Date.now()}`;
    const dirs: Record<"n" | "o", string> = { n: "", o: "" };
    for (const name of ["n", "o"] as const) {
      const base = join(rootDir(), k, name);
      const parent = join(base, "parent");
      const child = join(base, "child");
      mkdirSync(base, { recursive: true });
      // a repository with two packs
      git(rootDir(), "init", "-q", "-b", "main", parent);
      putFile(parent, "file.txt", "Some text\n");
      git(parent, "add", ".");
      git(parent, "commit", "-qm", "Initial commit");
      git(parent, "repack", "-adlq");
      putFile(parent, "file.txt", "Some text\nSome more text\n");
      git(parent, "commit", "-qam", "Second commit");
      git(parent, "repack", "-q");
      cpSync(parent, child, { recursive: true });
      // the child auto-packs when it has more than one pack; t5400 turns its auto gc on
      for (const [key, value] of [
        ["gc.autopacklimit", "1"],
        ["gc.autodetach", "false"],
        ["maintenance.strategy", "gc"],
        ["maintenance.autoDetach", "false"],
        ["maintenance.auto", "true"],
        ["gc.auto", "6700"],
      ]) {
        git(child, "config", key, value);
      }
      git(child, "branch", "test_auto_gc");
      // a file named as a temporary object, old enough for the auto gc to remove
      const tmp = join(child, ".git", "objects", "tmp_test_object");
      writeFileSync(tmp, "");
      const old = Date.now() / 1000 - 1209601;
      utimesSync(tmp, old, old);
      putFile(parent, "file.txt", "Some text\nSome more text\nEven more text\n");
      git(parent, "commit", "-qam", "Third commit");
      dirs[name] = base;
    }
    const native = await nativeAsync(join(dirs.n, "parent"), [
      "send-pack",
      "../child",
      "HEAD:refs/heads/test_auto_gc",
    ]);
    expect(native.status).toBe(0);
    const mine = await (await ours(`${k}/o/parent`))
      .push()
      .setRemote("../child")
      .setRefSpecs("HEAD:refs/heads/test_auto_gc")
      .call();
    expect(mine.remoteUpdates.map((u) => u.status)).toEqual(["ok"]);
    for (const base of [dirs.n, dirs.o]) {
      expect(existsSync(join(base, "child", ".git", "objects", "tmp_test_object"))).toBe(false);
    }
    const state = stateOf(join(dirs.n, "child", ".git"));
    expect(state.packs).toBe(1);
    expect(stateOf(join(dirs.o, "child", ".git"))).toEqual(state);
  }, 60_000);

  describe("receive.updateServerInfo", () => {
    for (const value of ["true", "false"]) {
      it(`receive.updateServerInfo=${value}: info/refs and objects/info/packs as native git's`, async () => {
        const src = source(120, 20);
        git(src, "tag", "-a", "-m", "v1", "v1");
        const t = twins(src, [["receive.updateServerInfo", value]]);
        // one ref per push: our files store commits a batch of several refs through
        // packed-refs, where git writes them loose
        await pushAll(t, "refs/heads/main:refs/heads/main");
        const { native } = await pushAll(t, "refs/tags/v1:refs/tags/v1");
        expect(native.status).toBe(0);
        const state = stateOf(join(t.n, "dst"));
        expect(state.infoRefs !== undefined).toBe(value === "true");
        expect(stateOf(join(t.d, "dst"))).toEqual(state);
        expect(stateOf(join(t.o, "dst"))).toEqual(state);
      });
    }
  });

  // git master's receive-report hook: no release has it (2.56.1 does not), so its twins run
  // against the git 3.0 oracle built from master ($GIT3)
});
