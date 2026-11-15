/**
 * `git remote rename`, `git remote remove`, `git remote set-head` and the fetch's
 * `followRemoteHEAD` on every backend, with a plain config bag: the multi-ref writes go
 * through `Refs.batch`, and reflogs travel with renamed refs on every store here (Memory,
 * SQL and the KV store all batch atomically with reflogs; only vcs-core's interim
 * `kvStoreRefs` refuses multi-ref batches, covered below). The byte comparisons against
 * native git are in remote-fetch-native-git.test.ts.
 */

import type { WorkingCopy, WorkingCopyConfig } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { kvFactory } from "./backend-factories.js";
import { backends } from "./test-helper.js";
import {
  addFileAndCommit,
  createInitializedTestServer,
  createTestUrl,
} from "./transport-test-helper.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const IDENT = "A U Thor <author@example.com> 1700000000 +0000";

describe.each([...backends, { name: "KV", factory: kvFactory }])(
  "remote rename, remove, set-head as git ($name backend)",
  ({ factory }) => {
    let cleanup: (() => Promise<void>) | undefined;
    const originalFetch = globalThis.fetch;

    afterEach(async () => {
      globalThis.fetch = originalFetch;
      await cleanup?.();
      cleanup = undefined;
    });

    async function open(
      initial: Record<string, unknown> = {},
    ): Promise<{ git: Git; workingCopy: WorkingCopy; config: WorkingCopyConfig }> {
      const config: WorkingCopyConfig = { ...initial };
      const ctx = await factory({ config });
      cleanup = ctx.cleanup;
      return { git: Git.fromWorkingCopy(ctx.workingCopy), workingCopy: ctx.workingCopy, config };
    }

    /** `refs/remotes/origin/{main,feature,HEAD}`, main with a reflog line where kept. */
    async function originRefs(workingCopy: WorkingCopy) {
      const refs = workingCopy.history.refs;
      await refs.batch([{ name: "refs/remotes/origin/main", new: A }], {
        ident: IDENT,
        message: "fetch: one",
      });
      await refs.set("refs/remotes/origin/feature", B);
      await refs.setSymbolic("refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    }

    const originConfig = {
      "remote.origin.url": "https://example.com/a.git",
      "remote.origin.fetch": [
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/heads/main:refs/heads/main-copy",
      ],
      "branch.main.remote": "origin",
      "branch.main.merge": "refs/heads/main",
      "branch.main.pushRemote": "origin",
      "remote.pushDefault": "origin",
    };

    it("rename moves the section, rewrites the default refspec, moves refs and reflogs", async () => {
      const { git, workingCopy, config } = await open(originConfig);
      await originRefs(workingCopy);
      const refs = workingCopy.history.refs;

      const { remote, warnings } = await git
        .remoteRename()
        .setOldName("origin")
        .setNewName("upstream")
        .call();

      expect(remote.name).toBe("upstream");
      expect(config["remote.upstream.fetch"]).toEqual([
        "+refs/heads/*:refs/remotes/upstream/*",
        "+refs/heads/main:refs/heads/main-copy",
      ]);
      expect(config["remote.origin.url"]).toBeUndefined();
      expect(config["remote.upstream.url"]).toBe("https://example.com/a.git");
      expect(config["branch.main.remote"]).toBe("upstream");
      expect(config["branch.main.pushRemote"]).toBe("upstream");
      expect(config["remote.pushDefault"]).toBe("upstream");
      expect(warnings).toEqual([
        "Not updating non-default fetch refspec\n\t+refs/heads/main:refs/heads/main-copy\n\tPlease update the configuration manually if necessary.",
      ]);

      const names: string[] = [];
      for await (const ref of refs.list("refs/remotes/")) names.push(ref.name);
      expect(names.sort()).toEqual([
        "refs/remotes/upstream/HEAD",
        "refs/remotes/upstream/feature",
        "refs/remotes/upstream/main",
      ]);
      expect(await refs.get("refs/remotes/upstream/HEAD")).toMatchObject({
        target: "refs/remotes/upstream/main",
      });
      expect((await refs.resolve("refs/remotes/upstream/feature"))?.objectId).toBe(B);

      // Memory, SQL and KV all keep reflogs and batch atomically: the log always travels
      const log = await refs.getReflog?.("refs/remotes/upstream/main");
      expect(log).toBeDefined();
      const entries = ((await log?.getReverseEntries()) ?? []).reverse();
      expect(entries.map((e) => e.comment)).toEqual([
        "fetch: one",
        "remote: renamed refs/remotes/origin/main to refs/remotes/upstream/main",
      ]);
      expect(entries[1]).toMatchObject({ oldId: A, newId: A });
      expect(await refs.getReflog?.("refs/remotes/origin/main")).toBeUndefined();
    });

    it("rename refuses as git: missing remote, taken name, invalid name", async () => {
      const { git } = await open({
        ...originConfig,
        "remote.other.url": "https://example.com/b.git",
      });
      await expect(git.remoteRename().setOldName("nope").setNewName("x").call()).rejects.toThrow(
        "No such remote: 'nope'",
      );
      await expect(
        git.remoteRename().setOldName("origin").setNewName("other").call(),
      ).rejects.toThrow("remote other already exists.");
      await expect(
        git.remoteRename().setOldName("origin").setNewName("a..b").call(),
      ).rejects.toThrow("'a..b' is not a valid remote name");
    });

    it("remove drops the section, its refs (not another remote's) and the upstream config", async () => {
      const { git, workingCopy, config } = await open({
        ...originConfig,
        "remote.other.url": "https://example.com/b.git",
        "remote.other.fetch": "+refs/heads/feature:refs/remotes/origin/feature",
        "branch.side.pushRemote": "other",
      });
      await originRefs(workingCopy);
      const refs = workingCopy.history.refs;

      const removed = await git.remoteRemove().setRemoteName("origin").call();

      expect(removed?.urls).toEqual(["https://example.com/a.git"]);
      expect(config["remote.origin.url"]).toBeUndefined();
      expect(config["remote.origin.fetch"]).toBeUndefined();
      expect(config["branch.main.remote"]).toBeUndefined();
      expect(config["branch.main.merge"]).toBeUndefined();
      expect(config["branch.main.pushRemote"]).toBeUndefined();
      expect(config["remote.pushDefault"]).toBeUndefined();
      expect(config["branch.side.pushRemote"]).toBe("other");
      expect(await refs.get("refs/remotes/origin/main")).toBeUndefined();
      expect(await refs.get("refs/remotes/origin/HEAD")).toBeUndefined();
      expect((await refs.resolve("refs/remotes/origin/feature"))?.objectId).toBe(B);
      expect(await refs.getReflog?.("refs/remotes/origin/main")).toBeUndefined();
    });

    it("set-head turns followRemoteHEAD=always into warn", async () => {
      const { git, workingCopy, config } = await open({
        ...originConfig,
        "remote.origin.followRemoteHEAD": "always",
      });
      await originRefs(workingCopy);
      await git.remoteSetHead().setRemoteName("origin").setBranch("feature").call();
      expect(config["remote.origin.followRemoteHEAD"]).toBe("warn");
    });

    describe("fetch: followRemoteHEAD", () => {
      async function remote() {
        const server = await createInitializedTestServer();
        const tip = await addFileAndCommit(server.serverStores, "a.txt", "a", "A");
        await server.serverStores.refs.set("refs/heads/feature", server.initialCommitId);
        globalThis.fetch = server.mockFetch;
        return { server, url: createTestUrl(server.baseUrl), tip };
      }

      it("a configured fetch creates refs/remotes/origin/HEAD, set-head -a reads the remote", async () => {
        const { server, url } = await remote();
        const { git, workingCopy } = await open({
          "remote.origin.url": url,
          "remote.origin.fetch": "+refs/heads/*:refs/remotes/origin/*",
        });
        const refs = workingCopy.history.refs;
        await git.fetch().call();
        expect(await refs.get("refs/remotes/origin/HEAD")).toMatchObject({
          target: "refs/remotes/origin/main",
        });

        await server.serverStores.refs.setSymbolic("HEAD", "refs/heads/feature");
        const target = await Git.fromWorkingCopy(workingCopy)
          .remoteSetHead()
          .setRemoteName("origin")
          .setAuto(true)
          .call();
        expect(target).toBe("refs/remotes/origin/feature");
        expect(await refs.get("refs/remotes/origin/HEAD")).toMatchObject({
          target: "refs/remotes/origin/feature",
        });
      });

      it("in a bare mirror, the fetch moves HEAD itself", async () => {
        const { server, url } = await remote();
        const { git, workingCopy } = await open({
          "core.bare": "true",
          "remote.origin.url": url,
          "remote.origin.fetch": "+refs/*:refs/*",
          "remote.origin.mirror": "true",
        });
        await server.serverStores.refs.setSymbolic("HEAD", "refs/heads/feature");
        await git.fetch().call();
        expect(await workingCopy.history.refs.get("HEAD")).toMatchObject({
          target: "refs/heads/feature",
        });
      });
    });

    it("remove keeps a ref a negative refspec excludes, through any of its sources", async () => {
      const { git, workingCopy } = await open({
        "remote.origin.url": "https://example.com/a.git",
        "remote.origin.fetch": [
          "+refs/heads/*:refs/remotes/origin/*",
          "+refs/tags/*:refs/remotes/origin/*",
          "^refs/tags/keep",
        ],
      });
      const refs = workingCopy.history.refs;
      await refs.set("refs/remotes/origin/keep", A);
      await refs.set("refs/remotes/origin/main", B);
      await git.remoteRemove().setRemoteName("origin").call();
      expect((await refs.resolve("refs/remotes/origin/keep"))?.objectId).toBe(A);
      expect(await refs.get("refs/remotes/origin/main")).toBeUndefined();
    });

    it("remove keeps local branches a refspec maps to, with git's note", async () => {
      const { git, workingCopy } = await open({
        "remote.origin.url": "https://example.com/a.git",
        "remote.origin.fetch": ["+refs/heads/*:refs/remotes/origin/*", "refs/heads/*:refs/heads/*"],
      });
      const refs = workingCopy.history.refs;
      await refs.set("refs/heads/topic", A);
      await refs.set("refs/heads/wip", B);
      const remove = git.remoteRemove().setRemoteName("origin");
      await remove.call();
      expect((await refs.resolve("refs/heads/topic"))?.objectId).toBe(A);
      const messages = remove.getMessages();
      expect(messages[0]).toBe(
        "Note: Some branches outside the refs/remotes/ hierarchy were not removed;\nto delete them, use:",
      );
      expect(messages).toContain("  git branch -d topic");
      expect(messages).toContain("  git branch -d wip");
    });

    it("rename on a git-config object without renameSection copies every variable", async () => {
      const values = new Map<string, unknown[]>();
      const config: Record<string, unknown> = {};
      const mirror = (key: string) => {
        const v = values.get(key) ?? [];
        if (v.length > 0) config[key] = v[v.length - 1];
        else delete config[key];
      };
      Object.defineProperties(config, {
        get: { value: (k: string) => values.get(k)?.at(-1), enumerable: false },
        getAll: { value: (k: string) => [...(values.get(k) ?? [])], enumerable: false },
        set: {
          value: (k: string, v: unknown) => {
            values.set(k, [v]);
            mirror(k);
          },
          enumerable: false,
        },
        add: {
          value: (k: string, v: unknown) => {
            values.set(k, [...(values.get(k) ?? []), v]);
            mirror(k);
          },
          enumerable: false,
        },
        unset: {
          value: (k: string) => {
            values.delete(k);
            mirror(k);
          },
          enumerable: false,
        },
        unsetSection: {
          value: (section: string) => {
            for (const k of [...values.keys()]) {
              if (k.startsWith(`${section}.`)) {
                values.delete(k);
                mirror(k);
              }
            }
          },
          enumerable: false,
        },
        subsections: {
          value: (section: string) => [
            ...new Set(
              [...values.keys()]
                .filter((k) => k.startsWith(`${section}.`) && k.split(".").length >= 3)
                .map((k) => k.split(".").slice(1, -1).join(".")),
            ),
          ],
          enumerable: false,
        },
      });
      const cfg = config as unknown as { set(k: string, v: unknown): void };
      cfg.set("remote.origin.url", "https://example.com/a.git");
      cfg.set("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
      cfg.set("remote.origin.tagopt", "--no-tags");
      cfg.set("remote.origin.prune", "true");
      const ctx = await factory({ config: config as WorkingCopyConfig });
      cleanup = ctx.cleanup;
      await Git.fromWorkingCopy(ctx.workingCopy)
        .remoteRename()
        .setOldName("origin")
        .setNewName("upstream")
        .call();
      expect(config["remote.upstream.tagopt"]).toBe("--no-tags");
      expect(config["remote.upstream.prune"]).toBe("true");
      expect(config["remote.upstream.fetch"]).toBe("+refs/heads/*:refs/remotes/upstream/*");
      expect(Object.keys(config).filter((k) => k.startsWith("remote.origin."))).toEqual([]);
    });

    describe("fetch: failures that do not stop it, set-head -a report", () => {
      async function remote() {
        const server = await createInitializedTestServer();
        const tip = await addFileAndCommit(server.serverStores, "a.txt", "a", "A");
        globalThis.fetch = server.mockFetch;
        return { server, url: createTestUrl(server.baseUrl), tip };
      }

      it("a refused prune is reported in errors; the fetch still updates the refs", async () => {
        const { url, tip } = await remote();
        const { git, workingCopy } = await open({
          "remote.origin.url": url,
          "remote.origin.fetch": "+refs/heads/*:refs/remotes/origin/*",
        });
        const refs = workingCopy.history.refs;
        await refs.set("refs/remotes/origin/gone", A);
        const batch = refs.batch.bind(refs);
        refs.batch = async (commands, options) =>
          options?.message === "fetch: prune"
            ? {
                ok: false,
                rejected: commands.map((c) => ({ name: c.name, reason: "locked" as const })),
              }
            : batch(commands, options);
        const result = await git.fetch().setRemoveDeletedRefs(true).call();
        expect(result.errors?.[0]).toContain("refs/remotes/origin/gone: locked");
        expect((await refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(tip);
        expect((await refs.resolve("refs/remotes/origin/gone"))?.objectId).toBe(A);
        expect(
          result.trackingRefUpdates.some((u) => u.localRef === "refs/remotes/origin/gone"),
        ).toBe(false);
      });

      it("a prune names the symbolic refs it leaves dangling", async () => {
        const { url } = await remote();
        const { git, workingCopy } = await open({
          "remote.origin.url": url,
          "remote.origin.fetch": "+refs/heads/*:refs/remotes/origin/*",
        });
        const refs = workingCopy.history.refs;
        await refs.set("refs/remotes/origin/gone", A);
        await refs.setSymbolic("refs/remotes/origin/HEAD", "refs/remotes/origin/gone");
        const result = await git.fetch().setRemoveDeletedRefs(true).call();
        expect(result.messages).toContain(
          "   refs/remotes/origin/HEAD has become dangling after refs/remotes/origin/gone was deleted",
        );
      });

      it("a failing refs/remotes/<name>/HEAD update does not fail the fetch", async () => {
        const { url, tip } = await remote();
        const { git, workingCopy } = await open({
          "remote.origin.url": url,
          "remote.origin.fetch": "+refs/heads/*:refs/remotes/origin/*",
        });
        const refs = workingCopy.history.refs;
        refs.setSymbolic = async () => {
          throw new Error("no symbolic refs here");
        };
        await git.fetch().call();
        expect((await refs.resolve("refs/remotes/origin/main"))?.objectId).toBe(tip);
      });

      it("set-head -a reports as git: created, unchanged, changed", async () => {
        const { server, url } = await remote();
        await server.serverStores.refs.set("refs/heads/feature", server.initialCommitId);
        const { workingCopy } = await open({
          "remote.origin.url": url,
          "remote.origin.fetch": "+refs/heads/*:refs/remotes/origin/*",
          "remote.origin.followRemoteHEAD": "never",
        });
        await Git.fromWorkingCopy(workingCopy).fetch().call();
        const setAuto = async () => {
          const command = Git.fromWorkingCopy(workingCopy)
            .remoteSetHead()
            .setRemoteName("origin")
            .setAuto(true);
          await command.call();
          return command.getMessages();
        };
        expect(await setAuto()).toEqual(["'origin/HEAD' is now created and points to 'main'"]);
        expect(await setAuto()).toEqual(["'origin/HEAD' is unchanged and points to 'main'"]);
        await server.serverStores.refs.setSymbolic("HEAD", "refs/heads/feature");
        expect(await setAuto()).toEqual([
          "'origin/HEAD' has changed from 'main' and now points to 'feature'",
        ]);
      });
    });
  },
);
